// SPDX-License-Identifier: GPL-3.0-or-later
// DX19: error taxonomy. Every CLI failure is sorted into a small set of
// categories so the user gets an actionable next step instead of a bare message.
// Pure (no I/O, no axios import): it inspects the error shape generically, so it
// works for axios errors, Node system errors and plain Errors alike.

// inquirer throws an ExitPromptError when the user aborts a prompt (Ctrl-C).
// That is a cancellation, not a command failure — callers should exit quietly
// without an error banner. (DEP1: under inquirer 8 Ctrl-C killed the process
// outright, so only the wizard needed this; inquirer 14 rejects instead, which
// routes every prompt abort through the async error sinks.)
export function isPromptAbort(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  return e.name === "ExitPromptError" || /force closed the prompt/i.test(e.message);
}

export type ErrorCategory = "network" | "auth" | "config" | "data" | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  /** A one-line, actionable next step for this category. */
  hint: string;
}

const HINTS: Record<ErrorCategory, string> = {
  network:
    "Network issue: check your connection, VPN and the instance URL (SN_INSTANCE), then retry. `syncrona check-env` verifies your environment and `syncrona doctor` tests connectivity.",
  auth: "Authentication issue: verify the integration user and password (re-run `syncrona login`) and its roles; if you use OAuth, check SN_OAUTH_*. `syncrona status --debug-credentials` shows which credentials resolve.",
  config:
    "Configuration issue: check `sync.config.js` and `.env` in this project. `syncrona config show-defaults` prints the built-in defaults and `syncrona doctor` validates your setup.",
  data: "Not found: the scope, table or record may not exist or you may lack access to it. Verify the name / sys_id and that the scope has been downloaded.",
  unknown:
    "Run again with `--log-level debug` for detail, or `syncrona doctor` to check configuration and connectivity.",
};

/**
 * WP-5 (R6): the role the CI/CD REST API (`api/sn_cicd/*`) checks. A 403 from
 * those endpoints almost never means bad credentials — the same user can read
 * the Table API fine — it means this role is missing, so the generic auth hint
 * ("re-run login") would send the user the wrong way.
 */
export const CICD_ROLE = "sn_cicd.sys_ci_automation";

const CICD_ROLE_HINT = `Access denied by the CI/CD REST API: the user needs the \`${CICD_ROLE}\` role (admin also passes). Grant it to the integration user in ServiceNow, then retry.`;

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

function statusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null | undefined)
    ?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

function requestUrlOf(error: unknown): string {
  const url = (error as { config?: { url?: unknown } } | null | undefined)?.config?.url;
  return typeof url === "string" ? url : "";
}

// A 403 whose request (or message) names sn_cicd: the missing-role case above.
function isCicdAccessDenied(error: unknown): boolean {
  if (statusOf(error) !== 403) {
    return false;
  }
  return /sn_cicd/i.test(requestUrlOf(error)) || /sn_cicd/i.test(messageOf(error));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/**
 * Classify an error into a category with an actionable hint. Ordering matters:
 * a transport-level code or an HTTP status is more reliable than message text,
 * so those are checked first; message keywords are the last resort before
 * "unknown".
 */
export function classifyError(error: unknown): ClassifiedError {
  if (isCicdAccessDenied(error)) {
    return { category: "auth", hint: CICD_ROLE_HINT };
  }
  const category = categorize(error);
  return { category, hint: HINTS[category] };
}

function categorize(error: unknown): ErrorCategory {
  if (NETWORK_CODES.has(codeOf(error))) {
    return "network";
  }

  const status = statusOf(error);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "data";
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return "network";
  }

  const msg = messageOf(error).toLowerCase();
  if (/credential|unauthor|forbidden|oauth|\blogin\b|password|insufficient role/.test(msg)) {
    return "auth";
  }
  if (/sync\.config|config file|configuration|\.env\b|missing.*config/.test(msg)) {
    return "config";
  }
  if (/enoent|no such file/.test(msg)) {
    return "config";
  }
  if (/not found|does not exist|no records|404/.test(msg)) {
    return "data";
  }
  if (/timeout|timed out|network|socket|econn|getaddrinfo|dns|tls|certificate/.test(msg)) {
    return "network";
  }
  return "unknown";
}
