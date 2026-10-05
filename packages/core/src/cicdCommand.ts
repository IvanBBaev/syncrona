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
 *   "did it pass?" is unknown.
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
 */
import type { Sync } from "@syncrona/types";
import type { AxiosResponse } from "axios";
import { logger } from "./Logger.js";
import { setLogLevel, logErrorHint, resolveInstanceProfile } from "./commandHelpers.js";
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
export class CicdCliError extends Error {
  constructor(message: string) {
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

/** A positive finite number, or the fallback. */
function positiveOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `result` of an sn_cicd response, or an error saying the body was not one. */
function resultOf(response: AxiosResponse<unknown>, what: string): JsonObject {
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

/** Polls the tracker until a terminal status; throws {@link CicdCliError} on timeout. */
async function pollProgress(
  deps: CicdCommandDeps,
  client: CicdClient,
  progressId: string,
  pollMs: number,
  timeoutMs: number
): Promise<JsonObject> {
  const startedAt = deps.now();
  let lastStatus: string | undefined;
  for (;;) {
    const progress = resultOf(
      await client.cicdGet(`progress/${encodeURIComponent(progressId)}`),
      "progress"
    );
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
      throw new CicdCliError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for progress ${progressId} (last status: ${statusLabel(progress)}). The work may still be running on the instance.`
      );
    }
    await deps.sleep(pollMs);
  }
}

/** What the linked ATF result record says, when there is one to read. */
interface AtfOutcome {
  body: JsonObject;
  failed: boolean;
  summary: string;
  url?: string;
}

function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reads the suite or test result linked from the finished tracker. Best effort:
 * the tracker is already terminal, so a failed fetch degrades to the tracker's
 * own verdict (logged at debug) rather than turning into exit 1.
 */
async function fetchAtfOutcome(
  client: CicdClient,
  action: CicdAction,
  progress: JsonObject
): Promise<AtfOutcome | undefined> {
  const resultId = linkId(progress, "results");
  if (!resultId) {
    return undefined;
  }
  const path =
    action === "run-suite"
      ? `testsuite/results/${encodeURIComponent(resultId)}`
      : `tests/test/results/${encodeURIComponent(resultId)}`;
  let body: JsonObject;
  try {
    body = resultOf(await client.cicdGet(path), "ATF result");
  } catch (e) {
    logger.debug(
      `Could not fetch ATF result ${resultId}: ${extractCicdErrorMessage(errorResponseBody(e)) ?? (e instanceof Error ? e.message : String(e))}`
    );
    return undefined;
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
      failed: failed + errored > 0 || /^(failure|error)$/i.test(suiteStatus ?? ""),
      summary: `${suiteStatus ? `Suite ${suiteStatus}: ` : ""}${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped`,
      url,
    };
  }
  const testStatus = nonEmptyString(body.test_status);
  return {
    body,
    failed: /^(failure|error)$/i.test(testStatus ?? ""),
    summary: `Test ${testStatus ?? "finished"}${nonEmptyString(body.output) ? `: ${String(body.output)}` : ""}`,
    url,
  };
}

/** Runs one action end to end and returns its exit code. */
async function runAction(
  deps: CicdCommandDeps,
  action: CicdAction,
  args: CicdCmdArgs,
  profile: string | undefined
): Promise<CicdExitCode> {
  const request = buildCicdRequest(action, args);
  const pollMs = positiveOr(args.pollMs, DEFAULT_POLL_MS);
  const timeoutMs = positiveOr(args.timeout, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const client = deps.createClient(profile);

  logger.info(`POST api/sn_cicd/${request.path}`);
  const dispatched = resultOf(await client.cicdPost(request.path, request.params), action);
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

  const progress = await pollProgress(deps, client, progressId, pollMs, timeoutMs);
  const status = String(progress.status);
  const atf =
    action === "run-suite" || action === "run-test"
      ? await fetchAtfOutcome(client, action, progress)
      : undefined;
  const succeeded = status === CicdProgressStatus.SUCCESSFUL && atf?.failed !== true;
  const exitCode: CicdExitCode = succeeded ? CICD_EXIT_SUCCESS : CICD_EXIT_FAILED;
  const resultsUrl = atf?.url ?? linkUrl(progress, "results");

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "cicd",
          action,
          exitCode,
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
    (atf.failed ? logger.warn : logger.info).call(logger, atf.summary);
  }
  if (resultsUrl) {
    logger.info(`Details: ${resultsUrl}`);
  }
  if (succeeded) {
    logger.success(`cicd ${action} completed successfully. ✅`);
  } else {
    const reason =
      extractCicdErrorMessage({ result: progress }) ??
      (status === CicdProgressStatus.SUCCESSFUL ? "ATF reported failing tests" : statusLabel(progress));
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

  if (!(CICD_ACTIONS as readonly string[]).includes(action)) {
    logger.error(
      `Unknown cicd subcommand "${args.action ?? ""}". Expected one of: ${CICD_ACTIONS.join(" | ")}.`
    );
    process.exitCode = CICD_EXIT_INCOMPLETE;
    return;
  }

  try {
    process.exitCode = await runAction(deps, action, args, profile);
  } catch (e) {
    const instanceMessage = extractCicdErrorMessage(errorResponseBody(e));
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      instanceMessage
        ? `cicd ${action} failed: ${message} — ${instanceMessage}`
        : `cicd ${action} failed: ${message || "unknown error"}`
    );
    // The original error goes to the taxonomy, so a 403 on an sn_cicd URL gets
    // the missing-role hint instead of the generic "re-run login" one.
    logErrorHint(e);
    process.exitCode = CICD_EXIT_INCOMPLETE;
  }
}
