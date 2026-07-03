// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Jira read client (native `fetch`, Node 22+). One client serves both the core
 * CLI and the MCP server. TLS trust honors `NODE_EXTRA_CA_CERTS` automatically
 * (native fetch / undici), so a corporate CA needs no per-call wiring.
 */
import { restApiBase } from "./deployment";
import { jiraHttpError } from "./errors";
import { CLOUD_MISSING_EMAIL_MESSAGE } from "./messages";
import { normalizeIssue } from "./normalize";
import type { GetIssueOptions, JiraConfig, JiraIssue } from "./types";

/** Issue fields requested on every lookup (rich context). */
const ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "components",
  "subtasks",
  "issuelinks",
  "comment",
  "parent",
  "fixVersions",
  "created",
  "updated",
].join(",");

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_COMMENT_LIMIT = 5;
/** One automatic retry on HTTP 429, honoring `Retry-After` up to this cap. */
const MAX_RETRIES = 1;
const MAX_RETRY_WAIT_MS = 5000;
/**
 * Backoff when a 429 carries no usable `Retry-After` (proxies strip it). An
 * immediate re-request against a throttling server would almost certainly 429
 * again, wasting the one retry exactly when it is needed.
 */
const DEFAULT_RETRY_WAIT_MS = 1000;

/** Build the deployment-specific Authorization header value. */
export function buildAuthHeader(config: JiraConfig): string {
  if (config.deployment === "cloud") {
    // Cloud: HTTP Basic with the account email as username and the API token as
    // password. Do not trim the token — surrounding whitespace can be significant.
    const email = (config.email || "").trim();
    const raw = `${email}:${config.token}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }
  // Server/Data Center: Bearer personal access token.
  return `Bearer ${config.token}`;
}

function baseHeaders(config: JiraConfig): Record<string, string> {
  return {
    Authorization: buildAuthHeader(config),
    Accept: "application/json",
  };
}

function siteRoot(config: JiraConfig): string {
  return config.baseUrl.replace(/\/$/, "");
}

/**
 * Fail early on a config that is guaranteed to be unauthenticatable, so the user
 * gets an actionable message instead of a raw 401 misdiagnosed as bad credentials
 * (finding #35). Jira Cloud Basic auth is `email:api-token`; with no email the
 * header is `base64(":token")`, which Atlassian always rejects with 401. Server/DC
 * uses a Bearer token and needs no email, so this only guards Cloud.
 */
function assertUsableConfig(config: JiraConfig): void {
  if (config.deployment === "cloud" && !(config.email || "").trim()) {
    throw new Error(CLOUD_MISSING_EMAIL_MESSAGE);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header (delta-seconds form only) into a bounded wait in
 * milliseconds. Returns null when absent/unparseable so the caller can decide on
 * a default. The HTTP-date form is intentionally not honored — Jira sends seconds.
 */
function retryAfterMs(headers: unknown): number | null {
  const get =
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get.bind(headers as Headers)
      : null;
  if (!get) {
    return null;
  }
  const raw = get("retry-after");
  if (!raw) {
    return null;
  }
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
}

/** A single HTTP attempt's outcome, threaded through to the error mapper. */
type FetchResult = {
  status: number;
  statusText: string;
  url: string;
  data: unknown;
  headers: unknown;
};

/** Single HTTP attempt: returns status, parsed body, and the raw headers. */
async function jiraFetchOnce(
  config: JiraConfig,
  pathAndQuery: string,
  timeoutMs: number
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${siteRoot(config)}${pathAndQuery}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: baseHeaders(config),
      signal: controller.signal,
    });
    let data: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. an HTML error page from a proxy) — keep the raw
        // text so error mapping still has the status to work with.
        data = text;
      }
    }
    return {
      status: response.status,
      statusText: typeof response.statusText === "string" ? response.statusText : "",
      url,
      data,
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Jira request timed out after ${timeoutMs}ms: ${url}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Jira request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with one automatic retry on HTTP 429 (rate limit). Busy Cloud sites throttle
 * read traffic; honoring `Retry-After` once turns a transient 429 into a successful
 * read instead of a hard failure. All other statuses are returned to the caller as-is.
 */
async function jiraFetch(
  config: JiraConfig,
  pathAndQuery: string,
  timeoutMs: number
): Promise<{ status: number; statusText: string; url: string; data: unknown }> {
  let attempt = 0;
  for (;;) {
    const { status, statusText, url, data, headers } = await jiraFetchOnce(
      config,
      pathAndQuery,
      timeoutMs
    );
    if (status !== 429 || attempt >= MAX_RETRIES) {
      return { status, statusText, url, data };
    }
    attempt += 1;
    const wait = retryAfterMs(headers);
    await sleep(wait ?? DEFAULT_RETRY_WAIT_MS);
  }
}

/**
 * Fetch and normalize a single issue by key. Throws a clear Error on auth
 * failure (401/403), missing/forbidden issue (404), other non-2xx, or timeout.
 */
export async function getIssue(
  config: JiraConfig,
  key: string,
  opts: GetIssueOptions = {}
): Promise<JiraIssue> {
  const issueKey = key.trim().toUpperCase();
  if (!issueKey) {
    throw new Error("A Jira issue key is required.");
  }
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const commentLimit =
    typeof opts.comments === "number" && opts.comments >= 0
      ? Math.floor(opts.comments)
      : DEFAULT_COMMENT_LIMIT;

  const params = new URLSearchParams();
  params.set("fields", ISSUE_FIELDS);
  const pathAndQuery = `${restApiBase(config.deployment)}/issue/${encodeURIComponent(
    issueKey
  )}?${params.toString()}`;

  assertUsableConfig(config);
  const { status, statusText, url, data } = await jiraFetch(
    config,
    pathAndQuery,
    timeoutMs
  );
  if (status < 200 || status > 299) {
    throw jiraHttpError({ status, statusText, url, body: data, context: issueKey });
  }
  // A 2xx that is not a Jira issue object (e.g. an HTML SSO/login page or a proxy
  // splash returned with 200, or a JSON body with no `key`) would otherwise yield
  // an issue with an empty key and silently-blank fields. Fail loudly instead.
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!record || String(record.key ?? "").trim().length === 0) {
    throw new Error(
      `Jira returned an unexpected response (HTTP ${status}) for ${issueKey} with no issue data — check that the base URL points at the Jira REST API and that you are authenticated.`
    );
  }

  // The issue payload embeds only the FIRST page of comments (oldest-first,
  // capped at ~100). On a busy issue the newest comments — the ones a reader
  // actually wants — are on a later page and would be silently dropped, and
  // "most-recent N" would select from the oldest page (finding #34). When the
  // embedded page is truncated, fetch the newest `commentLimit` comments from the
  // dedicated endpoint (`orderBy=-created`) and splice them in before normalizing.
  if (commentLimit > 0 && isCommentPageTruncated(record.fields)) {
    const recent = await fetchRecentComments(config, issueKey, commentLimit, timeoutMs);
    if (recent) {
      record.fields = mergeComments(record.fields, recent);
    }
  }

  return normalizeIssue(record, config.deployment, config.baseUrl, commentLimit);
}

/** True when the embedded comment page does not contain every comment. */
function isCommentPageTruncated(fields: unknown): boolean {
  const container =
    fields && typeof fields === "object"
      ? ((fields as Record<string, unknown>).comment as Record<string, unknown> | undefined)
      : undefined;
  if (!container || typeof container !== "object") {
    return false;
  }
  const comments = Array.isArray(container.comments) ? container.comments : [];
  const total = typeof container.total === "number" ? container.total : comments.length;
  return total > comments.length;
}

/**
 * Fetch the most-recent `limit` comments via `/issue/{key}/comment` ordered
 * newest-first, then return them oldest-first so `normalizeIssue`'s
 * chronological `slice(-limit)` keeps them intact. Returns null on any failure
 * so the caller falls back to the embedded (possibly truncated) page rather than
 * failing the whole issue fetch over a comments-only problem.
 */
async function fetchRecentComments(
  config: JiraConfig,
  issueKey: string,
  limit: number,
  timeoutMs: number
): Promise<unknown[] | null> {
  const params = new URLSearchParams();
  params.set("orderBy", "-created");
  params.set("maxResults", String(limit));
  const pathAndQuery = `${restApiBase(config.deployment)}/issue/${encodeURIComponent(
    issueKey
  )}/comment?${params.toString()}`;
  try {
    const { status, data } = await jiraFetch(config, pathAndQuery, timeoutMs);
    if (status < 200 || status > 299 || !data || typeof data !== "object") {
      return null;
    }
    const container = data as Record<string, unknown>;
    if (!Array.isArray(container.comments)) {
      return null;
    }
    // `-created` yields newest-first; reverse to oldest-first so downstream
    // chronological handling (slice(-limit)) is preserved.
    return [...container.comments].reverse();
  } catch {
    return null;
  }
}

/** Return a shallow clone of `fields` with its `comment.comments` replaced. */
function mergeComments(fields: unknown, comments: unknown[]): Record<string, unknown> {
  const base =
    fields && typeof fields === "object" ? { ...(fields as Record<string, unknown>) } : {};
  const container =
    base.comment && typeof base.comment === "object"
      ? { ...(base.comment as Record<string, unknown>) }
      : {};
  container.comments = comments;
  container.total = comments.length;
  base.comment = container;
  return base;
}

/**
 * Verify credentials by calling `/myself`. Returns the authenticated user's
 * display name on success; throws a clear Error on failure. Used by the login
 * connection test.
 */
export async function verifyAuth(
  config: JiraConfig,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  assertUsableConfig(config);
  const pathAndQuery = `${restApiBase(config.deployment)}/myself`;
  const { status, statusText, url, data } = await jiraFetch(
    config,
    pathAndQuery,
    timeoutMs
  );
  if (status < 200 || status > 299) {
    throw jiraHttpError({
      status,
      statusText,
      url,
      body: data,
      context: "the authenticated user (/myself)",
    });
  }
  // A 2xx that is not a JSON user object — an HTML SSO/login page or proxy splash
  // returned with 200 — must NOT be accepted as a successful login: doing so would
  // persist invalid credentials. Mirror getIssue's no-identity guard and require a
  // real /myself identity field (accountId/displayName/name/emailAddress).
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const identity =
    record &&
    ((typeof record.displayName === "string" && record.displayName) ||
      (typeof record.name === "string" && record.name) ||
      (typeof record.emailAddress === "string" && record.emailAddress) ||
      (typeof record.accountId === "string" && record.accountId && "authenticated user"));
  if (!identity) {
    throw new Error(
      `Jira returned an unexpected response (HTTP ${status}) for /myself with no user identity — check that the base URL points at the Jira REST API and that you are authenticated.`
    );
  }
  return identity;
}
