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

function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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

/** A step that could not produce a usable answer — outcome `incomplete`. */
class CicdRunIncomplete extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "CicdRunIncomplete";
  }
}

async function cicdCall(
  method: "GET" | "POST",
  endpoint: string,
  what: string,
  budget: Budget
): Promise<JsonObject> {
  const response = await snRequest(method, endpoint, undefined, budget.requestTimeout());
  if (response.status < 200 || response.status > 299) {
    const reason = extractCicdErrorMessage(response.data);
    const hint =
      response.status === 403
        ? ` Access denied by the CI/CD REST API: the user needs the ${CICD_ROLE} role (admin also passes).`
        : "";
    throw new CicdRunIncomplete(
      `The ${what} request failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}.${hint}`,
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

async function pollProgress(
  progressId: string,
  pollMs: number,
  budget: Budget
): Promise<JsonObject> {
  for (;;) {
    const progress = await cicdCall(
      "GET",
      cicdEndpoint(`progress/${encodeURIComponent(progressId)}`),
      "progress",
      budget
    );
    if (TERMINAL_STATUSES.has(String(progress.status ?? ""))) {
      return progress;
    }
    const left = budget.remaining();
    if (left <= 0) {
      throw new CicdRunIncomplete(
        `Timed out waiting for progress ${progressId} (last status: ${statusLabel(progress)}). The work may still be running on the instance.`
      );
    }
    await sleep(Math.min(pollMs, left));
  }
}

interface AtfOutcome {
  failed: boolean;
  summary: JsonObject;
  url?: string;
}

/**
 * Reads the suite or test result linked from the finished tracker. Best effort,
 * like core: the tracker is already terminal, so a failed read degrades to the
 * tracker's own verdict instead of turning the outcome into `incomplete`.
 */
async function fetchAtfOutcome(
  action: CicdRunAction,
  progress: JsonObject,
  budget: Budget
): Promise<AtfOutcome | undefined> {
  const resultId = linkOf(progress, "results", "id");
  if (!resultId) {
    return undefined;
  }
  const path =
    action === "run-suite"
      ? `testsuite/results/${encodeURIComponent(resultId)}`
      : `tests/test/results/${encodeURIComponent(resultId)}`;
  let body: JsonObject;
  try {
    body = await cicdCall("GET", cicdEndpoint(path), "ATF result", budget);
  } catch (_) {
    return undefined;
  }
  const url = linkOf(body, "results", "url") ?? linkOf(progress, "results", "url");
  if (action === "run-suite") {
    const passed = countOf(body.rolledup_test_success_count);
    const failed = countOf(body.rolledup_test_failure_count);
    const errored = countOf(body.rolledup_test_error_count);
    const skipped = countOf(body.rolledup_test_skip_count);
    const suiteStatus = nonEmptyString(body.test_suite_status);
    return {
      failed: failed + errored > 0 || /^(failure|error)$/i.test(suiteStatus ?? ""),
      summary: { suiteStatus: suiteStatus ?? null, passed, failed, errored, skipped },
      url,
    };
  }
  const testStatus = nonEmptyString(body.test_status);
  return {
    failed: /^(failure|error)$/i.test(testStatus ?? ""),
    // Step output is instance-authored free text — fence it as untrusted.
    summary: { testStatus: testStatus ?? null, output: wrapUntrustedData(body.output, "servicenow") },
    url,
  };
}

function trackerSummary(progress: JsonObject): JsonObject {
  return {
    status: String(progress.status ?? ""),
    statusLabel: statusLabel(progress),
    percentComplete: progress.percent_complete ?? null,
    // status_message / error / status_detail are instance-authored text.
    message: wrapUntrustedData(extractCicdErrorMessage({ result: progress }), "servicenow"),
    detail: wrapUntrustedData(progress.status_detail, "servicenow"),
  };
}

export async function handleCicdRun(
  args: Record<string, unknown>,
  context: InsightToolContext
): Promise<ToolResponse> {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (!isCicdRunAction(action)) {
    return errorResponse(`Missing or unknown action. Expected one of: ${CICD_RUN_ACTIONS.join(" | ")}.`);
  }

  let request: CicdRunRequest;
  try {
    request = buildCicdRunRequest(action, args);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }

  // Every action changes the instance: install/publish/rollback rewrite the
  // application, and an ATF run executes tests and writes their results. Same
  // confirmDestructive / dryRun / audit contract as sync_run_atf_tests.
  if (args.confirmDestructive !== true) {
    return errorResponse(
      `sync_cicd_run ${action} dispatches work on the instance through the CI/CD API. Re-run with confirmDestructive=true.`
    );
  }

  const endpoint = cicdEndpoint(request.path, request.params);
  if (context.dryRun) {
    return context.makeDryRunAuditResponse(TOOL_NAME, args, {
      action,
      method: "POST",
      endpoint,
      params: request.params,
    });
  }

  const budget = new Budget(context.timeoutMs);
  const pollMs = pollIntervalOf(args.pollMs);
  let outcome: CicdRunOutcome = "incomplete";
  let progressId: string | undefined;
  let progress: JsonObject | undefined;
  let atf: AtfOutcome | undefined;
  let message: string | undefined;
  let httpStatus: number | undefined;

  try {
    const dispatched = await cicdCall("POST", endpoint, action, budget);
    progressId = linkOf(dispatched, "progress", "id");
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
    progress = await pollProgress(progressId, pollMs, budget);
    if (action === "run-suite" || action === "run-test") {
      atf = await fetchAtfOutcome(action, progress, budget);
    }
    const succeeded = String(progress.status) === STATUS_SUCCESSFUL && atf?.failed !== true;
    outcome = succeeded ? "succeeded" : "failed";
    if (!succeeded && String(progress.status) === STATUS_SUCCESSFUL) {
      message = "ATF reported failing tests.";
    }
  } catch (e) {
    outcome = "incomplete";
    message = e instanceof Error ? e.message : String(e);
    httpStatus = e instanceof CicdRunIncomplete ? e.httpStatus : undefined;
  }

  const exitCode = CICD_RUN_OUTCOMES[outcome];
  const resultsUrl = atf?.url ?? (progress ? linkOf(progress, "results", "url") : undefined);

  context.auditMutatingTool(
    TOOL_NAME,
    args,
    {
      action,
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
      request: { method: "POST", path: `api/sn_cicd/${request.path}`, params: request.params },
      progressId: progressId ?? null,
      tracker: progress ? trackerSummary(progress) : null,
      ...(atf ? { atf: atf.summary } : {}),
      ...(resultsUrl ? { resultsUrl } : {}),
      // Messages can quote the instance's error envelope, so they are fenced too.
      ...(message ? { message: wrapUntrustedData(message, "servicenow") } : {}),
    },
    outcome !== "succeeded"
  );
}
