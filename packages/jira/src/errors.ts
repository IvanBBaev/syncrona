// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Typed error for Jira HTTP failures.
 *
 * The HTTP layer throws a {@link JiraHttpError} instead of a bare `Error` so
 * callers (the core CLI's `jira` command, the MCP `jira_get_issue` handler) can
 * branch on `status`/`kind` structurally rather than regex-matching the client's
 * own message strings — which silently drifts the moment a message is reworded.
 * The human-readable `message` is still tailored per status (see
 * {@link jiraHttpError}) so `console`/`logger` output stays actionable; the
 * structured fields are the machine-readable contract on top of it.
 */

/**
 * Coarse failure category, derived once from the HTTP status. Callers key their
 * hints/UX off this instead of re-deriving it from the status number:
 * - `unauthorized` (401) — bad or absent credentials; re-login is the fix.
 * - `forbidden` (403) — authenticated, but the account/token lacks permission;
 *   re-login does NOT help — the fix is project permissions or a wider-scope token.
 * - `not-found` (404) — issue missing or not visible to this account.
 * - `rate-limited` (429) — throttled; the client already retried once.
 * - `server` (5xx) — Jira-side error.
 * - `unknown` — any other non-2xx.
 */
export type JiraHttpErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "server"
  | "unknown";

/** Max characters of the response body preserved on the error for diagnostics. */
const BODY_SNIPPET_MAX = 500;

function kindForStatus(status: number): JiraHttpErrorKind {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500 && status <= 599) {
    return "server";
  }
  return "unknown";
}

/** Reduce an arbitrary parsed/raw body to a short, single-line diagnostic snippet. */
function bodySnippet(body: unknown): string | undefined {
  if (body == null) {
    return undefined;
  }
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > BODY_SNIPPET_MAX
    ? `${collapsed.slice(0, BODY_SNIPPET_MAX)}…`
    : collapsed;
}

/** A Jira HTTP request that returned a non-2xx status. */
export class JiraHttpError extends Error {
  /** HTTP status code, e.g. 403. */
  readonly status: number;
  /** HTTP status text when the runtime provided one, e.g. "Forbidden". */
  readonly statusText: string;
  /** The request URL that failed (query string included). */
  readonly url: string;
  /** Coarse failure category derived from {@link status}. */
  readonly kind: JiraHttpErrorKind;
  /** Short, whitespace-collapsed snippet of the response body (for diagnostics). */
  readonly body?: string;

  constructor(args: {
    status: number;
    statusText?: string;
    url: string;
    body?: unknown;
    message: string;
  }) {
    super(args.message);
    this.name = "JiraHttpError";
    this.status = args.status;
    this.statusText = (args.statusText || "").trim();
    this.url = args.url;
    this.kind = kindForStatus(args.status);
    const snippet = bodySnippet(args.body);
    if (snippet) {
      this.body = snippet;
    }
    // Restore the prototype chain so `instanceof JiraHttpError` holds even when
    // this file is transpiled to ES5-target CommonJS (ts-jest default).
    Object.setPrototypeOf(this, JiraHttpError.prototype);
  }
}

/** Type guard: is this value a {@link JiraHttpError}? */
export function isJiraHttpError(value: unknown): value is JiraHttpError {
  return value instanceof JiraHttpError;
}

/**
 * Build a {@link JiraHttpError} with a clear, actionable, status-specific message.
 * `context` describes the target (an issue key, or "/myself"). This is the single
 * place where 401 and 403 diverge (finding #69): 401 tells the user to re-login,
 * 403 tells them re-login will not help and to check permissions / token scope.
 */
export function jiraHttpError(args: {
  status: number;
  statusText?: string;
  url: string;
  body?: unknown;
  context: string;
}): JiraHttpError {
  const { status, context } = args;
  let message: string;
  if (status === 401) {
    message =
      `Jira authentication failed (HTTP 401) for ${context}: credentials were rejected. ` +
      `Check your credentials with 'syncrona jira-login', and for Jira Cloud verify JIRA_EMAIL matches the API token.`;
  } else if (status === 403) {
    message =
      `Jira access forbidden (HTTP 403) for ${context}: you are authenticated but not permitted. ` +
      `Re-login will not help — check the project's permission scheme and that your API token has the required scope.`;
  } else if (status === 404) {
    message = `Jira issue not found or not accessible (HTTP 404) for ${context}.`;
  } else if (status === 429) {
    message = `Jira rate limit exceeded (HTTP 429) for ${context}. Retry after a short wait.`;
  } else if (status >= 500 && status <= 599) {
    message = `Jira server error (HTTP ${status}) for ${context}. This is a Jira-side failure; retry later.`;
  } else {
    message = `Jira request failed (HTTP ${status}) for ${context}.`;
  }
  return new JiraHttpError({
    status,
    statusText: args.statusText,
    url: args.url,
    body: args.body,
    message,
  });
}
