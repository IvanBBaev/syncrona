// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mirror transport policy (WP-M0) — the decision rules the full-instance mirror
 * needs before it may touch the network, kept here rather than in the mirror
 * package so the CLI, the MCP server and the mirror cannot drift on them.
 *
 * Everything in this module is pure compute: it takes an HTTP status, a body
 * and (for retries) an injected clock/RNG, and returns a decision. No sockets,
 * no timers, no environment reads — the caller owns all of that.
 *
 * The rules are not invented here; they are what a live ServiceNow PDI actually
 * did, recorded in `docs/design/mirror-analyses.md` §7 (measurements M1, M2 and
 * the reachability probe) and frozen as deltas D4/D5/D6 in
 * `docs/design/mirror-architecture.md` §14. The tests carry those measurements
 * as fixtures so a future "cleanup" that reverts to status-code-only
 * classification fails loudly instead of quietly mis-routing errors.
 */

/**
 * How a failed request should be treated by the mirror's failure taxonomy.
 *
 * `transient` is the only class that may be retried; `auth` aborts the run
 * (credentials that are wrong now are wrong for every subsequent request too);
 * `acl` and `not-found` are per-record outcomes the coverage layer records as
 * honest gaps; `fatal` stops the current unit of work without retrying.
 */
export type SnErrorClass = "transient" | "auth" | "acl" | "not-found" | "fatal";

/** Normalized view of a ServiceNow error response (architecture doc §4.5). */
export interface SnErrorEnvelope {
  /** The HTTP status the response arrived with. */
  httpStatus: number;
  /** `error.message` from the envelope, or `HTTP <status>` when none was sent. */
  message: string;
  /** `error.detail` from the envelope. Measured as nullable on a live PDI (M1). */
  detail: string | null;
  /** The routing decision, derived from the envelope first and status second (D5). */
  classified: SnErrorClass;
}

/**
 * Result of the pre-flight reachability probe (architecture doc §4.5, D4).
 *
 * The three failure states are deliberately distinct because the operator
 * action differs for each: fix credentials, fix the network/URL, or click
 * "wake" on developer.servicenow.com. Collapsing them into one "cannot reach
 * instance" message is exactly what the tri-state exists to prevent (§10).
 */
export interface ReachabilityStatus {
  state: "ok" | "auth-failed" | "unreachable" | "hibernating";
  detail: string;
}

/** What the caller observed while probing the instance. */
export interface ReachabilityProbe {
  /**
   * Set when no HTTP response arrived at all — DNS failure, refused TCP
   * connection, TLS handshake failure, timeout. Presence alone decides
   * `unreachable`; the code/message only shapes the diagnostic text.
   */
  networkError?: { code?: string; message?: string } | null;
  /** HTTP status of the probe response, when one arrived. */
  status?: number;
  /** `content-type` response header, as received (matched case-insensitively). */
  contentType?: string;
  /** Response body: already-parsed JSON, or the raw text. */
  body?: unknown;
}

/**
 * Retryable statuses, widened from the v1 client policy.
 *
 * `index.ts` exports `RETRYABLE_HTTP_STATUSES` = [408, 425, 429, 500, 502, 503,
 * 504] — the enumerated set the two v1 clients meet in practice. The mirror
 * spec (§5.1) says "408/425/429/5xx", i.e. *every* 5xx, because a full-instance
 * sweep sits behind gateways and load balancers the v1 command paths never
 * touch (521, 522 and 525 all show up in front of cloud instances). This module
 * re-states the rule instead of importing it: `index.ts` re-exports this file,
 * so importing back from it would be a cycle and the repo's dependency-cruiser
 * `no-circular` rule forbids that. A test pins the two definitions in agreement
 * so the widening stays a superset rather than a divergence.
 */
const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * Envelope phrases that mean "your credentials did not work".
 *
 * ServiceNow sends these with HTTP 401 normally, but M1 measured the same
 * envelope arriving on a 400 as well, and a reverse proxy in front of an
 * instance can rewrite the status entirely. The words are the stable signal;
 * the status is not. That is what D5 says.
 */
const AUTH_MARKERS: readonly RegExp[] = [
  /user not authenticated/i,
  /required to provide auth information/i,
  /invalid[_ ]token/i,
  /expired token/i,
];

/**
 * Envelope phrases that mean "authenticated, but this row or table is not yours".
 *
 * An ACL denial is a coverage fact (the mirror records the gap and moves on),
 * never a retry and never an abort — so it must not be confused with `auth`.
 * `\bacl\b` is word-bounded on purpose: a bare substring match would fire on
 * ordinary words such as "oracle" or "tentacle" appearing in a record's own
 * error text.
 */
const ACL_MARKERS: readonly RegExp[] = [
  /insufficient rights/i,
  /\bacl\b/i,
  /not authorized/i,
  /operation against file/i,
];

/**
 * Markers that identify a hibernating-instance HTML page (D4).
 *
 * `hibernat` is a stem, not a typo: the real page uses "hibernating",
 * "hibernate" and "Hibernation" in different places across PDI generations, and
 * matching the stem survives all three. The second marker catches the wake-up
 * call to action on pages that word the title differently.
 */
export const HIBERNATION_MARKERS: readonly string[] = ["hibernat", "wake your instance"];

/** Longest run of instance-supplied text echoed into a diagnostic string. */
const MAX_ECHOED_DETAIL = 200;

/**
 * Characters that must never survive into a one-line diagnostic: control
 * characters (`Cc`, which covers NUL, CR, LF and the ANSI escape introducer)
 * plus the Unicode line and paragraph separators (`Zl`, `Zp`).
 */
const UNSAFE_ECHO_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** Base of the exponential backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 1_000;

/** Ceiling of the computed backoff before jitter is applied, in milliseconds. */
export const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Ceiling applied to a server-supplied `Retry-After`, in milliseconds.
 *
 * `Retry-After` wins over the computed backoff (§5.1), but "wins" cannot mean
 * "unbounded": a misconfigured proxy answering `Retry-After: 86400` would park
 * a mirror sweep for a day inside a single sleep, past any run deadline the
 * caller set. Five minutes is longer than any throttle a healthy instance asks
 * for and short enough that the caller stays in control.
 */
export const RETRY_AFTER_MAX_MS = 300_000;

/** Table API base path — keyset paging is issued against `<base>/<table>`. */
export const TABLE_API_BASE = "/api/now/table";

/**
 * The only shape a sys_id may have (architecture doc §11, INV-6).
 *
 * Lower-case hex, exactly 32 characters. Anything else is either a caller bug
 * or an injection attempt, and both must be rejected before the value reaches a
 * filesystem path or an encoded query.
 */
export const SYS_ID_RE = /^[0-9a-f]{32}$/;

/** Table names ServiceNow can actually have — scoped tables are `x_vendor_app_thing`. */
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Column names, including dot-walked references such as `sys_scope.name`. */
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** Parsed `error` object of a ServiceNow failure envelope. */
interface RawEnvelope {
  message: string;
  detail: string | null;
}

/**
 * Pull `{ error: { message, detail } }` out of a response body.
 *
 * The body arrives as either raw text (fetch) or an already-parsed object
 * (axios), so both are accepted. The measured envelope also carries a sibling
 * `status: "failure"`, but that is deliberately *not* required: some ServiceNow
 * endpoints omit it, and demanding it would silently downgrade a real auth
 * failure to `fatal`. Returns null when there is no envelope to read, which is
 * the signal to fall back to the status code.
 */
const readEnvelope = (body: unknown): RawEnvelope | null => {
  let payload: unknown = body;
  if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch {
      // Not JSON — an HTML error page, or a proxy's plain-text body.
      return null;
    }
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  const detail = (error as { detail?: unknown }).detail;
  return {
    message: typeof message === "string" ? message : "",
    // M1: `detail` is genuinely null on a live instance, so a non-string is
    // normalized to null rather than stringified into the literal "null".
    detail: typeof detail === "string" ? detail : null,
  };
};

/**
 * Classify from the envelope's wording, or return undefined to defer to status.
 *
 * Only `auth` and `acl` are derivable from text. Retryability is a transport
 * property, and "not found" needs the status; guessing either from prose would
 * be worse than the status code we already have.
 */
const classifyEnvelopeText = (message: string, detail: string | null): SnErrorClass | undefined => {
  const text = `${message}\n${detail ?? ""}`;
  if (AUTH_MARKERS.some((marker) => marker.test(text))) {
    return "auth";
  }
  if (ACL_MARKERS.some((marker) => marker.test(text))) {
    return "acl";
  }
  return undefined;
};

/** Status-code fallback, used when the response carried no usable envelope. */
const classifyStatus = (httpStatus: number): SnErrorClass => {
  if (isTransientStatus(httpStatus)) {
    return "transient";
  }
  if (httpStatus === 401) {
    return "auth";
  }
  if (httpStatus === 403) {
    return "acl";
  }
  if (httpStatus === 404) {
    return "not-found";
  }
  return "fatal";
};

/**
 * Flatten instance-supplied text for safe inclusion in a one-line diagnostic.
 *
 * The message comes from the far side of the network. Newlines, ANSI escapes
 * and paragraph separators in it would let a record's own data forge extra log
 * lines, so those characters collapse to spaces and the result is bounded.
 */
const oneLine = (text: string): string => {
  const flattened = text.replace(UNSAFE_ECHO_CHARS, " ").trim();
  return flattened.length > MAX_ECHOED_DETAIL
    ? `${flattened.slice(0, MAX_ECHOED_DETAIL)}...`
    : flattened;
};

/** Body text for marker scanning — an object body is parsed JSON and never HTML. */
const bodyText = (body: unknown): string => (typeof body === "string" ? body : "");

/**
 * Whether a probe response is an HTML page rather than the JSON we asked for.
 *
 * Both signals are checked because either can be missing: a hibernating PDI
 * sends `Content-Type: text/html`, while some captive portals send HTML under a
 * generic or absent content type.
 */
const looksLikeHtml = (contentType: string | undefined, body: unknown): boolean =>
  (contentType ?? "").toLowerCase().includes("text/html") ||
  bodyText(body).trimStart().startsWith("<");

/** Whether an HTML body is the ServiceNow hibernation page. */
const hasHibernationMarker = (text: string): boolean => {
  const haystack = text.toLowerCase();
  return HIBERNATION_MARKERS.some((marker) => haystack.includes(marker));
};

/**
 * Classify a failed ServiceNow response (architecture doc §5.1, D5).
 *
 * The envelope decides when it says something decisive; the status code is the
 * fallback, not the primary signal. That ordering is the whole point of D5:
 * M1 measured the same `{"error":{"message","detail"},"status":"failure"}`
 * envelope on both a 400 and a 401, so a status-only classifier would route an
 * unauthenticated request to `fatal` and abort a sweep with a misleading
 * reason.
 *
 * Note the consequence at the edges: a 5xx whose envelope says "insufficient
 * rights" classifies as `acl`, not `transient`. That is intended — retrying a
 * permission denial burns the retry budget and still ends in a denial.
 *
 * @param httpStatus Status of the response.
 * @param body Response body: raw text or already-parsed JSON.
 */
export function classifyError(httpStatus: number, body: unknown): SnErrorEnvelope {
  const envelope = readEnvelope(body);
  if (!envelope) {
    return {
      httpStatus,
      // No envelope means no instance-authored text worth echoing — the body is
      // an HTML page or a proxy blurb, and `diagnoseReachability` is the
      // function that inspects those.
      message: `HTTP ${httpStatus}`,
      detail: null,
      classified: classifyStatus(httpStatus),
    };
  }
  const fromText = classifyEnvelopeText(envelope.message, envelope.detail);
  return {
    httpStatus,
    message: envelope.message,
    detail: envelope.detail,
    classified: fromText ?? classifyStatus(httpStatus),
  };
}

/**
 * Diagnose why an instance is (or is not) usable: the tri-state plus ok (D4).
 *
 * Evaluation order is load-bearing:
 *
 *  1. A transport-level failure means nothing else can be true.
 *  2. An HTML body is checked *before* the status, because a hibernating PDI
 *     answers **HTTP 200** with the hibernation page. Checking status first
 *     would report a hibernating instance as healthy.
 *  3. Auth is decided through `classifyError`, so a 400-with-auth-envelope
 *     (M1) lands on `auth-failed` here too instead of reading as reachable.
 *  4. A 5xx means the edge answered but the platform did not — unreachable for
 *     the purpose of starting a sweep.
 *  5. Anything else is reachable. A 403 on the probe target is an ACL fact
 *     about that target, not a reachability problem.
 *
 * The detail strings open with the exact wording §10 requires ("auth failed",
 * "instance unreachable", "instance hibernating (wake it at
 * developer.servicenow.com)") so a caller can surface `detail` verbatim.
 */
export function diagnoseReachability(probe: ReachabilityProbe): ReachabilityStatus {
  if (probe.networkError) {
    const cause = probe.networkError.code || probe.networkError.message || "no response";
    return { state: "unreachable", detail: `instance unreachable (${oneLine(cause)})` };
  }

  const status = probe.status ?? 0;

  if (looksLikeHtml(probe.contentType, probe.body)) {
    if (hasHibernationMarker(bodyText(probe.body))) {
      return {
        state: "hibernating",
        detail: "instance hibernating (wake it at developer.servicenow.com)",
      };
    }
    return {
      state: "unreachable",
      detail:
        `instance unreachable (HTTP ${status} returned HTML, not JSON — ` +
        `a portal or proxy is answering for the instance)`,
    };
  }

  if (status >= 200 && status < 300) {
    return { state: "ok", detail: `instance reachable (HTTP ${status})` };
  }

  const classified = classifyError(status, probe.body);
  if (classified.classified === "auth") {
    return {
      state: "auth-failed",
      detail: `auth failed (HTTP ${status}: ${oneLine(classified.message)})`,
    };
  }

  if (status >= 500) {
    return {
      state: "unreachable",
      detail: `instance unreachable (HTTP ${status}: ${oneLine(classified.message)})`,
    };
  }

  return { state: "ok", detail: `instance reachable (HTTP ${status})` };
}

/** Injectable clock and RNG so retry delays are deterministic under test. */
export interface RetryDelayOptions {
  /** Defaults to `Math.random`. Must return a value in [0, 1). */
  random?: () => number;
  /** Defaults to `Date.now`. Only consulted for an HTTP-date `Retry-After`. */
  now?: () => number;
}

/**
 * Parse a `Retry-After` header in either RFC 9110 form.
 *
 * Returns milliseconds, or null when there is nothing usable — an absent
 * header, blank text, or a date that does not parse. Null is the signal to fall
 * back to the computed backoff.
 */
const parseRetryAfter = (header: string | null | undefined, now: () => number): number | null => {
  const raw = (header ?? "").trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1_000;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    return null;
  }
  // A date already in the past means "retry now", not "travel backwards".
  return Math.max(0, at - now());
};

/**
 * Compute how long to wait before the next attempt (architecture doc §5.1).
 *
 * Exponential backoff with **full jitter** — the delay is uniform across
 * `[0, min(cap, base * 2^attempt)]`, not `base * 2^attempt` exactly. Full
 * jitter is the variant that actually de-synchronizes a fan-out: a mirror sweep
 * runs many table workers against one instance, and without jitter they all
 * back off in lockstep and re-collide on every wave.
 *
 * `Retry-After` wins when present, bounded by `RETRY_AFTER_MAX_MS`. M2 measured
 * that a default ServiceNow response carries **no** rate-limit headers at all,
 * so this path is defensive (D6): it exists for the instances and proxies that
 * do send one, and the backoff below is what actually runs day to day.
 *
 * @param attempt Zero-based retry index — 0 is the first retry.
 * @param retryAfterHeader Raw `Retry-After` header value, if the response had one.
 */
export function computeRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  options: RetryDelayOptions = {}
): number {
  const fromHeader = parseRetryAfter(retryAfterHeader, options.now ?? Date.now);
  if (fromHeader !== null) {
    return Math.min(fromHeader, RETRY_AFTER_MAX_MS);
  }
  const random = options.random ?? Math.random;
  // A negative, fractional or non-finite attempt is a caller bug; clamp rather
  // than produce a sub-second "backoff" (2^-1) or a NaN that never sleeps.
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // A large attempt makes 2**n overflow to Infinity; Math.min turns that into
  // the cap, so no separate guard on the exponent is needed.
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** safeAttempt);
  return Math.round(random() * ceiling);
}

/** Caller-supplied parts of a keyset page request. */
export interface KeysetQueryOptions {
  /**
   * Columns to request. MUST be explicit and non-empty (§5.1) — an unqualified
   * request returns every column of every row, which for a full-instance sweep
   * is orders of magnitude more bytes than the mirror stores.
   */
  fields: readonly string[];
  /**
   * Extra encoded-query conditions ANDed *before* the cursor, e.g. a watermark
   * such as `sys_updated_on>=2026-01-01`. The caller owns escaping of any value
   * it interpolates here — see `escapeQueryValue` in this package — because a
   * raw `^` inside a value is read by ServiceNow as a condition separator.
   */
  extraQuery?: string;
}

/** A ready-to-issue Table API page request. */
export interface KeysetQuery {
  /** Path under the instance base URL, e.g. `/api/now/table/sys_script`. */
  path: string;
  /** Exact query parameters. Never contains `sysparm_offset`. */
  params: Record<string, string>;
}

/**
 * Build one keyset-paginated Table API request (design doc §6, architecture §5.1).
 *
 * Keyset paging — `sys_id><cursor>` ordered by `sys_id` — is the only paging
 * the mirror may use. Offset paging (`sysparm_offset`) drifts whenever a row is
 * inserted or deleted mid-sweep: the window slides and records are silently
 * skipped or duplicated, which would put a hole in a tree that claims to be
 * complete. M6 verified on a live instance that the keyset walk is strictly
 * increasing with zero overlap. This function therefore has no code path that
 * can emit an offset, and a test asserts the emitted parameter set exactly.
 *
 * The remaining parameters are the measured ones: `sysparm_exclude_reference_link`
 * turns a reference column into a plain sys_id string instead of a
 * `{value, link}` object (M7), `sysparm_display_value=false` keeps the stored
 * value rather than its localized label, and
 * `sysparm_suppress_pagination_header` drops the `Link` header the mirror does
 * not use.
 *
 * @param table Table to page through.
 * @param lastSysId Cursor — the last sys_id of the previous page, or null to start.
 * @param pageSize Rows per page (`sysparm_limit`).
 * @throws Error when the table, cursor, page size or a field name is malformed.
 */
export function buildKeysetQuery(
  table: string,
  lastSysId: string | null,
  pageSize: number,
  options: KeysetQueryOptions
): KeysetQuery {
  if (!TABLE_NAME_RE.test(table)) {
    // The table name lands in the URL path, so a `/` or `..` in it would
    // redirect the request to a different endpoint entirely.
    throw new Error(`Refusing to page: unsafe table name ${JSON.stringify(table)}.`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`Refusing to page: page size must be a positive integer, got ${pageSize}.`);
  }
  if (lastSysId !== null && lastSysId !== undefined && !SYS_ID_RE.test(lastSysId)) {
    // INV-6. Rejecting rather than escaping is deliberate: a cursor that is not
    // a sys_id is a bug in the pager, and a `^` inside it would smuggle extra
    // conditions past the scope filter the caller assembled in `extraQuery`.
    throw new Error(`Refusing to page: cursor ${JSON.stringify(lastSysId)} is not a sys_id.`);
  }

  const fields = options.fields.map((field) => field.trim()).filter((field) => field.length > 0);
  const invalid = fields.find((field) => !FIELD_NAME_RE.test(field));
  if (invalid !== undefined) {
    // A field containing `,` would silently widen the projection.
    throw new Error(`Refusing to page: unsafe field name ${JSON.stringify(invalid)}.`);
  }
  if (fields.length === 0) {
    throw new Error(`Refusing to page: table ${JSON.stringify(table)} was asked for no fields.`);
  }
  // The next cursor is read out of the last row of each page, so a projection
  // without sys_id would fetch exactly one page and then stall.
  const projection = fields.includes("sys_id") ? fields : ["sys_id", ...fields];

  const conditions: string[] = [];
  const extra = (options.extraQuery ?? "").trim();
  if (extra) {
    conditions.push(extra);
  }
  if (lastSysId) {
    conditions.push(`sys_id>${lastSysId}`);
  }
  // ORDERBY is a directive rather than a condition and goes last; without it the
  // `sys_id>` cursor would filter rows but not guarantee the order that makes
  // the next cursor meaningful.
  conditions.push("ORDERBYsys_id");

  return {
    path: `${TABLE_API_BASE}/${table}`,
    params: {
      sysparm_query: conditions.join("^"),
      sysparm_fields: projection.join(","),
      sysparm_limit: String(pageSize),
      sysparm_exclude_reference_link: "true",
      sysparm_display_value: "false",
      sysparm_suppress_pagination_header: "true",
    },
  };
}
