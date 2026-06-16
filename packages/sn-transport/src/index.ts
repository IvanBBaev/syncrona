/**
 * @syncrona/sn-transport — shared ServiceNow transport policy.
 *
 * The Syncrona project ships two independent ServiceNow HTTP clients: the core
 * CLI client (`packages/core/src/snClient.ts`, built on axios) and the MCP
 * server client (`packages/mcp-server/src/servicenowCore.ts`, built on native
 * fetch). The clients differ by design (CLI vs. long-lived MCP runtime), but
 * they MUST agree on two transport policies:
 *
 *  1. Scoped API prefix resolution — which `api/<prefix>/…` namespaces to try,
 *     in what order, including the `SYNCRONA_SCOPED_API_PREFIXES` env override.
 *  2. Which HTTP status codes are worth retrying.
 *
 * Those policies were previously copy-pasted in both clients and were the most
 * likely to silently drift. This package is the single source of truth for
 * them. It is intentionally pure (no I/O, no node globals): callers read the
 * environment and pass the raw value in, and each client keeps its own runtime
 * cache of the last successful prefix.
 */

/** Default scoped API namespaces tried when no override is configured. */
export const DEFAULT_SCOPED_API_PREFIXES = ["x_nuvo_sinc", "x_nuvo_sync"];

/** Environment variable used to override the scoped API prefixes. */
export const SCOPED_API_PREFIXES_ENV = "SYNCRONA_SCOPED_API_PREFIXES";

/**
 * Normalize a single scoped prefix candidate, dropping any character that is
 * not safe to embed in an `api/<prefix>/…` path.
 */
export function sanitizeScopedPrefix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Parse the configured scoped API prefixes from a raw environment value.
 *
 * The caller is responsible for reading and cleaning the environment value
 * (the core CLI and the MCP server clean it slightly differently). An empty or
 * fully-invalid value falls back to {@link DEFAULT_SCOPED_API_PREFIXES}. The
 * result is de-duplicated while preserving order.
 */
export function parseConfiguredScopedApiPrefixes(rawEnvValue: string): string[] {
  const parsed = rawEnvValue
    .split(",")
    .map((item) => sanitizeScopedPrefix(item))
    .filter((item) => item.length > 0);

  const candidates = parsed.length > 0 ? parsed : DEFAULT_SCOPED_API_PREFIXES;
  return [...new Set(candidates)];
}

/**
 * Produce the ordered list of scoped API prefixes to attempt: preferred (or
 * last-successful) prefixes first, then the configured prefixes, with
 * duplicates removed while preserving order. Preferred entries are sanitized so
 * callers can pass through cached/raw values safely.
 */
export function orderScopedApiPrefixes(
  configured: string[],
  preferred: string[] = []
): string[] {
  const normalizedPreferred = preferred
    .map((item) => sanitizeScopedPrefix(item))
    .filter((item) => item.length > 0);

  return [...new Set([...normalizedPreferred, ...configured])];
}

/** HTTP status codes considered transient/retryable for ServiceNow requests. */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [
  408, 425, 429, 500, 502, 503, 504,
];

const retryableStatusSet = new Set<number>(RETRYABLE_HTTP_STATUSES);

/** Whether a response with the given HTTP status code should be retried. */
export function shouldRetryStatus(status: number): boolean {
  return retryableStatusSet.has(status);
}

/**
 * Maximum sustained request rate against a ServiceNow instance. The core CLI
 * enforces this via axios-rate-limit; the MCP server spaces requests by
 * 1000 / MAX_REQUESTS_PER_SECOND ms. Keep the two clients in agreement.
 */
export const MAX_REQUESTS_PER_SECOND = 20;

/**
 * HTTP status codes that mean "the scoped Syncrona endpoint is not available
 * on this instance" (custom scope not installed, blocked by ACL, or the
 * namespace simply does not exist). Both clients use this to decide when to
 * try the next scoped prefix or fall back to the standard Table API.
 */
export const ENDPOINT_NOT_FOUND_STATUSES: readonly number[] = [400, 403, 404];

const endpointNotFoundStatusSet = new Set<number>(ENDPOINT_NOT_FOUND_STATUSES);

/** Whether the given HTTP status marks the scoped endpoint as unavailable. */
export function isEndpointNotFoundStatus(status: number): boolean {
  return endpointNotFoundStatusSet.has(status);
}

// Shared OAuth 2.0 token manager (IO-free; HTTP injected). Used by both clients.
export * from "./oauth";
