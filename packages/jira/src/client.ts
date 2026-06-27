// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Jira read client (native `fetch`, Node 22+). One client serves both the core
 * CLI and the MCP server. TLS trust honors `NODE_EXTRA_CA_CERTS` automatically
 * (native fetch / undici), so a corporate CA needs no per-call wiring.
 */
import { restApiBase } from "./deployment";
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

/** Translate an HTTP failure into a clear, actionable Error. */
function httpError(status: number, context: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `Jira authentication failed (HTTP ${status}) for ${context}. Check your credentials with 'syncro-now-ai jira-login'.`
    );
  }
  if (status === 404) {
    return new Error(
      `Jira issue not found or not accessible (HTTP 404) for ${context}.`
    );
  }
  return new Error(`Jira request failed (HTTP ${status}) for ${context}.`);
}

async function jiraFetch(
  config: JiraConfig,
  pathAndQuery: string,
  timeoutMs: number
): Promise<{ status: number; data: unknown }> {
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
    return { status: response.status, data };
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

  const { status, data } = await jiraFetch(config, pathAndQuery, timeoutMs);
  if (status < 200 || status > 299) {
    throw httpError(status, issueKey);
  }
  return normalizeIssue(data, config.deployment, config.baseUrl, commentLimit);
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
  const pathAndQuery = `${restApiBase(config.deployment)}/myself`;
  const { status, data } = await jiraFetch(config, pathAndQuery, timeoutMs);
  if (status < 200 || status > 299) {
    throw httpError(status, "the authenticated user (/myself)");
  }
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return (
    (typeof record.displayName === "string" && record.displayName) ||
    (typeof record.name === "string" && record.name) ||
    (typeof record.emailAddress === "string" && record.emailAddress) ||
    "authenticated user"
  );
}
