// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `sync_cicd_run` — the MCP face of `syncrona cicd <action>` (WP-8, requirement
 * R6): run an ATF suite or a single ATF test, or install, publish or roll back an
 * application from the app repository, through the ServiceNow CI/CD REST API
 * (`api/sn_cicd/*`).
 *
 * The mcp-server may not import core (depcruise rule), so this is a deliberate
 * re-implementation of the thin HTTP layer in `packages/core/src/cicdCommand.ts`
 * over `snRequest` (native fetch). The two must agree on:
 *
 * - the dispatch request per action — path and QUERY-STRING parameters (sn_cicd
 *   ignores a JSON body), table-tested on both sides;
 * - the flow — one POST that returns a progress tracker
 *   (`result.links.progress.id`), a poll of `GET api/sn_cicd/progress/{id}` until
 *   a terminal status, then for the ATF actions one read of the linked result
 *   record so a "successful" tracker over failing tests is still reported as a
 *   failure;
 * - the error envelopes — sn_cicd answers `{"result":{"status":"3",
 *   "status_label":"Failed","error":"..."}}`, unlike the Table API's
 *   `{"error":{"message","detail"}}`; both, plus the `status_message`-only
 *   variant, are read by {@link extractCicdErrorMessage};
 * - the outcome — the CLI's exit codes, surfaced as `exitCode` next to a named
 *   `outcome`: 0 `succeeded`, 1 `incomplete` (could not be run to completion — the
 *   answer to "did it pass?" is unknown), 2 `failed` (ran to its end and the
 *   instance reported a failure). Anything but `succeeded` is an MCP error result.
 *
 * Unlike the CLI, the whole call is bounded by the tool's `timeoutMs` (the
 * REV-212 rule for `sync_run_atf_tests`): one deadline for dispatch, poll and
 * result read together, because an MCP client gives up long before the CLI's
 * one-hour default.
 *
 * SDK-F7: a run that outlives that budget comes back `incomplete` with its
 * `progressId`. Passing that id back as `progressId` resumes the run: the
 * dispatch POST is skipped and the same tracker is polled (and, for the ATF
 * actions, its result read) with the same outcome mapping — the CLI's
 * `--progress-id`. A resume only reads, so it does not need
 * `confirmDestructive=true`; `action` stays required because it decides which
 * result record an ATF tracker links to, and the dispatch arguments are ignored.
 * The action is bound to the tracker both ways: a tracker that links an ATF
 * result resumed as install/publish/rollback is `incomplete`, and so is an ATF
 * action resumed over a successful tracker without a result link. A failed or
 * cancelled one is `failed` with "no test results were reported", exactly as
 * when it was dispatched (an ATF run can end before it links its result). The
 * tracker does not record which app-repo action started it, so install, publish
 * and rollback are indistinguishable on a resume and reported on the caller's
 * word (with a note).
 *
 * The ATF verdict is the same allow-list as core ({@link ATF_PASSING_STATUSES}):
 * a successful tracker over a result that is neither clearly passing nor clearly
 * failing is `incomplete`, never `succeeded`, and a suite that executed zero
 * tests is `failed`.
 */
import { wrapUntrustedData } from "../runtimeUtils";
import { snRequest } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import type { InsightToolContext } from "./insightShared";
import { errorResponse, textResponse } from "./insightShared";

const TOOL_NAME = "sync_cicd_run";

/** The actions, in the CLI's order and with the CLI's names. */
export const CICD_RUN_ACTIONS = ["run-suite", "run-test", "install", "publish", "rollback"] as const;
export type CicdRunAction = (typeof CICD_RUN_ACTIONS)[number];

/** Outcome names and the CLI exit code each one stands for. */
export const CICD_RUN_OUTCOMES = {
  succeeded: 0,
  incomplete: 1,
  failed: 2,
} as const;
export type CicdRunOutcome = keyof typeof CICD_RUN_OUTCOMES;

/** Tracker statuses reported by `GET api/sn_cicd/progress/{id}`. */
const STATUS_SUCCESSFUL = "2";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([STATUS_SUCCESSFUL, "3", "4"]);
const STATUS_LABELS: Record<string, string> = {
  "0": "Pending",
  "1": "Running",
  "2": "Successful",
  "3": "Failed",
  "4": "Canceled",
};

/** The role a 403 from sn_cicd almost always means is missing (core's errorTaxonomy). */
export const CICD_ROLE = "sn_cicd.sys_ci_automation";

export const DEFAULT_CICD_POLL_MS = 1000;
const MIN_CICD_POLL_MS = 250;
const MAX_CICD_POLL_MS = 60000;
// A tracker id is a sys_id — the same shape inputValidation enforces up front.
const PROGRESS_ID_REGEX = /^[0-9a-f]{32}$/i;
// Same floor as the ATF poll: a sub-second per-request timeout aborts before an
// ordinary round trip can complete.
const MIN_ATTEMPT_TIMEOUT_MS = 1000;

/** The dispatch request one action makes: a path under `api/sn_cicd/` and its query. */
export interface CicdRunRequest {
  path: string;
  params: Record<string, string>;
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
 * failure reported only in `result.status_message`. Mirrors core.
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

function setParam(params: Record<string, string>, name: string, value: unknown): void {
  if (typeof value === "boolean") {
    params[name] = String(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    params[name] = value.trim();
  }
}

/** Thrown by {@link buildCicdRunRequest} for a missing or conflicting argument. */
export class CicdRunArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CicdRunArgumentError";
  }
}

function exactlyOne(
  action: CicdRunAction,
  params: Record<string, string>,
  names: string
): void {
  const count = Object.keys(params).length;
  if (count !== 1) {
    throw new CicdRunArgumentError(
      `${action} needs exactly one of ${names} (got ${count === 0 ? "neither" : "both"}).`
    );
  }
}

function appIdentity(action: CicdRunAction, args: JsonObject): Record<string, string> {
  const params: Record<string, string> = {};
  setParam(params, "scope", args.scope);
  setParam(params, "sys_id", args.appSysId);
  exactlyOne(action, params, "scope or appSysId");
  return params;
}

const REQUEST_BUILDERS: Record<CicdRunAction, (args: JsonObject) => CicdRunRequest> = {
  "run-suite": (args) => {
    const params: Record<string, string> = {};
    setParam(params, "test_suite_sys_id", args.suiteId);
    setParam(params, "test_suite_name", args.suiteName);
    exactlyOne("run-suite", params, "suiteId or suiteName");
    setParam(params, "browser_name", args.browserName);
    setParam(params, "browser_version", args.browserVersion);
    setParam(params, "os_name", args.osName);
    setParam(params, "os_version", args.osVersion);
    setParam(params, "run_in_cloud", args.runInCloud);
    setParam(params, "is_performance_run", args.performance);
    return { path: "testsuite/run", params };
  },
  "run-test": (args) => {
    const params: Record<string, string> = {};
    setParam(params, "test_sys_id", args.testId);
    if (!params.test_sys_id) {
      throw new CicdRunArgumentError("run-test needs testId (the sys_id of the ATF test).");
    }
    setParam(params, "run_in_cloud", args.runInCloud);
    setParam(params, "capture_node_logs", args.captureNodeLogs);
    return { path: "tests/run_test", params };
  },
  install: (args) => {
    const params = appIdentity("install", args);
    setParam(params, "version", args.appVersion);
    setParam(params, "base_app_version", args.baseAppVersion);
    setParam(params, "auto_upgrade_base_app", args.autoUpgradeBaseApp);
    return { path: "app_repo/install", params };
  },
  publish: (args) => {
    const params = appIdentity("publish", args);
    setParam(params, "version", args.appVersion);
    setParam(params, "dev_notes", args.devNotes);
    return { path: "app_repo/publish", params };
  },
  rollback: (args) => {
    const params = appIdentity("rollback", args);
    setParam(params, "version", args.appVersion);
    if (!params.version) {
      throw new CicdRunArgumentError(
        "rollback needs appVersion: the version the application should have after the rollback."
      );
    }
    return { path: "app_repo/rollback", params };
  },
};

export function isCicdRunAction(value: unknown): value is CicdRunAction {
  return typeof value === "string" && (CICD_RUN_ACTIONS as readonly string[]).includes(value);
}

/**
 * Maps one action and its arguments to the exact dispatch request — the same
 * path/parameter contract as core's `buildCicdRequest`. Pure; throws
 * {@link CicdRunArgumentError} for a missing or conflicting required argument.
 */
export function buildCicdRunRequest(action: CicdRunAction, args: JsonObject): CicdRunRequest {
  return REQUEST_BUILDERS[action](args);
}

/** `api/sn_cicd/<path>?<query>` as an `snRequest` endpoint. */
export function cicdEndpoint(path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `/api/sn_cicd/${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
}

function linkOf(result: JsonObject | undefined, link: string, key: "id" | "url"): string | undefined {
  return nonEmptyString(asObject(asObject(result?.links)?.[link])?.[key]);
}

function statusLabel(progress: JsonObject): string {
  const status = String(progress.status ?? "");
  return nonEmptyString(progress.status_label) ?? STATUS_LABELS[status] ?? `status ${status}`;
}

/** A count for the summary only; the verdict reads {@link strictAtfCount}. */
function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A count for the `reason` text, the same as core's summary `countOf`: a
 * missing count reads "0" and an unreadable one "?".
 */
function reasonCountOf(value: unknown): string {
  const n = strictAtfCount(value);
  return n === undefined ? (value === undefined ? "0" : "?") : String(n);
}

/**
 * The ATF verdict allow-list. It must stay identical to the copy in
 * `packages/core/src/cicdCommand.ts` (this package may not import core), and
 * both are table-tested against the same shapes.
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
 * pass but executed zero tests, which is not a pass and is reported `failed`
 * (the instance answered clearly, so reading it again would not change it);
 * `unknown` is a readable record that does not clearly say either, which a
 * successful tracker turns into `incomplete`.
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

/**
 * Whether a finished tracker carries the mark of an ATF run: a `links.results`
 * entry (sn_cicd links the suite or test result from an ATF tracker; the
 * app-repo trackers link none). That is the only kind evidence the tracker
 * exposes — same rule as core's `syncrona cicd`.
 */
function trackerLinksAtfResult(progress: JsonObject): boolean {
  return asObject(asObject(progress.links)?.results) !== undefined;
}

function pollIntervalOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), MIN_CICD_POLL_MS), MAX_CICD_POLL_MS)
    : DEFAULT_CICD_POLL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One deadline for the whole tool call (REV-212), charged per request. */
class Budget {
  private readonly deadline: number;
  constructor(private readonly timeoutMs: number) {
    this.deadline = Date.now() + Math.max(0, timeoutMs);
  }
  remaining(): number {
    return this.deadline - Date.now();
  }
  requestTimeout(): number {
    return Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(this.timeoutMs, this.remaining()));
  }
}

/**
 * The verdict next to the outcome, the same values as core's `cicd --json`:
 * `passed`, `failed` and `no_tests` are what the instance reported;
 * `incomplete` means the run could not be followed to its end, and `unknown`
 * that the tracker finished but its ATF result was unreadable or unclear (both
 * outcome `incomplete`, exit code 1).
 */
export type CicdRunVerdict = "passed" | "failed" | "no_tests" | "incomplete" | "unknown";

/** A step that could not produce a usable answer — outcome `incomplete`. */
class CicdRunIncomplete extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly verdict: Extract<CicdRunVerdict, "incomplete" | "unknown"> = "incomplete"
  ) {
    super(message);
    this.name = "CicdRunIncomplete";
  }
}

/**
 * Whether a request failed because its redirects looped: native fetch rejects
 * with a "redirect count exceeded" cause, axios (core) with
 * `ERR_FR_TOO_MANY_REDIRECTS`. A login gateway bouncing the request is the usual
 * source, so it is a session failure, not a missing response. Must match
 * `isRedirectLoopError` in core's `cicdCommand.ts`.
 */
function isRedirectLoopError(err: unknown): boolean {
  if (asObject(err)?.code === "ERR_FR_TOO_MANY_REDIRECTS") return true;
  const pattern = /redirect count exceeded|maximum number of redirects/i;
  const message = err instanceof Error ? err.message : "";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return pattern.test(message) || pattern.test(cause);
}

/**
 * Whether a 2xx body is an HTML page: it starts with `<`. sn_cicd only answers
 * JSON, so this is an SSO/login (or hibernation) page served in place of the
 * API. The body is the only signal (`snRequest` returns no headers), and a body
 * that parsed as JSON is a JSON answer whatever its content type said. Must
 * match `isHtmlAnswer` in core's `cicdCommand.ts`, which ignores the content
 * type for the same reason.
 */
function isHtmlBody(data: unknown): boolean {
  return typeof data === "string" && data.trimStart().startsWith("<");
}

async function cicdCall(
  method: "GET" | "POST",
  endpoint: string,
  what: string,
  budget: Budget
): Promise<JsonObject> {
  let response: Awaited<ReturnType<typeof snRequest>>;
  try {
    // Sent once, like core's axios client: the poll loop owns every retry, one
    // pollMs apart, so a persistent failure costs the same requests on both sides.
    response = await snRequest(method, endpoint, undefined, budget.requestTimeout(), undefined, {
      retryTransient: false,
    });
  } catch (err) {
    if (isRedirectLoopError(err)) {
      // Same text as core's redirectLoopError.
      throw new CicdRunIncomplete(
        `The ${what} request was redirected in a loop (too many redirects), likely a session/authentication redirect ` +
          "to a login page; check the credentials and the session. It is not retried."
      );
    }
    throw err;
  }
  if (response.status < 200 || response.status > 299) {
    const reason = extractCicdErrorMessage(response.data);
    const hint =
      response.status === 403
        ? ` Access denied by the CI/CD REST API: the user needs the ${CICD_ROLE} role (admin also passes).`
        : "";
    if (response.status >= 300 && response.status <= 399) {
      // sn_cicd answers JSON directly. fetch follows a redirect itself, so a
      // 3xx reaching here is a 304, a redirect without a Location, or one it
      // did not follow: a proxy or SSO gateway took the request, never a
      // client error. Same text as core's permanentPollReason.
      throw new CicdRunIncomplete(
        `The ${what} request answered HTTP ${response.status}, an unexpected 3xx answer: sn_cicd answers JSON directly, ` +
          "so a proxy or an SSO/login gateway in front of the instance likely intercepted the request; it is not retried.",
        response.status
      );
    }
    throw new CicdRunIncomplete(
      `The ${what} request failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}.${hint}`,
      response.status
    );
  }
  if (isHtmlBody(response.data)) {
    // Same text as core's htmlAnswerError.
    throw new CicdRunIncomplete(
      `The instance answered the ${what} request with an HTML page instead of JSON, likely a session/authentication redirect ` +
        "to a login page (or a hibernating instance); check the credentials and the session, and that the instance is awake. It is not retried.",
      response.status
    );
  }
  const result = asObject(asObject(response.data)?.result);
  if (!result) {
    throw new CicdRunIncomplete(
      `The instance answered the ${what} request without a JSON \`result\` — likely an HTML login/hibernation page or a proxy error. Confirm the instance is awake and the credentials are valid.`,
      response.status
    );
  }
  return result;
}

/**
 * Consecutive failed progress polls tolerated before the run is reported as
 * incomplete. Each poll is one request (`snRequest` does not retry it), so this
 * is the only retry, one `pollMs` apart: the same limit and the same request
 * count as core's `syncrona cicd`.
 */
export const CICD_MAX_POLL_FAILURES = 3;

/**
 * No response, 408, 425, 429 and 5xx are worth another poll (core's rule); a
 * 3xx, auth, 404, any other 4xx, non-JSON and HTML answers, and a redirect loop
 * are not.
 */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof CicdRunIncomplete) {
    const status = err.httpStatus;
    return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
  }
  return true;
}

/**
 * Polls the tracker to a terminal status within the budget. Every timeout, also
 * one reached while polls are failing transiently, ends with the same actionable
 * message as core: where to check the tracker (its own link, the dispatch
 * answer's link, or the API path) and how to resume waiting on it.
 */
async function pollProgress(
  progressId: string,
  pollMs: number,
  budget: Budget,
  timeoutMs: number,
  progressUrl?: string
): Promise<JsonObject> {
  const request = `GET api/sn_cicd/progress/${progressId}`;
  let lastProgress: JsonObject | undefined;
  const timedOut = (lastError?: unknown): CicdRunIncomplete => {
    const where = (lastProgress && linkOf(lastProgress, "progress", "url")) ?? progressUrl ?? `${request} on the instance`;
    const last = lastProgress ? statusLabel(lastProgress) : "never read";
    // The trailing period is dropped: the error is quoted inside parentheses.
    const errorText = lastError instanceof Error ? lastError.message : String(lastError);
    const error = lastError === undefined ? "" : `; last poll error: ${errorText.replace(/\.$/, "")}`;
    return new CicdRunIncomplete(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for progress ${progressId} (last status: ${last}${error}). ` +
        `The work may still be running on the instance; check it at ${where} and resume waiting with progressId ${progressId} (and a larger timeoutMs).`
    );
  };
  let failures = 0;
  for (;;) {
    let progress: JsonObject;
    try {
      progress = await cicdCall(
        "GET",
        cicdEndpoint(`progress/${encodeURIComponent(progressId)}`),
        "progress",
        budget
      );
    } catch (e) {
      failures += 1;
      const left = budget.remaining();
      if (!isTransientPollError(e)) {
        throw e;
      }
      if (left <= 0) {
        throw timedOut(e);
      }
      if (failures >= CICD_MAX_POLL_FAILURES) {
        throw e;
      }
      await sleep(Math.min(pollMs, left));
      continue;
    }
    failures = 0;
    lastProgress = progress;
    if (TERMINAL_STATUSES.has(String(progress.status ?? ""))) {
      return progress;
    }
    const left = budget.remaining();
    if (left <= 0) {
      throw timedOut();
    }
    await sleep(Math.min(pollMs, left));
  }
}

interface AtfOutcome {
  verdict: AtfVerdict;
  summary: JsonObject;
  /** Core's one-line ATF summary, the `reason` of a passing run (unfenced). */
  reasonText: string;
  url?: string;
}

/**
 * The hint for a resumed ATF tracker whose result 404s (core's wording): the
 * same action can never read it, so it names the other ATF kind and action.
 */
function atfKindMismatchHint(action: CicdRunAction, progressId: string): string {
  const [kind, path, other] =
    action === "run-test"
      ? ["a suite run rather than a single test", "tests/test/results/<id>", "run-suite"]
      : ["a single-test run rather than a suite", "testsuite/results/<id>", "run-test"];
  return `progress ${progressId} may belong to ${kind} (${action} reads ${path}); resume it with progressId ${progressId} and the ${other} action instead.`;
}

/**
 * Reads the suite or test result linked from the finished tracker. A tracker
 * that links no result, or a result that cannot be read, comes back as
 * `{ unreadable }`: the caller must not report a pass it could not see, so a
 * successful tracker then yields `incomplete` (like core's `syncrona cicd`).
 * `notFound` marks a 404 on the read: on a resume it usually means the tracker
 * belongs to the other ATF kind, which a re-read with the same action never fixes.
 */
async function fetchAtfOutcome(
  action: CicdRunAction,
  progress: JsonObject,
  budget: Budget
): Promise<AtfOutcome | { unreadable: string; notFound?: boolean }> {
  const resultId = linkOf(progress, "results", "id");
  if (!resultId) {
    return { unreadable: "the tracker links no ATF result record" };
  }
  const path =
    action === "run-suite"
      ? `testsuite/results/${encodeURIComponent(resultId)}`
      : `tests/test/results/${encodeURIComponent(resultId)}`;
  let body: JsonObject;
  try {
    body = await cicdCall("GET", cicdEndpoint(path), "ATF result", budget);
  } catch (e) {
    return {
      // The trailing period is dropped: the reason is quoted mid-sentence.
      unreadable: `ATF result ${resultId} could not be read: ${(e instanceof Error ? e.message : String(e)).replace(/\.$/, "")}`,
      notFound: e instanceof CicdRunIncomplete && e.httpStatus === 404,
    };
  }
  const url = linkOf(body, "results", "url") ?? linkOf(progress, "results", "url");
  if (action === "run-suite") {
    const passed = countOf(body.rolledup_test_success_count);
    const failed = countOf(body.rolledup_test_failure_count);
    const errored = countOf(body.rolledup_test_error_count);
    const skipped = countOf(body.rolledup_test_skip_count);
    const suiteStatus = nonEmptyString(body.test_suite_status);
    return {
      verdict: atfSuiteVerdict(body),
      // The status strings and the URL are instance-authored, like the messages.
      summary: {
        suiteStatus: suiteStatus ? wrapUntrustedData(suiteStatus, "servicenow") : null,
        passed,
        failed,
        errored,
        skipped,
      },
      reasonText:
        `${suiteStatus ? `Suite ${suiteStatus}: ` : ""}${reasonCountOf(body.rolledup_test_success_count)} passed, ` +
        `${reasonCountOf(body.rolledup_test_failure_count)} failed, ${reasonCountOf(body.rolledup_test_error_count)} errored, ` +
        `${reasonCountOf(body.rolledup_test_skip_count)} skipped`,
      url,
    };
  }
  const testStatus = nonEmptyString(body.test_status);
  return {
    verdict: atfTestVerdict(body),
    reasonText: `Test ${testStatus ?? "finished"}${nonEmptyString(body.output) ? `: ${String(body.output)}` : ""}`,
    // Step output is instance-authored free text — fence it as untrusted.
    summary: {
      testStatus: testStatus ? wrapUntrustedData(testStatus, "servicenow") : null,
      output: wrapUntrustedData(body.output, "servicenow"),
    },
    url,
  };
}

function trackerSummary(progress: JsonObject): JsonObject {
  return {
    status: String(progress.status ?? ""),
    // status_label is instance-authored text too (the fallback labels are ours).
    statusLabel: wrapUntrustedData(statusLabel(progress), "servicenow"),
    percentComplete: progress.percent_complete ?? null,
    // status_message / error / status_detail are instance-authored text.
    message: wrapUntrustedData(extractCicdErrorMessage({ result: progress }), "servicenow"),
    detail: wrapUntrustedData(progress.status_detail, "servicenow"),
  };
}

/**
 * Why an ATF tracker that failed or was cancelled before it linked a result
 * record failed — core's `endedWithoutAtfResult` text exactly, which is the
 * `reason`; the message is the same sentence, capitalized and closed. On a
 * resume it adds that an app-repo tracker would be reported under its own action.
 */
function endedWithoutAtfResult(progress: JsonObject, resumeId: string | undefined): string {
  const instanceReason = extractCicdErrorMessage({ result: progress });
  const ended =
    `the tracker ended ${statusLabel(progress)}${instanceReason ? ` (${instanceReason})` : ""} ` +
    "before linking an ATF result record, so no test results were reported";
  return resumeId
    ? `${ended}; if progress ${resumeId} is an install, publish or rollback run rather than an ATF run, resume it with that action to report it under its own name`
    : ended;
}

/** Sends the dispatch POST and returns the id (and URL) of the progress tracker it started. */
async function dispatchAction(
  action: CicdRunAction,
  endpoint: string,
  budget: Budget
): Promise<{ id: string; url?: string }> {
  const dispatched = await cicdCall("POST", endpoint, action, budget);
  const progressId = linkOf(dispatched, "progress", "id");
  if (!progressId) {
    // A 200 can still carry a rejection in the sn_cicd envelope (status "3" +
    // error); either way nothing was started, so nothing can be reported on.
    const reason = extractCicdErrorMessage({ result: dispatched });
    throw new CicdRunIncomplete(
      reason
        ? `The instance rejected ${action}: ${reason}`
        : `The instance accepted ${action} but returned no progress id to follow.`
    );
  }
  return { id: progressId, url: linkOf(dispatched, "progress", "url") };
}

/**
 * The `progressId` argument of a resume: undefined when absent, the trimmed id
 * when it is a sys_id, and a {@link CicdRunArgumentError} for anything else —
 * it is spliced into the tracker URL, so it is validated even past the schema.
 */
export function parseResumeProgressId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id = typeof value === "string" ? value.trim() : "";
  if (!PROGRESS_ID_REGEX.test(id)) {
    throw new CicdRunArgumentError(
      "progressId must be the 32-character hexadecimal sys_id of an sn_cicd progress tracker (the progressId an incomplete run returned)."
    );
  }
  return id;
}

export async function handleCicdRun(
  args: Record<string, unknown>,
  context: InsightToolContext
): Promise<ToolResponse> {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (!isCicdRunAction(action)) {
    return errorResponse(`Missing or unknown action. Expected one of: ${CICD_RUN_ACTIONS.join(" | ")}.`);
  }

  // A resume (SDK-F7) polls an existing tracker and dispatches nothing, so it
  // neither builds a dispatch request nor needs confirmDestructive=true.
  let resumeId: string | undefined;
  let request: CicdRunRequest;
  try {
    resumeId = parseResumeProgressId(args.progressId);
    request = resumeId
      ? { path: `progress/${encodeURIComponent(resumeId)}`, params: {} }
      : buildCicdRunRequest(action, args);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
  const method = resumeId ? "GET" : "POST";

  // Every action changes the instance: install/publish/rollback rewrite the
  // application, and an ATF run executes tests and writes their results. Same
  // confirmDestructive / dryRun / audit contract as sync_run_atf_tests.
  if (!resumeId && args.confirmDestructive !== true) {
    return errorResponse(
      `sync_cicd_run ${action} dispatches work on the instance through the CI/CD API. Re-run with confirmDestructive=true.`
    );
  }

  const endpoint = cicdEndpoint(request.path, request.params);
  if (context.dryRun) {
    return context.makeDryRunAuditResponse(TOOL_NAME, args, {
      action,
      method,
      endpoint,
      ...(resumeId ? { resume: true, progressId: resumeId } : { params: request.params }),
    });
  }

  const budget = new Budget(context.timeoutMs);
  const pollMs = pollIntervalOf(args.pollMs);
  let outcome: CicdRunOutcome = "incomplete";
  let verdict: CicdRunVerdict = "incomplete";
  let progressId: string | undefined = resumeId;
  let progress: JsonObject | undefined;
  let atf: AtfOutcome | undefined;
  let message: string | undefined;
  let reason = "";
  let httpStatus: number | undefined;

  try {
    const tracker = resumeId ? { id: resumeId } : await dispatchAction(action, endpoint, budget);
    progressId = tracker.id;
    if (!resumeId) {
      // The dispatch is audited before polling: a poll that outlives the MCP
      // call, or a crash, must not leave dispatched work without an audit line.
      context.auditMutatingTool(
        TOOL_NAME,
        args,
        { action, phase: "dispatched", method, path: request.path, progressId },
        Date.now() - context.startedAt
      );
    }
    progress = await pollProgress(progressId, pollMs, budget, context.timeoutMs, tracker.url);
    const trackerSucceeded = String(progress.status) === STATUS_SUCCESSFUL;
    const isAtfAction = action === "run-suite" || action === "run-test";
    if (resumeId && !isAtfAction && trackerLinksAtfResult(progress)) {
      // A resume takes the action on the caller's word. A tracker that links an
      // ATF result is a test run, so reporting it as an app-repo action would
      // skip the test verdict — whatever its status.
      throw new CicdRunIncomplete(
        `progress ${progressId} links an ATF result, so it looks like a test run rather than ${action}. Resume it with the run-suite or run-test action to read the test verdict.`
      );
    }
    // The other direction: an app-repo tracker resumed as an ATF action links no
    // result. Only a SUCCESSFUL one is refused (it must not read as a pass): an
    // ATF run cancelled or failed before it linked its result looks exactly like
    // a failed app-repo run, and a dispatched one in that state is `failed`, so a
    // resume of it is too — reported as a run that ended before any test result.
    const atfWithoutResult = isAtfAction && !trackerLinksAtfResult(progress);
    if (resumeId && atfWithoutResult && trackerSucceeded) {
      throw new CicdRunIncomplete(
        `progress ${progressId} links no ATF result record, so it looks like an app-repo run rather than ${action} (it ended ${statusLabel(progress)}). Resume it with the install, publish or rollback action that started it; it does not say whether any tests passed.`
      );
    }
    if (isAtfAction) {
      const read = await fetchAtfOutcome(action, progress, budget);
      if ("unreadable" in read) {
        if (trackerSucceeded) {
          throw new CicdRunIncomplete(
            `progress ${progressId} finished, but ${read.unreadable}, so whether the tests passed is unknown. ` +
              (resumeId && read.notFound
                ? atfKindMismatchHint(action, progressId)
                : `Resume with progressId ${progressId} to read the result again.`),
            undefined,
            "unknown"
          );
        }
      } else {
        atf = read;
        if (trackerSucceeded && read.verdict === "unknown") {
          throw new CicdRunIncomplete(
            `progress ${progressId} finished, but the ATF result does not clearly report a pass or a failure, so whether the tests passed is unknown. Resume with progressId ${progressId} to read the result again.`,
            undefined,
            "unknown"
          );
        }
      }
    }
    const succeeded = trackerSucceeded && (!isAtfAction || atf?.verdict === "passed");
    outcome = succeeded ? "succeeded" : "failed";
    verdict = succeeded
      ? "passed"
      : trackerSucceeded && atf?.verdict === "no_tests"
        ? "no_tests"
        : "failed";
    const instanceReason = extractCicdErrorMessage({ result: progress });
    // Core's `reason`, value for value, set in the same branches as core's.
    if (succeeded) {
      reason = atf?.reasonText ?? `the tracker ended ${statusLabel(progress)}`;
    } else if (!trackerSucceeded && atfWithoutResult) {
      reason = endedWithoutAtfResult(progress, resumeId);
    } else {
      reason =
        instanceReason ??
        (!trackerSucceeded
          ? statusLabel(progress)
          : verdict === "no_tests"
            ? "the suite ran no tests, which is not a pass"
            : "ATF reported failing tests");
    }
    if (!succeeded && trackerSucceeded) {
      message =
        atf?.verdict === "no_tests"
          ? "The suite ran no tests (0 passed, 0 failed, 0 errored), which is not a pass."
          : "ATF reported failing tests.";
    } else if (!trackerSucceeded && atfWithoutResult) {
      message = `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
    } else if (succeeded && resumeId && !isAtfAction) {
      message = `The tracker does not record which app-repo action started it; reported as ${action} on the caller's word.`;
    }
  } catch (e) {
    outcome = "incomplete";
    verdict = e instanceof CicdRunIncomplete ? e.verdict : "incomplete";
    message = e instanceof Error ? e.message : String(e);
    // Core's reason for a run it could not finish is its error text.
    reason = message;
    httpStatus = e instanceof CicdRunIncomplete ? e.httpStatus : undefined;
  }

  const exitCode = CICD_RUN_OUTCOMES[outcome];
  const resultsUrl = atf?.url ?? (progress ? linkOf(progress, "results", "url") : undefined);

  context.auditMutatingTool(
    TOOL_NAME,
    args,
    {
      action,
      phase: "finished",
      // A resume is recorded as such, so the audit trail never reads a poll as
      // a second dispatch of the same work.
      ...(resumeId ? { resumed: true } : {}),
      method,
      path: request.path,
      outcome,
      exitCode,
      progressId: progressId ?? null,
      trackerStatus: progress ? String(progress.status ?? "") : null,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    },
    Date.now() - context.startedAt
  );

  return textResponse(
    {
      action,
      outcome,
      exitCode,
      verdict,
      // Core's `cicd --json` reason; it can quote the instance, so it is fenced.
      reason: wrapUntrustedData(reason, "servicenow"),
      ...(resumeId ? { resumed: true } : {}),
      request: { method, path: `api/sn_cicd/${request.path}`, params: request.params },
      progressId: progressId ?? null,
      tracker: progress ? trackerSummary(progress) : null,
      ...(atf ? { atf: atf.summary } : {}),
      // The URL comes from the instance's answer, so it is fenced like the text.
      ...(resultsUrl ? { resultsUrl: wrapUntrustedData(resultsUrl, "servicenow") } : {}),
      // Messages can quote the instance's error envelope, so they are fenced too.
      ...(message ? { message: wrapUntrustedData(message, "servicenow") } : {}),
    },
    outcome !== "succeeded"
  );
}
