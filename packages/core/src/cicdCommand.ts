// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `syncrona cicd <action>` — a driver for the ServiceNow CI/CD REST API
 * (`api/sn_cicd/*`, requirement R6): run an ATF suite or a single ATF test, and
 * install, publish or roll back an application from the app repository.
 *
 * Every action has the same shape: one POST that dispatches asynchronous work
 * and returns a progress tracker (`result.links.progress.id`), then a poll of
 * `GET api/sn_cicd/progress/{id}` every second until the tracker reaches a
 * terminal status. The ATF actions then fetch the linked result record once, to
 * report pass/fail counts and to catch a suite whose tracker says "successful"
 * while its tests did not pass.
 *
 * Exit codes follow `mirror`'s convention, because both are CI gates:
 *
 * - 0 — the work ran and succeeded.
 * - 1 — the work could not be run to completion: bad usage, no credentials, a
 *   network or HTTP failure (including the instance rejecting the dispatch, and
 *   a 403 for a missing `sn_cicd` role), or the poll timing out. The answer to
 *   "did it pass?" is unknown. A poll answered with a client error (400, 401,
 *   403, 404, ...) fails at once, naming the status and the request, and so
 *   does a 3xx answer, reported as unexpected; an HTML page in place of JSON
 *   and a redirect loop fail at once too, as a session/authentication
 *   redirect; no response, 408, 425, 429 and 5xx are retried a few times; a timeout
 *   says where to check the tracker and how to resume waiting for it.
 * - 2 — the work ran to its end and the instance reported a failure: ATF tests
 *   failed or errored, or the tracker ended in error or was cancelled.
 *
 * sn_cicd does not use the Table API error envelope. Its errors arrive as
 * `{"result":{"status":"3","status_label":"Failed","error":"..."}}` (verified on
 * a Zurich instance), while lookups behind it and some gateways answer with the
 * standard `{"error":{"message","detail"}}`. {@link extractCicdErrorMessage}
 * reads both, plus the `status_message`-only variant.
 *
 * There is no preview mode (`supportsDryRun: false`): the dispatch POST is the
 * whole effect, so a "dry" run would be a request that does nothing.
 *
 * `--progress-id <sys_id>` (SDK-F7) resumes a run that outlived `--timeout` or
 * an MCP `sync_cicd_run` budget: the dispatch is skipped and that tracker is
 * polled with the same ATF result read and the same exit codes. The action is
 * still given, because it decides which result record an ATF tracker links to;
 * the dispatch flags are ignored. A tracker that links an ATF result is refused
 * (exit 1) when resumed as install/publish/rollback, and an ATF action over a
 * successful tracker that links no result is refused (exit 1) on a resume,
 * never read as a pass. An ATF tracker that ended in error or was cancelled
 * before linking a result exits 2 whether it was dispatched or resumed, with a
 * message that reports no tests rather than failing ones. The tracker does not record
 * which app-repo action started it, so install, publish and rollback cannot be
 * told apart on a resume: that one is taken on the caller's word, with a warning.
 *
 * The ATF verdict is an allow-list ({@link ATF_PASSING_STATUSES}): a successful
 * tracker over a result that is neither clearly passing nor clearly failing is
 * exit 1, never exit 0, and a suite that executed zero tests is exit 2.
 */
import type { Sync } from "@syncrona/types";
import type { AxiosResponse } from "axios";
import { logger } from "./Logger.js";
import { setLogLevel, logErrorHint, resolveInstanceProfile } from "./commandHelpers.js";
import { OAUTH_TOKEN_PATH } from "./oauth.js";
import { defaultClient, resolveCredentials } from "./snClient.js";

/** The subcommands, in the order the docs list them. */
export const CICD_ACTIONS = ["run-suite", "run-test", "install", "publish", "rollback"] as const;
export type CicdAction = (typeof CICD_ACTIONS)[number];

/** Process exit codes; see the module docblock. Same numbers as `mirror`. */
export const CICD_EXIT_SUCCESS = 0;
export const CICD_EXIT_INCOMPLETE = 1;
export const CICD_EXIT_FAILED = 2;
export type CicdExitCode =
  | typeof CICD_EXIT_SUCCESS
  | typeof CICD_EXIT_INCOMPLETE
  | typeof CICD_EXIT_FAILED;

/** Tracker statuses reported by `GET api/sn_cicd/progress/{id}`. */
export const CicdProgressStatus = {
  PENDING: "0",
  RUNNING: "1",
  SUCCESSFUL: "2",
  ERROR: "3",
  CANCELED: "4",
} as const;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  CicdProgressStatus.SUCCESSFUL,
  CicdProgressStatus.ERROR,
  CicdProgressStatus.CANCELED,
]);

const STATUS_LABELS: Record<string, string> = {
  [CicdProgressStatus.PENDING]: "Pending",
  [CicdProgressStatus.RUNNING]: "Running",
  [CicdProgressStatus.SUCCESSFUL]: "Successful",
  [CicdProgressStatus.ERROR]: "Failed",
  [CicdProgressStatus.CANCELED]: "Canceled",
};

/** Poll interval now-sdk uses; `--poll-ms` overrides it. */
export const DEFAULT_POLL_MS = 1000;
/** The shortest `--poll-ms` honoured: a smaller value would hammer the instance. */
export const MIN_POLL_MS = 250;
/** How long to wait for a terminal status; `--timeout` (seconds) overrides it. */
export const DEFAULT_TIMEOUT_SECONDS = 3600;

export type CicdCmdArgs = Sync.SharedCmdArgs & {
  action?: string;
  suiteId?: string;
  suiteName?: string;
  testId?: string;
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  runInCloud?: boolean;
  performance?: boolean;
  captureNodeLogs?: boolean;
  scope?: string;
  appSysId?: string;
  appVersion?: string;
  baseAppVersion?: string;
  autoUpgradeBaseApp?: boolean;
  devNotes?: string;
  progressId?: string;
  pollMs?: number;
  timeout?: number;
  json?: boolean;
};

/** The dispatch request one action makes: a path under `api/sn_cicd/` and its query. */
export interface CicdRequest {
  path: string;
  params: Record<string, string>;
}

/** The two sn_cicd calls the command makes — the slice of `SNClient` it needs. */
export interface CicdClient {
  cicdPost: (path: string, params?: Record<string, string>) => Promise<AxiosResponse<unknown>>;
  cicdGet: (path: string) => Promise<AxiosResponse<unknown>>;
}

/** Every effect the command has on the world, in one injectable object. */
export interface CicdCommandDeps {
  /** Builds the instance client for the resolved credential profile. */
  createClient: (profile?: string) => CicdClient;
  /** Waits between polls; a fake clock drives it under test. */
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch, for the poll timeout. */
  now: () => number;
  /** Where `--json` output goes — stdout in production, a buffer under test. */
  write: (line: string) => void;
}

/**
 * A failure the command itself detected (bad usage, an unusable response, a
 * timeout). All map to exit 1; the class only keeps them apart from transport
 * errors, whose HTTP status still drives the error-taxonomy hint.
 */
/**
 * The `--json` verdict: `passed`, `failed` and `no_tests` are what the instance
 * reported; `incomplete` means the run could not be followed to its end (usage,
 * HTTP, timeout, a refused resume), and `unknown` that the tracker finished but
 * its ATF result was unreadable or unclear. Both of the last two exit 1.
 */
export type CicdJsonVerdict = "passed" | "failed" | "no_tests" | "incomplete" | "unknown";

export class CicdCliError extends Error {
  constructor(
    message: string,
    readonly verdict: Extract<CicdJsonVerdict, "incomplete" | "unknown"> = "incomplete"
  ) {
    super(message);
    this.name = "CicdCliError";
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Pulls the human message out of any of the error envelopes sn_cicd answers
 * with: Table API `{error:{message,detail}}`, sn_cicd `{result:{error}}`, or a
 * failure reported only in `result.status_message`.
 */
export function extractCicdErrorMessage(body: unknown): string | undefined {
  const root = asObject(body);
  const tableError = asObject(root?.error);
  const tableMessage = nonEmptyString(tableError?.message);
  if (tableMessage) {
    const detail = nonEmptyString(tableError?.detail);
    return detail && detail !== tableMessage ? `${tableMessage}: ${detail}` : tableMessage;
  }
  const result = asObject(root?.result);
  return nonEmptyString(result?.error) ?? nonEmptyString(result?.status_message);
}

/** The response body an axios HTTP error carries, if any. */
function errorResponseBody(error: unknown): unknown {
  return asObject(asObject(error)?.response)?.data;
}

function setParam(params: Record<string, string>, name: string, value: unknown): void {
  if (typeof value === "boolean") {
    params[name] = String(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    params[name] = value.trim();
  }
}

/** `--scope` or `--app-sys-id`, exactly one, for the three app-repo actions. */
function appIdentity(action: CicdAction, args: CicdCmdArgs): Record<string, string> {
  const params: Record<string, string> = {};
  setParam(params, "scope", args.scope);
  setParam(params, "sys_id", args.appSysId);
  const count = Object.keys(params).length;
  if (count !== 1) {
    throw new CicdCliError(
      `cicd ${action} needs exactly one of --scope or --app-sys-id (got ${count === 0 ? "neither" : "both"}).`
    );
  }
  return params;
}

/**
 * Maps one action and its flags to the exact dispatch request. Pure, so the
 * path/parameter contract can be table-tested without HTTP. Throws a
 * {@link CicdCliError} for a missing or conflicting required flag.
 */
export function buildCicdRequest(action: CicdAction, args: CicdCmdArgs): CicdRequest {
  const params: Record<string, string> = {};
  switch (action) {
    case "run-suite": {
      setParam(params, "test_suite_sys_id", args.suiteId);
      setParam(params, "test_suite_name", args.suiteName);
      const count = Object.keys(params).length;
      if (count !== 1) {
        throw new CicdCliError(
          `cicd run-suite needs exactly one of --suite-id or --suite-name (got ${count === 0 ? "neither" : "both"}).`
        );
      }
      setParam(params, "browser_name", args.browserName);
      setParam(params, "browser_version", args.browserVersion);
      setParam(params, "os_name", args.osName);
      setParam(params, "os_version", args.osVersion);
      setParam(params, "run_in_cloud", args.runInCloud);
      setParam(params, "is_performance_run", args.performance);
      return { path: "testsuite/run", params };
    }
    case "run-test": {
      setParam(params, "test_sys_id", args.testId);
      if (!params.test_sys_id) {
        throw new CicdCliError("cicd run-test needs --test-id (the sys_id of the ATF test).");
      }
      setParam(params, "run_in_cloud", args.runInCloud);
      setParam(params, "capture_node_logs", args.captureNodeLogs);
      return { path: "tests/run_test", params };
    }
    case "install": {
      Object.assign(params, appIdentity(action, args));
      setParam(params, "version", args.appVersion);
      setParam(params, "base_app_version", args.baseAppVersion);
      setParam(params, "auto_upgrade_base_app", args.autoUpgradeBaseApp);
      return { path: "app_repo/install", params };
    }
    case "publish": {
      Object.assign(params, appIdentity(action, args));
      setParam(params, "version", args.appVersion);
      setParam(params, "dev_notes", args.devNotes);
      return { path: "app_repo/publish", params };
    }
    case "rollback": {
      Object.assign(params, appIdentity(action, args));
      setParam(params, "version", args.appVersion);
      if (!params.version) {
        throw new CicdCliError(
          "cicd rollback needs --app-version: the version the application should have after the rollback."
        );
      }
      return { path: "app_repo/rollback", params };
    }
  }
}

/** A tracker id is a sys_id; it is spliced into the progress URL. */
const PROGRESS_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * The `--progress-id` of a resume: undefined when absent, the trimmed id when
 * it is a sys_id, and a {@link CicdCliError} for anything else.
 */
export function parseProgressIdFlag(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id = typeof value === "string" ? value.trim() : "";
  if (!PROGRESS_ID_PATTERN.test(id)) {
    throw new CicdCliError(
      "--progress-id must be the 32-character hexadecimal sys_id of an sn_cicd progress tracker."
    );
  }
  return id;
}

/** Sends the dispatch POST and returns the tracker it started: its id, and its URL when given. */
async function dispatch(
  client: CicdClient,
  action: CicdAction,
  request: CicdRequest
): Promise<{ id: string; url?: string }> {
  logger.info(`POST api/sn_cicd/${request.path}`);
  let response: AxiosResponse<unknown>;
  try {
    response = await send(() => client.cicdPost(request.path, request.params), action);
  } catch (err) {
    throw unexpectedRedirectError(err, action) ?? err;
  }
  const dispatched = resultOf(response, action);
  const progressId = linkId(dispatched, "progress");
  if (!progressId) {
    // A 200 can still carry a rejection in the sn_cicd envelope (status "3" +
    // error); either way nothing was started, so nothing can be reported on.
    const reason = extractCicdErrorMessage({ result: dispatched });
    throw new CicdCliError(
      reason
        ? `The instance rejected cicd ${action}: ${reason}`
        : `The instance accepted cicd ${action} but returned no progress id to follow.`
    );
  }
  return { id: progressId, url: linkUrl(dispatched, "progress") };
}

/** A positive finite number, or the fallback. */
function positiveOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Whether a 2xx answer is an HTML page: a body that starts with `<`. sn_cicd
 * only answers JSON, so this is an SSO/login page (or a hibernation page) served
 * in place of the API — a session problem that asking again will not fix. The
 * content type is deliberately not consulted: a body that parsed as JSON is the
 * real signal, whatever the header says, and the mcp-server sees no headers at
 * all. Must match `isHtmlBody` in the mcp-server's `insightCicdRun.ts`.
 */
function isHtmlAnswer(response: AxiosResponse<unknown>): boolean {
  return typeof response?.data === "string" && response.data.trimStart().startsWith("<");
}

/** The error for an HTML answer; the same text as the mcp-server's. */
function htmlAnswerError(what: string): CicdCliError {
  return new CicdCliError(
    `The instance answered the ${what} request with an HTML page instead of JSON, likely a session/authentication redirect ` +
      "to a login page (or a hibernating instance); check the credentials and the session, and that the instance is awake. It is not retried."
  );
}

/**
 * Whether a request failed because its redirects looped: axios
 * (follow-redirects) rejects with `ERR_FR_TOO_MANY_REDIRECTS`, and native fetch
 * with a "redirect count exceeded" cause. A login gateway bouncing the request
 * back and forth is the usual source, so it is a session failure, not a missing
 * response. Must match `isRedirectLoopError` in the mcp-server.
 */
function isRedirectLoopError(err: unknown): boolean {
  const source = asObject(err);
  if (source?.code === "ERR_FR_TOO_MANY_REDIRECTS") return true;
  const pattern = /redirect count exceeded|maximum number of redirects/i;
  const message = err instanceof Error ? err.message : "";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return pattern.test(message) || pattern.test(cause);
}

/** The error for a redirect loop; the same text as the mcp-server's. */
function redirectLoopError(what: string): CicdCliError {
  return new CicdCliError(
    `The ${what} request was redirected in a loop (too many redirects), likely a session/authentication redirect ` +
      "to a login page; check the credentials and the session. It is not retried."
  );
}

/** Sends one sn_cicd request, reporting a redirect loop as a session failure. */
async function send(call: () => Promise<AxiosResponse<unknown>>, what: string): Promise<AxiosResponse<unknown>> {
  try {
    return await call();
  } catch (err) {
    if (isRedirectLoopError(err)) throw redirectLoopError(what);
    throw err;
  }
}

/** `result` of an sn_cicd response, or an error saying the body was not one. */
function resultOf(response: AxiosResponse<unknown>, what: string): JsonObject {
  if (isHtmlAnswer(response)) {
    throw htmlAnswerError(what);
  }
  const result = asObject(asObject(response?.data)?.result);
  if (!result) {
    throw new CicdCliError(
      `The instance answered the ${what} request without a JSON \`result\` — likely an HTML login/hibernation page or a proxy error. Confirm the instance is awake and the credentials are valid.`
    );
  }
  return result;
}

function linkId(result: JsonObject | undefined, link: string): string | undefined {
  return nonEmptyString(asObject(asObject(result?.links)?.[link])?.id);
}

function linkUrl(result: JsonObject | undefined, link: string): string | undefined {
  return nonEmptyString(asObject(asObject(result?.links)?.[link])?.url);
}

function statusLabel(progress: JsonObject): string {
  const status = String(progress.status ?? "");
  return nonEmptyString(progress.status_label) ?? STATUS_LABELS[status] ?? `status ${status}`;
}

/**
 * Consecutive transient poll failures tolerated before the run is abandoned.
 * An install or a suite runs for minutes, and one dropped connection or 502 from
 * a proxy is not a reason to stop watching work the instance is still doing.
 */
export const CICD_MAX_POLL_FAILURES = 3;

/** The HTTP status an axios error carries, or undefined when there was no response. */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Whether a request failed in the network, with no answer at all: a timeout
 * abort, or a system/transport error code (`ECONNRESET`, `ECONNREFUSED`,
 * `ETIMEDOUT`, `ENOTFOUND`, axios's `ECONNABORTED` and `ERR_NETWORK`, undici's
 * `UND_ERR_*`), on the error itself or on its `cause` (fetch wraps it in a
 * `TypeError("fetch failed")`). A bare `TypeError` or any other error without
 * such a code is a bug or a malformed answer, not a dropped connection. Must
 * match `isNetworkError` in the mcp-server's `insightCicdRun.ts`.
 */
function isNetworkError(err: unknown): boolean {
  const source = asObject(err);
  const name = source?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const pattern = /^(E[A-Z]+|ERR_NETWORK|UND_ERR_[A-Z_]+)$/;
  const code = source?.code;
  const causeCode = asObject(source?.cause)?.code;
  return (
    (typeof code === "string" && pattern.test(code)) || (typeof causeCode === "string" && pattern.test(causeCode))
  );
}

/**
 * A poll failure worth retrying: no response at all (a reset or refused
 * connection, a DNS blip, a timeout; see {@link isNetworkError}), 408 (the
 * request timed out), 425 (too early), 429, or a 5xx. Every other status — 400,
 * 401, 403, 404 and the rest of 4xx, and a 3xx redirect — is the instance's
 * settled answer to this request, and asking again until the timeout would only
 * delay the same failure; an error with neither a status nor a network code (a
 * bug, a malformed answer) fails at once too. Must match `isTransientPollError`
 * in the mcp-server's `insightCicdRun.ts`.
 */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof CicdCliError) return false;
  const status = httpStatusOf(err);
  if (status === undefined) return isNetworkError(err);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The `Location` header of a redirect answer, when the error carries one. */
function redirectLocationOf(err: unknown): string | undefined {
  const headers = asObject(asObject(asObject(err)?.response)?.headers);
  return nonEmptyString(headers?.location) ?? nonEmptyString(headers?.Location);
}

/**
 * Why a permanent poll status is not retried. A 3xx is not a client error:
 * sn_cicd answers JSON directly, so any 3xx the client hands back (a 304, a
 * redirect without a `Location`, or one it did not follow) means something in
 * front of the instance — a proxy or an SSO/login gateway — took the request.
 */
function permanentPollReason(status: number | undefined, err: unknown): string {
  if (status !== undefined && status >= 300 && status < 400) {
    return unexpectedRedirectReason(status, err);
  }
  if (status === undefined) {
    return "failed without an HTTP answer and not in the network (a client-side error); it is not retried.";
  }
  if (isTokenEndpointError(err)) {
    // The progress request was never sent: getting its OAuth token failed.
    // Named as sync_cicd_run's token poster words it.
    return `failed: ${tokenEndpointReason(status, err)}; it is not retried.`;
  }
  const hint = PERMANENT_POLL_HINTS[status];
  return `answered HTTP ${String(status)}${hint ? ` (${hint})` : ""}; a client error is not retried.`;
}

/**
 * Why a token-endpoint failure failed the call, named as sync_cicd_run's token
 * poster words it. Only a 4xx is a rejection of the client or the credentials:
 * a 5xx or a network failure is an outage, and blaming the credentials would
 * send the user to fix ones that are fine.
 */
function tokenEndpointReason(status: number | undefined, err: unknown): string {
  if (status === undefined) {
    return `OAuth token request failed (${errorText(err).replace(/\.$/, "")}): no OAuth token could be obtained`;
  }
  const rejected = status >= 400 && status < 500;
  return `OAuth token request failed (${String(status)}): ${
    rejected ? "the token endpoint rejected the OAuth client or the credentials" : "no OAuth token could be obtained"
  }`;
}

/** Whether an axios error came from the OAuth token endpoint, not from sn_cicd. */
function isTokenEndpointError(err: unknown): boolean {
  const url = (err as { config?: { url?: unknown } } | null)?.config?.url;
  return typeof url === "string" && url.replace(/^\//, "").startsWith(OAUTH_TOKEN_PATH);
}

/** Why a 3xx answer is not retried; see {@link permanentPollReason}. */
function unexpectedRedirectReason(status: number, err: unknown): string {
  const location = redirectLocationOf(err);
  return (
    `answered HTTP ${status}${location ? ` (Location: ${location})` : ""}, an unexpected 3xx answer: ` +
    "sn_cicd answers JSON directly, so a proxy or an SSO/login gateway in front of the instance likely intercepted the request; " +
    "it is not retried."
  );
}

/**
 * The error for a dispatch or an ATF result read that answered a 3xx, or
 * undefined for any other failure. axios would otherwise report it as a bare
 * "Request failed with status code 304"; the text is the mcp-server's
 * `sync_cicd_run` one (which has no headers, so it never names a Location).
 */
function unexpectedRedirectError(err: unknown, what: string): CicdCliError | undefined {
  const status = httpStatusOf(err);
  if (status === undefined || status < 300 || status >= 400) return undefined;
  return new CicdCliError(`The ${what} request ${unexpectedRedirectReason(status, err)}`);
}

/** What a permanent poll status most likely means, for the error message. */
const PERMANENT_POLL_HINTS: Record<number, string> = {
  400: "the instance rejected the request as malformed",
  401: "the instance rejected the credentials",
  403: "the user may not read CI/CD progress",
  404: "the instance has no such progress tracker (check the id and the instance profile)",
};

/**
 * A failed poll, re-raised with a message that names the request and why it was
 * not (or no longer) retried. The original `response`, `config` and `code` are
 * kept, so the caller still appends the instance's error envelope and the error
 * taxonomy still picks its hint (the sn_cicd 403 missing-role one included).
 */
export class CicdPollError extends Error {
  readonly response?: unknown;
  readonly config?: unknown;
  readonly code?: unknown;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CicdPollError";
    const source = asObject(cause);
    this.response = source?.response;
    this.config = source?.config;
    this.code = source?.code;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Polls the tracker until a terminal status. A permanent HTTP answer fails at
 * once, transient failures are retried one `pollMs` apart up to
 * {@link CICD_MAX_POLL_FAILURES} in a row, and running out of `timeoutMs` —
 * whether the last poll answered or failed — ends with the timeout error, which
 * names the tracker, where to check it, and how to resume waiting.
 */
async function pollProgress(
  deps: CicdCommandDeps,
  client: CicdClient,
  progressId: string,
  pollMs: number,
  timeoutMs: number,
  progressUrl?: string
): Promise<JsonObject> {
  const startedAt = deps.now();
  const request = `GET api/sn_cicd/progress/${progressId}`;
  let lastStatus: string | undefined;
  let lastProgress: JsonObject | undefined;
  let failures = 0;
  const timedOut = (lastError?: unknown): CicdCliError => {
    const where = linkUrl(lastProgress, "progress") ?? progressUrl ?? `${request} on the instance`;
    const last = lastProgress ? statusLabel(lastProgress) : "never read";
    const error = lastError === undefined ? "" : `; last poll error: ${errorText(lastError)}`;
    return new CicdCliError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for progress ${progressId} (last status: ${last}${error}). ` +
        `The work may still be running on the instance; check it at ${where} and resume waiting with --progress-id ${progressId} (and a longer --timeout).`
    );
  };
  for (;;) {
    let response: AxiosResponse<unknown>;
    try {
      response = await send(() => client.cicdGet(`progress/${encodeURIComponent(progressId)}`), "progress");
    } catch (err) {
      // Already a settled, named failure (a redirect loop): reported as is.
      if (err instanceof CicdCliError) throw err;
      failures += 1;
      const status = httpStatusOf(err);
      if (!isTransientPollError(err)) {
        // A 3xx or token-endpoint reason is whole, as sync_cicd_run words it:
        // axios's own "Request failed with status code N" would only repeat the status.
        const redirect = status !== undefined && status >= 300 && status < 400;
        const whole = redirect || (status !== undefined && isTokenEndpointError(err));
        const tail = whole ? "" : ` ${errorText(err)}`;
        throw new CicdPollError(`${request} ${permanentPollReason(status, err)}${tail}`, err);
      }
      if (deps.now() - startedAt >= timeoutMs) {
        throw timedOut(err);
      }
      if (failures >= CICD_MAX_POLL_FAILURES) {
        throw new CicdPollError(
          `${request} failed ${failures} times in a row (last: ${status === undefined ? "no response" : `HTTP ${status}`}). ${errorText(err)}`,
          err
        );
      }
      logger.warn(
        `Progress ${progressId}: poll failed (${failures}/${CICD_MAX_POLL_FAILURES}), retrying: ${errorText(err)}`
      );
      await deps.sleep(pollMs);
      continue;
    }
    failures = 0;
    const progress = resultOf(response, "progress");
    lastProgress = progress;
    const status = String(progress.status ?? "");
    if (status !== lastStatus) {
      const percent =
        progress.percent_complete === undefined ? "" : ` (${String(progress.percent_complete)}%)`;
      logger.info(`Progress ${progressId}: ${statusLabel(progress)}${percent}`);
      lastStatus = status;
    }
    if (TERMINAL_STATUSES.has(status)) {
      return progress;
    }
    if (deps.now() - startedAt >= timeoutMs) {
      throw timedOut();
    }
    await deps.sleep(pollMs);
  }
}

/**
 * The ATF verdict allow-list. It must stay identical to the copy in
 * `packages/mcp-server/src/handlers/insightCicdRun.ts` (the mcp-server may not
 * import core), and both are table-tested against the same shapes.
 *
 * A status is compared trimmed and case-insensitively against two explicit sets:
 * the `sys_atf_test_result` / `sys_atf_test_suite_result` status choice values
 * sn_cicd reports in `test_status` and `test_suite_status`. Anything in neither
 * set (canceled, skipped, running, pending, "failed", a missing status, ...) does
 * not say whether the tests passed, so it is never read as a pass.
 */
export const ATF_PASSING_STATUSES: ReadonlySet<string> = new Set(["success", "success_with_warnings"]);
export const ATF_FAILING_STATUSES: ReadonlySet<string> = new Set(["failure", "error"]);

/**
 * `passed` and `failed` are clear answers; `no_tests` is a suite that reports a
 * pass but executed zero tests, which is not a pass and exits 2 like a failure
 * (the instance answered clearly, so reading it again would not change it);
 * `unknown` is a readable record that does not clearly say either, which a
 * successful tracker turns into exit 1.
 */
export type AtfVerdict = "passed" | "failed" | "no_tests" | "unknown";

/** A status string trimmed and lower-cased, or undefined when there is none. */
function normalizedAtfStatus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined;
}

/**
 * A count the record states unambiguously: a non-negative integer, as a number
 * or a digit-only string. Anything else (missing, "", "n/a", 1.5, -1) is
 * undefined, so it can neither prove a pass nor hide a failure.
 */
export function strictAtfCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The verdict of a suite result: `failed` when a failure or error count is
 * positive or the status is a failing one; `passed` only when the status is a
 * passing one, both the failure and the error count are stated as 0, AND the
 * success count is stated as at least 1; `no_tests` when that passing shape
 * states a success count of 0 (a suite that executed nothing — empty, or every
 * test skipped — proves nothing); every other shape is `unknown` (fail-closed:
 * a missing count is not a zero, and a missing success count is not a run).
 */
export function atfSuiteVerdict(body: JsonObject): AtfVerdict {
  const status = normalizedAtfStatus(body.test_suite_status);
  const failed = strictAtfCount(body.rolledup_test_failure_count);
  const errored = strictAtfCount(body.rolledup_test_error_count);
  if ((failed ?? 0) > 0 || (errored ?? 0) > 0 || (status !== undefined && ATF_FAILING_STATUSES.has(status))) {
    return "failed";
  }
  if (status !== undefined && ATF_PASSING_STATUSES.has(status) && failed === 0 && errored === 0) {
    const succeeded = strictAtfCount(body.rolledup_test_success_count);
    if (succeeded === 0) return "no_tests";
    if (succeeded !== undefined) return "passed";
  }
  return "unknown";
}

/** The verdict of a single-test result, from `test_status` alone. */
export function atfTestVerdict(body: JsonObject): AtfVerdict {
  const status = normalizedAtfStatus(body.test_status);
  if (status !== undefined && ATF_FAILING_STATUSES.has(status)) return "failed";
  if (status !== undefined && ATF_PASSING_STATUSES.has(status)) return "passed";
  return "unknown";
}

/** What the linked ATF result record says, when there is one to read. */
interface AtfOutcome {
  body: JsonObject;
  verdict: AtfVerdict;
  summary: string;
  url?: string;
}

/** A count for the human summary only; the verdict reads {@link strictAtfCount}. */
function countOf(value: unknown): string {
  const n = strictAtfCount(value);
  return n === undefined ? (value === undefined ? "0" : "?") : String(n);
}

/**
 * Whether a finished tracker carries the mark of an ATF run: a `links.results`
 * entry (sn_cicd links the suite or test result from an ATF tracker). The
 * app-repo trackers link no result record. That is the only kind evidence the
 * tracker exposes: it does not record which app-repo action (install, publish,
 * rollback) started it, nor mark an ATF run that has not linked its result.
 */
function trackerLinksAtfResult(progress: JsonObject): boolean {
  return asObject(asObject(progress.links)?.results) !== undefined;
}

/**
 * The hint for a resumed ATF tracker whose result 404s: the same action can
 * never read it, so it names the other ATF kind and the action that reads it.
 */
function atfKindMismatchHint(action: CicdAction, progressId: string): string {
  const [kind, path, other] =
    action === "run-test"
      ? ["a suite run rather than a single test", "tests/test/results/<id>", "run-suite"]
      : ["a single-test run rather than a suite", "testsuite/results/<id>", "run-test"];
  return (
    `progress ${progressId} may belong to ${kind} (${action} reads ${path}); ` +
    `resume it with --progress-id ${progressId} and the ${other} action instead.`
  );
}

/**
 * Reads the suite or test result linked from the finished tracker. A tracker
 * with no result link, or a result read that fails, comes back as `unreadable`
 * with the reason: for a tracker that reports success, the caller turns that
 * into exit 1 (the answer to "did the tests pass?" is unknown), never exit 0.
 * `notFound` marks a 404 on the read: on a resume it usually means the tracker
 * belongs to the other ATF kind (a suite result read as a test result, or the
 * reverse), which a re-read with the same action can never fix.
 */
async function fetchAtfOutcome(
  client: CicdClient,
  action: CicdAction,
  progress: JsonObject
): Promise<AtfOutcome | { unreadable: string; notFound?: boolean }> {
  const resultId = linkId(progress, "results");
  if (!resultId) {
    return { unreadable: "the tracker links no ATF result record" };
  }
  const path =
    action === "run-suite"
      ? `testsuite/results/${encodeURIComponent(resultId)}`
      : `tests/test/results/${encodeURIComponent(resultId)}`;
  let body: JsonObject;
  try {
    body = resultOf(await send(() => client.cicdGet(path), "ATF result"), "ATF result");
  } catch (e) {
    const redirect = unexpectedRedirectError(e, "ATF result");
    const status = httpStatusOf(e);
    // The read was never sent when its OAuth token could not be had.
    const tokenReason = isTokenEndpointError(e) ? tokenEndpointReason(status, e) : undefined;
    // The trailing period is dropped: the reason is quoted mid-sentence.
    const reason = (
      redirect?.message ??
      tokenReason ??
      extractCicdErrorMessage(errorResponseBody(e)) ??
      (e instanceof Error ? e.message : String(e))
    ).replace(/\.$/, "");
    logger.debug(`Could not fetch ATF result ${resultId}: ${reason}`);
    return {
      unreadable: `ATF result ${resultId} could not be read: ${reason}`,
      notFound: status === 404,
    };
  }
  const url = linkUrl(body, "results") ?? linkUrl(progress, "results");
  if (action === "run-suite") {
    const passed = countOf(body.rolledup_test_success_count);
    const failed = countOf(body.rolledup_test_failure_count);
    const errored = countOf(body.rolledup_test_error_count);
    const skipped = countOf(body.rolledup_test_skip_count);
    const suiteStatus = nonEmptyString(body.test_suite_status);
    return {
      body,
      verdict: atfSuiteVerdict(body),
      summary: `${suiteStatus ? `Suite ${suiteStatus}: ` : ""}${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped`,
      url,
    };
  }
  const testStatus = nonEmptyString(body.test_status);
  return {
    body,
    verdict: atfTestVerdict(body),
    summary: `Test ${testStatus ?? "finished"}${nonEmptyString(body.output) ? `: ${String(body.output)}` : ""}`,
    url,
  };
}

/**
 * Why an ATF tracker that ended in error or cancelled without linking a result
 * failed. It never claims failing tests. On a resume the tracker kind is the
 * caller's word, and a failed app-repo tracker has the same shape, so the
 * message names that possibility instead of asserting either one.
 */
function endedWithoutAtfResult(
  progress: JsonObject,
  instanceReason: string | undefined,
  resumeId: string | undefined
): string {
  const ended =
    `the tracker ended ${statusLabel(progress)}${instanceReason ? ` (${instanceReason})` : ""} ` +
    "before linking an ATF result record, so no test results were reported";
  return resumeId
    ? `${ended}; if progress ${resumeId} is an install, publish or rollback run rather than an ATF run, resume it with that action to report it under its own name`
    : ended;
}

/** Runs one action end to end and returns its exit code. */
async function runAction(
  deps: CicdCommandDeps,
  action: CicdAction,
  args: CicdCmdArgs,
  profile: string | undefined,
  state: { progressId?: string } = {}
): Promise<CicdExitCode> {
  // Validated before the client exists, so a bad flag never reaches the instance.
  const resumeId = parseProgressIdFlag(args.progressId);
  const request = resumeId ? undefined : buildCicdRequest(action, args);
  const pollMs = Math.max(MIN_POLL_MS, positiveOr(args.pollMs, DEFAULT_POLL_MS));
  if (args.timeout !== undefined && positiveOr(args.timeout, -1) === -1) {
    throw new CicdCliError(
      `--timeout must be a positive number of seconds, got "${String(args.timeout)}".`
    );
  }
  const timeoutMs = positiveOr(args.timeout, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const client = deps.createClient(profile);

  if (resumeId) {
    logger.info(`Resuming cicd ${action} from progress ${resumeId} (nothing is dispatched).`);
  }
  const tracker: { id: string; url?: string } = resumeId
    ? { id: resumeId }
    : await dispatch(client, action, request as CicdRequest);
  const progressId = tracker.id;
  // Known from here on, so a later failure (a timeout, a failed poll) can still
  // tell a --json caller which progress to resume with --progress-id.
  state.progressId = progressId;

  const progress = await pollProgress(deps, client, progressId, pollMs, timeoutMs, tracker.url);
  const status = String(progress.status);
  const isAtfAction = action === "run-suite" || action === "run-test";
  // A resume takes the action from the caller, so it is checked against the
  // tracker in both directions before any verdict. A tracker that links an ATF
  // result is a test run: reporting it as an app-repo action would skip the
  // pass/fail read, whatever its status. The other direction (an app tracker
  // resumed as an ATF action) links no result: a successful one must not read
  // as a pass, and a failed one is reported as a run that ended before any test
  // result, never as failing tests. Install, publish and rollback trackers look the
  // same, so a resumed app action is reported on the caller's word (warned).
  if (resumeId && !isAtfAction && trackerLinksAtfResult(progress)) {
    throw new CicdCliError(
      `progress ${progressId} links an ATF result, so it looks like a test run rather than ${action}. ` +
        "Resume it with the run-suite or run-test action to read whether the tests passed."
    );
  }
  // Only a SUCCESSFUL tracker is refused: an ATF run that was cancelled or failed
  // before it linked its result looks exactly like a failed app-repo run, and a
  // dispatched ATF run in that state exits 2, so a resume of it must too.
  const atfWithoutResult = isAtfAction && !trackerLinksAtfResult(progress);
  if (resumeId && atfWithoutResult && status === CicdProgressStatus.SUCCESSFUL) {
    throw new CicdCliError(
      `progress ${progressId} links no ATF result record, so it looks like an app-repo run rather than ${action} ` +
        `(it ended ${statusLabel(progress)}). Resume it with the install, publish or rollback action that started it; ` +
        "it does not say whether any tests passed."
    );
  }
  const read = isAtfAction ? await fetchAtfOutcome(client, action, progress) : undefined;
  const atf = read && !("unreadable" in read) ? read : undefined;
  if (status === CicdProgressStatus.SUCCESSFUL) {
    // A successful tracker only says the run finished; the result record says
    // whether the tests passed. Without it the verdict is unknown, not a pass.
    if (read && "unreadable" in read) {
      throw new CicdCliError(
        `progress ${progressId} finished, but ${read.unreadable}, so whether the tests passed is unknown. ` +
          (resumeId && read.notFound
            ? atfKindMismatchHint(action, progressId)
            : `Re-run with --progress-id ${progressId} to read the result again.`),
        "unknown"
      );
    }
    if (atf?.verdict === "unknown") {
      throw new CicdCliError(
        `progress ${progressId} finished, but the ATF result does not clearly report a pass or a failure ` +
          `(${atf.summary}), so whether the tests passed is unknown. ` +
          `Re-run with --progress-id ${progressId} to read the result again.`,
        "unknown"
      );
    }
    if (resumeId && !isAtfAction) {
      logger.warn(
        `progress ${progressId} does not record which app-repo action started it; reporting it as ${action} on the caller's word.`
      );
    }
  }
  const succeeded =
    status === CicdProgressStatus.SUCCESSFUL && (!isAtfAction || atf?.verdict === "passed");
  const exitCode: CicdExitCode = succeeded ? CICD_EXIT_SUCCESS : CICD_EXIT_FAILED;
  const resultsUrl = atf?.url ?? linkUrl(progress, "results");
  const instanceReason = extractCicdErrorMessage({ result: progress });
  const verdict: CicdJsonVerdict = succeeded
    ? "passed"
    : status === CicdProgressStatus.SUCCESSFUL && atf?.verdict === "no_tests"
      ? "no_tests"
      : "failed";
  const reason = succeeded
    ? (atf?.summary ?? `the tracker ended ${statusLabel(progress)}`)
    : status !== CicdProgressStatus.SUCCESSFUL && atfWithoutResult
      ? endedWithoutAtfResult(progress, instanceReason, resumeId)
      : (instanceReason ??
        (status !== CicdProgressStatus.SUCCESSFUL
          ? statusLabel(progress)
          : verdict === "no_tests"
            ? "the suite ran no tests, which is not a pass"
            : "ATF reported failing tests"));

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "cicd",
          action,
          exitCode,
          verdict,
          reason,
          ...(resumeId ? { resumed: true } : {}),
          progressId,
          progress,
          ...(atf ? { results: atf.body } : {}),
          ...(resultsUrl ? { resultsUrl } : {}),
        },
        null,
        2
      )
    );
    return exitCode;
  }

  if (atf) {
    (atf.verdict === "passed" ? logger.info : logger.warn).call(logger, atf.summary);
  }
  if (resultsUrl) {
    logger.info(`Details: ${resultsUrl}`);
  }
  if (succeeded) {
    logger.success(`cicd ${action} completed successfully. ✅`);
  } else {
    logger.error(`cicd ${action} finished with failures: ${reason}`);
  }
  return exitCode;
}

/** The real client, after checking there is an instance to talk to. */
function nodeCreateClient(profile?: string): CicdClient {
  if (!resolveCredentials(profile).instance) {
    throw new CicdCliError(
      "No ServiceNow instance is configured. Run `syncrona login`, or set SN_INSTANCE in the environment."
    );
  }
  return defaultClient(profile);
}

const defaultDeps = (): CicdCommandDeps => ({
  createClient: nodeCreateClient,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  write: (line: string) => process.stdout.write(`${line}\n`),
});

/**
 * `syncrona cicd <action>`. Sets `process.exitCode` rather than calling
 * `process.exit()`, so buffered stdout is flushed before the process ends.
 */
export async function cicdCommand(
  args: CicdCmdArgs,
  overrides: Partial<CicdCommandDeps> = {}
): Promise<void> {
  setLogLevel(args);
  const deps: CicdCommandDeps = { ...defaultDeps(), ...overrides };
  const profile = resolveInstanceProfile(args);
  const action = String(args.action ?? "").trim() as CicdAction;

  // `--json` promises one JSON document on stdout, failures included: a caller
  // parsing stdout must not get an empty string when the run could not finish.
  const writeJsonFailure = (
    error: string,
    progressId?: string,
    verdict: Extract<CicdJsonVerdict, "incomplete" | "unknown"> = "incomplete"
  ): void => {
    if (args.json !== true) return;
    deps.write(
      JSON.stringify(
        {
          command: "cicd",
          action: String(args.action ?? ""),
          exitCode: CICD_EXIT_INCOMPLETE,
          verdict,
          reason: error,
          ...(progressId ? { progressId } : {}),
          error,
        },
        null,
        2
      )
    );
  };

  if (!(CICD_ACTIONS as readonly string[]).includes(action)) {
    const error = `Unknown cicd subcommand "${args.action ?? ""}". Expected one of: ${CICD_ACTIONS.join(" | ")}.`;
    logger.error(error);
    writeJsonFailure(error);
    process.exitCode = CICD_EXIT_INCOMPLETE;
    return;
  }

  const state: { progressId?: string } = {};
  try {
    process.exitCode = await runAction(deps, action, args, profile, state);
  } catch (e) {
    const instanceMessage = extractCicdErrorMessage(errorResponseBody(e));
    const message = e instanceof Error ? e.message : String(e);
    const error = instanceMessage
      ? `cicd ${action} failed: ${message} — ${instanceMessage}`
      : `cicd ${action} failed: ${message || "unknown error"}`;
    logger.error(error);
    if (state.progressId && !error.includes(`--progress-id ${state.progressId}`)) {
      // warn, not info: the resume id is the one thing a quiet (--log-level warn)
      // CI run needs from a failure, and info would hide it.
      logger.warn(`The work was dispatched as progress ${state.progressId}; resume with --progress-id ${state.progressId}.`);
    }
    writeJsonFailure(error, state.progressId, e instanceof CicdCliError ? e.verdict : "incomplete");
    // The original error goes to the taxonomy, so a 403 on an sn_cicd URL gets
    // the missing-role hint instead of the generic "re-run login" one.
    logErrorHint(e);
    process.exitCode = CICD_EXIT_INCOMPLETE;
  }
}
