// DX19: error taxonomy. Every CLI failure is sorted into a small set of
// categories so the user gets an actionable next step instead of a bare message.
// Pure (no I/O, no axios import): it inspects the error shape generically, so it
// works for axios errors, Node system errors and plain Errors alike.

export type ErrorCategory = "network" | "auth" | "config" | "data" | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  /** A one-line, actionable next step for this category. */
  hint: string;
}

const HINTS: Record<ErrorCategory, string> = {
  network:
    "Network issue: check your connection, VPN and the instance URL (SN_INSTANCE), then retry. `syncro-now-ai check-env` verifies your environment and `syncro-now-ai doctor` tests connectivity.",
  auth: "Authentication issue: verify the integration user and password (re-run `syncro-now-ai login`) and its roles; if you use OAuth, check SN_OAUTH_*. `syncro-now-ai status --debug-credentials` shows which credentials resolve.",
  config:
    "Configuration issue: check `sync.config.js` and `.env` in this project. `syncro-now-ai config show-defaults` prints the built-in defaults and `syncro-now-ai doctor` validates your setup.",
  data: "Not found: the scope, table or record may not exist or you may lack access to it. Verify the name / sys_id and that the scope has been downloaded.",
  unknown:
    "Run again with `--log-level debug` for detail, or `syncro-now-ai doctor` to check configuration and connectivity.",
};

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
