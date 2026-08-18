// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The sweep orchestrator — `mirror sync` as one function (WP-M8, §5.13).
 *
 * Everything below this line already exists as a stage with its own contract:
 * Catalog (§5.3), Planner (§4.5/§4.7), Fetcher (§5.6), the serialize+redact
 * pipeline (§5.7, INV-3), Writer and shard store (§5.8, INV-4), checkpoint
 * (§4.7), and the ReportGenerator (§4.4, R1/R3). This module owns the ORDER in
 * which they run and the hand-offs between them, and deliberately nothing else:
 * it computes no hash, renders no bytes, resolves no record name, and grades no
 * fetch outcome — every judgement call is delegated to the stage whose contract
 * already states it, so there is exactly one authority per question.
 *
 * Nothing here is ambient. The clock arrives as `now(): string`, the sweep id as
 * `newSweepId()`, the filesystem as `WriterFs`, and the transport as either a
 * constructed client or the raw material for one — so the same run is replayable
 * in a test byte for byte (INV-1), and this file contains no `Date.now`, no
 * `Math.random`, no `new Date` and no `node:fs`. Authentication arrives as a
 * READY `Authorization` header value (or a provider returning one): INV-2 makes
 * the OAuth token POST unrepresentable in this package, so acquiring or
 * refreshing a credential is the caller's job (WP-M9), surfaced here only as the
 * injected `refreshAuth` hook the Fetcher already defines for F2.
 *
 * Decisions this module owns, each with its reason:
 *
 * - **One `fetchSweep` call per planned table.** The Fetcher has no per-table
 *   lifecycle hook — it grades a table only when `fetchSweep` returns — while the
 *   Writer needs a verdict per table: `completeTable()` for a complete sweep,
 *   `abandon()` for anything less. Calling the Fetcher with single-table plans
 *   puts the verdict in hand exactly when the table's writer must be closed. The
 *   F2 refresh budget, which the Fetcher scopes per call, is re-scoped per RUN by
 *   a once-latch around the injected hook — otherwise a revoked credential would
 *   buy one refresh per table across the whole plan, the exact flood
 *   `createAuthRefresher` exists to prevent.
 *
 * - **`completeTable()` only for a `complete` fetch outcome.** Completing a
 *   partial sweep would flush shards claiming INV-4 evidence the walk does not
 *   have, and for a full sweep would mint deletion authority over records the
 *   credential merely could not see (INV-5). An abandoned table's records stay on
 *   disk unclaimed — correct bytes, refetched byte-identically next run (INV-1),
 *   never a deletion candidate.
 *
 * - **A resumed run restarts the interrupted table from row one.** The
 *   checkpoint records a mid-table cursor and the Fetcher accepts one
 *   (`resumeCursors`), but this orchestrator deliberately does not pass it: the
 *   Writer's full-mode flush claims exactly what the sweep OBSERVED, and rows
 *   written before the interruption live in an abandoned writer's memory, not in
 *   any shard — so a cursor resume would flush a shard set that omits them, an R2
 *   false claim and an INV-5 hazard in one file. Completed tables are still
 *   skipped, which is the bulk of the win; cursor-level resume within a table is
 *   left for the day a writer seam can recover pre-cursor entries from the tree
 *   (WP-M10 territory, alongside `mirror repair`).
 *
 * - **Row scope comes from `sys_scope`, resolved through a name index.** Rows
 *   arrive with `sysparm_exclude_reference_link=true`, so `sys_scope` is a raw
 *   sys_id; the tree needs the scope NAME (§3). The index is paged once from
 *   `sys_scope` per run. A row without the column falls back to its table's own
 *   scope (`sys_db_object.sys_scope`, carried by the catalog), then to `global` —
 *   the scope every unscoped artifact actually lives in. If the index itself
 *   cannot be read for a non-fatal reason (say the credential lacks `sys_scope`
 *   read), every unresolvable sys_id maps to `global`: misfiled-but-present beats
 *   absent, and the tree self-corrects on the first run with a working index.
 *
 * - **Both reports are written on EVERY outcome, fatal included** (R1: the exit
 *   code is the report's own `exitCode`, derived once in `buildCoverageReport`
 *   and never re-derived here). Even a catalog-phase fatal — where no table was
 *   ever planned — produces a `coverage.json` and a `MIRROR-REPORT.md`, built
 *   from an empty plan minted through the real Planner so the mode/sweep-id
 *   derivation has one implementation. F2/F8 leave no coverage row by design;
 *   the taxonomy's honest signal is exit 1 with the fatal class named.
 *
 * - **The checkpoint is cleared only on a run that reached its own end** (exit 0
 *   or 2). A run's table-level failures are recorded in coverage; the next run is
 *   a fresh sweep. On a fatal (exit 1) the sink is flushed instead, so the next
 *   run can skip every table this one completed.
 *
 * - **Row-level parse failures are `notDecomposed`, not a downgrade** (D8/F6).
 *   The serializer stores an unparseable value whole under its `raw:` marker —
 *   the record is mirrored, wholly, just not decomposed — so the coverage row
 *   stays `complete` and names the fields as opaque blobs. A THROWN parse error
 *   mid-walk (garbled transport, F4's cousin) still grades the table
 *   `partial`/`parse-failure` through the Fetcher's taxonomy.
 *
 * - **Post-quiescence re-reads run only after a clean sweep** (D1). Quiescence
 *   is proven, never assumed: a fatal run gets no post readings, so
 *   `evaluateQuiescence` answers `null` (not checked) rather than a fabricated
 *   verdict. If the instance dies DURING the re-read (auth/unreachable/
 *   hibernating — the classes `getAggregate` refuses to swallow), the run turns
 *   fatal: the operator asked for verification and the run could not perform it,
 *   and `quiescent: null` beside the fatal class says exactly that.
 *
 * - **Δ3: the mirror never runs `git commit` in Phase 1.** The suggested commit
 *   message (D10 trailers included) is RETURNED, built by the pure
 *   `buildMirrorCommitMessage` from evidence this run actually holds: a table is
 *   "changed" when a record write reported `written`, a collision forced a
 *   rename, or a shard file was rewritten — all byte-level facts, no git
 *   consulted, zero git activity outside anything ever.
 *
 * Deliberate seams, absent by design:
 * - WP-M9 owns the CLI: flag parsing, credential-store lookup, header refresh —
 *   all of it arrives here pre-digested through {@link RunMirrorCommandOptions}.
 * - WP-M10 owns the Reconciler. `TableCompletion.authority` (INV-5's evidence
 *   object) is accepted from the Writer and NEVER acted on here: this module
 *   performs no deletion whatsoever, and reconcile-mode deletion authority lands
 *   with WP-M10.
 * - WP-M11 owns `mirror status` / `mirror verify`; nothing here answers them.
 * - WP-M12 owns derived views and attachments; the sweep leaves both untouched.
 */
import { CatalogService, type CatalogBuildResult, type CatalogSource } from "./catalog/catalogService";
import {
  SweepCheckpointSink,
  checkpointForPlan,
  clearCheckpoint,
  decideResume,
  readCheckpoint,
  remainingTables,
  type ResumeDecision,
} from "./checkpoint";
import type {
  CoverageReason,
  CoverageReport,
  MirrorConfig,
  MirrorFailureClass,
  MirrorFetch,
  QuiescenceReading,
  TableCatalogEntry,
  TableCoverage,
} from "./contracts";
import { generateDerivedViews } from "./derived/derivedViews";
import { MirrorHttpClient, MirrorHttpError } from "./http/client";
import { compareBytewise } from "./order";
import { serializeAndRedact } from "./pipeline";
import { buildMirrorCommitMessage } from "./report/commitMetadata";
import { buildCoverageReport, writeCoverageReport, writeMirrorReport } from "./report/coverageReport";
import { listScopesWithShards, loadShardSet } from "./shards/shardStore";
import { fetchSweep, type FetchFatal, type FetchRowSink, type TableFetchOutcome } from "./sync/fetcher";
import { loadShardStates, planSync, type PlanResult } from "./sync/planner";
import { reconcileSweep, type TableSweepEvidence } from "./sync/reconciler";
import type { WriterFs } from "./write/fs";
import { MirrorWriter, type TableSweepWriter } from "./write/writer";

/**
 * The transport surface a sweep needs — pages and aggregates, nothing else.
 *
 * Structurally identical to {@link CatalogSource} on purpose: the catalog build,
 * the scope-name index, the row walk and the D1 re-read are all GETs through the
 * same two methods, so one narrow type serves every stage and a test can drive
 * the whole run from a stub. `MirrorHttpClient` satisfies it without
 * implementing anything.
 */
export type MirrorSweepClient = CatalogSource;

/**
 * The raw material for a client, for callers that do not construct one.
 *
 * `authorization` is a READY header value or a provider returning one — never a
 * credential to exchange. A provider is read once, at construction: keeping a
 * header fresh across a long run is WP-M9's job, done by passing a constructed
 * client whose transport it controls.
 */
export interface MirrorTransportOptions {
  /** Instance host (`dev12345.service-now.com`) or a full base URL. */
  instance: string;
  /** The `Authorization` header value, ready to send (INV-2). */
  authorization: string | (() => string);
  /** The fetch seam; defaults to the platform's native fetch. */
  fetch?: MirrorFetch;
  /** Total attempts per request, first try included. */
  maxAttempts?: number;
  /** Per-request deadline in milliseconds; 0 disables the deadline. */
  timeoutMs?: number;
  /** Injected for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Everything one `mirror sync` run needs. All ambient state arrives here. */
export interface RunMirrorCommandOptions {
  /** Effective configuration, already validated by `loadMirrorConfig`. */
  config: MirrorConfig;
  /** Absolute native path of the mirror repository root. */
  root: string;
  /** Filesystem seam — the only way this run touches a disk. */
  fs: WriterFs;
  /** Clock seam: the current instant as an ISO-8601 string. */
  now: () => string;
  /** Sweep-id seam — injected so a run is reproducible in a test. */
  newSweepId: () => string;
  /** A constructed transport. Exactly one of `client` / `transport` is required. */
  client?: MirrorSweepClient;
  /** Or the material to construct one from. */
  transport?: MirrorTransportOptions;
  /** `--full` — force a sweep of every included table (§5.13). */
  full?: boolean;
  /** `--verify-quiescent` — D1's pre/post Aggregate readings and verdict. */
  verifyQuiescent?: boolean;
  /**
   * How many syncs have run against this mirror including this one, 1-based.
   * Drives the §5.4 reconcile promotion. The count lives in the caller's state
   * (WP-M9/M10); absent, this run counts as the first and never promotes.
   */
  syncOrdinal?: number;
  /**
   * F2's single remedy, budgeted ONCE PER RUN here (the Fetcher's own budget is
   * per call, and this module calls it once per table). The hook re-acquires the
   * credential OUTSIDE this package — INV-2 — and reports whether it worked.
   */
  refreshAuth?: () => Promise<boolean>;
  /** Checkpoint write cadence in records; defaults to the sink's own default. */
  checkpointFlushEvery?: number;
}

/** What one `mirror sync` run produced. */
export interface RunMirrorResult {
  /** R1, verbatim from the report — never re-derived here. */
  exitCode: CoverageReport["exitCode"];
  /** The report that was written to `coverage.json` and rendered to Markdown. */
  report: CoverageReport;
  /**
   * The SUGGESTED commit message (D10). Δ3: Phase 1 never runs `git commit`;
   * the caller decides whether and when this text meets a repository.
   */
  commitMessage: string;
  /** The failure that ended the run, `null` when the sweep reached its own end. */
  fatal: FetchFatal | null;
  /**
   * What the checkpoint allowed this run to skip, in full (R3: a partially
   * applicable resume is a fact, not a silence). `null` when the run failed
   * before a plan existed.
   */
  resumeDecision: ResumeDecision | null;
  /** Whether the checkpoint was cleared — true exactly when `fatal` is null. */
  checkpointCleared: boolean;
}

/** The failure classes that end a run rather than degrade a table (F2/F4/F8). */
const RUN_FATAL_CLASSES: ReadonlySet<MirrorFailureClass> = new Set([
  "auth",
  "unreachable",
  "hibernating",
  "local-io",
]);

/**
 * D4's tri-state as three distinct sentences (§10) — the same wording the
 * Fetcher uses, restated here for fatals raised OUTSIDE a fetch (catalog build,
 * scope index, D1 re-read, a writer flush). Three failures that all look like
 * "no data came back" have three different remedies, and a merged message sends
 * the operator to debug the wrong one.
 */
function diagnosisFor(failureClass: MirrorFailureClass): string {
  switch (failureClass) {
    case "auth":
      return "auth failed";
    case "unreachable":
      return "instance unreachable";
    case "hibernating":
      return "instance hibernating (wake it at developer.servicenow.com)";
    default:
      return `sweep stopped (${failureClass})`;
  }
}

/** Shape an arbitrary throw into the run-fatal record, F8 by default. */
function fatalFromError(table: string | null, error: unknown): FetchFatal {
  const failureClass: MirrorFailureClass =
    error instanceof MirrorHttpError ? error.failureClass : "local-io";
  return {
    table,
    failureClass,
    diagnosis: diagnosisFor(failureClass),
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Re-scope the injected F2 hook from per-`fetchSweep`-call to per-run.
 *
 * The Fetcher budgets one refresh per call; this module makes one call per
 * table. Without this latch a revoked credential would buy one refresh attempt
 * per table across the whole plan — the flood the budget exists to prevent.
 */
function oncePerRun(
  inner: (() => Promise<boolean>) | undefined
): (() => Promise<boolean>) | undefined {
  if (inner === undefined) {
    return undefined;
  }
  let spent = false;
  return async () => {
    if (spent) {
      return false;
    }
    spent = true;
    return inner();
  };
}

/**
 * Planner verdicts that become `skipped` coverage rows, with their reasons.
 *
 * Restated rather than read off `TablePlanDecision.reason` so the mapping is
 * exhaustive by type: the decision's `reason` is nullable in the contract, and
 * a `skipped` row without a reason is exactly what R3 forbids.
 */
const SKIP_REASON: Record<"excluded-config" | "excluded-tier" | "acl-denied", CoverageReason> = {
  "excluded-config": "excluded-config",
  "excluded-tier": "excluded-tier",
  "acl-denied": "acl-403",
};

/**
 * Page the scope-name index off `sys_scope`: sys_id → scope name.
 *
 * §3 puts the scope NAME in the tree; rows carry the scope's sys_id (reference
 * values arrive raw under `sysparm_exclude_reference_link=true`). One paged read
 * per run, through the same client as everything else.
 */
async function buildScopeNameIndex(client: MirrorSweepClient): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await client.getPage("sys_scope", cursor, { fields: ["scope", "sys_id"] });
    for (const row of page.rows) {
      const sysId = row.sys_id;
      const name = row.scope;
      if (typeof sysId === "string" && sysId !== "" && typeof name === "string" && name !== "") {
        index.set(sysId, name);
      }
    }
    if (page.done || page.lastSysId === null) {
      return index;
    }
    cursor = page.lastSysId;
  }
}

/**
 * The scope directory one row belongs in.
 *
 * The row's own `sys_scope` wins; a table whose schema has no such column (audit
 * tables and friends) falls back to the scope the TABLE is defined in, which the
 * catalog carries per §5.3; and anything unresolvable lands in `global` — the
 * scope every unscoped artifact genuinely lives in. Never a throw: a record with
 * an odd scope reference is still a record the tree must hold.
 */
function scopeNameFor(
  row: Record<string, string>,
  entry: TableCatalogEntry,
  tableScopeSysIds: Readonly<Record<string, string>>,
  index: ReadonlyMap<string, string>
): string {
  const own = row.sys_scope;
  if (typeof own === "string" && own !== "") {
    return index.get(own) ?? "global";
  }
  const tableScope = tableScopeSysIds[entry.name];
  if (tableScope !== undefined && tableScope !== "") {
    return index.get(tableScope) ?? "global";
  }
  return "global";
}

/**
 * The display name the Writer's resolver starts from.
 *
 * First non-empty of the fields ServiceNow itself displays records by, in
 * specificity order. An empty result is fine: the resolver's admission theorem
 * guarantees every record a containable name (falling back to its sys_id), so
 * this function informs the name, it does not have to guarantee one.
 */
const DISPLAY_NAME_FIELDS: readonly string[] = ["sys_name", "name", "label", "file_name", "value"];

function displayNameFor(row: Record<string, string>): string {
  for (const field of DISPLAY_NAME_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return "";
}

/** `sys_mod_count` as a number; anything unparseable counts as zero. */
function parseModCount(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How many records the shard sets on disk claim for one table.
 *
 * Used for the coverage row of a table a RESUMED run skipped: this run wrote
 * nothing to it, but the table is complete on disk and R3 wants its fate stated.
 * The count is read from the shard index the interrupted run flushed — the same
 * sweep, by id — rather than invented from the catalog's aggregate.
 */
async function countShardRecords(fs: WriterFs, root: string, table: string): Promise<number> {
  let total = 0;
  for (const scope of await listScopesWithShards(fs, root, table)) {
    const set = await loadShardSet(fs, root, scope, table);
    total += set.entries.size;
  }
  return total;
}

/** Per-table accumulator the row sink fills while the Fetcher walks. */
interface TableRunState {
  written: number;
  changed: boolean;
  notDecomposed: Set<string>;
}

/**
 * The coverage row for a fetched table, or `null` when the taxonomy says the
 * honest signal is no row at all (F2/F8: `reason` absent on a failed outcome).
 */
function coverageRowFor(outcome: TableFetchOutcome, state: TableRunState): TableCoverage | null {
  const notDecomposed =
    state.notDecomposed.size > 0
      ? { notDecomposed: [...state.notDecomposed].sort(compareBytewise) }
      : {};
  if (outcome.status === "complete") {
    return {
      status: "complete",
      expectedRows: outcome.expectedRows,
      mirroredRows: state.written,
      ...notDecomposed,
    };
  }
  /* istanbul ignore next -- impossible input from the real collaborator:
   * `fetchSweep` records a non-complete outcome ONLY when its disposition has a
   * non-null `reason` (the reasonless classes — F2 auth, F8 local-io,
   * name-collision — are fatal and leave no outcome row at all). The guard is
   * still written because `TableFetchOutcome.reason` is optional, so the
   * compiler demands the narrowing, and because it restates the taxonomy's
   * "no row" rule at the one place a future fetcher change would surface it. */
  if (outcome.reason === undefined) {
    return null;
  }
  return {
    status: outcome.status,
    reason: outcome.reason,
    expectedRows: outcome.expectedRows,
    mirroredRows: state.written,
    ...notDecomposed,
  };
}

/** Everything the two report writers and the commit builder need at the end. */
interface RunFinish {
  plan: PlanResult["plan"];
  startedAt: string;
  tables: Record<string, TableCoverage>;
  tablesDiscovered: number;
  redactions: number;
  suppressions?: CatalogBuildResult["suppressions"];
  postQuiescence?: Record<string, QuiescenceReading>;
  fatal: FetchFatal | null;
  changedTables: readonly string[];
  scopes: readonly string[];
  resumeDecision: ResumeDecision | null;
  checkpointCleared: boolean;
}

/** Build the report, write both files, assemble the result. One exit for all paths. */
async function finishRun(options: RunMirrorCommandOptions, finish: RunFinish): Promise<RunMirrorResult> {
  const report = buildCoverageReport({
    plan: finish.plan,
    startedAt: finish.startedAt,
    finishedAt: options.now(),
    tables: finish.tables,
    tablesDiscovered: finish.tablesDiscovered,
    redactions: finish.redactions,
    ...(finish.suppressions === undefined ? {} : { suppressions: finish.suppressions }),
    ...(finish.postQuiescence === undefined ? {} : { postQuiescence: finish.postQuiescence }),
    ...(finish.fatal === null ? {} : { fatal: finish.fatal.failureClass }),
  });
  await writeCoverageReport(options.fs, options.root, report);
  await writeMirrorReport(options.fs, options.root, report);
  const commitMessage = buildMirrorCommitMessage({
    report,
    changedTables: finish.changedTables,
    scopes: finish.scopes,
  });
  return {
    exitCode: report.exitCode,
    report,
    commitMessage,
    fatal: finish.fatal,
    resumeDecision: finish.resumeDecision,
    checkpointCleared: finish.checkpointCleared,
  };
}

/** The client to run with — the injected one, or one built from the transport. */
function resolveClient(options: RunMirrorCommandOptions): MirrorSweepClient {
  if (options.client !== undefined && options.transport !== undefined) {
    throw new Error(
      "runMirrorCommand: pass either `client` or `transport`, not both — two transports for one run is a config error, not a preference."
    );
  }
  if (options.client !== undefined) {
    return options.client;
  }
  if (options.transport === undefined) {
    throw new Error(
      "runMirrorCommand: a transport is required — pass a constructed `client` or the `transport` material to build one."
    );
  }
  const transport = options.transport;
  const authorization =
    typeof transport.authorization === "function"
      ? transport.authorization()
      : transport.authorization;
  return new MirrorHttpClient({
    instance: transport.instance,
    headers: { Authorization: authorization },
    requestsPerSecond: options.config.sync.requestsPerSecond,
    pageSize: options.config.sync.pageSize,
    ...(transport.fetch === undefined ? {} : { fetch: transport.fetch }),
    ...(transport.maxAttempts === undefined ? {} : { maxAttempts: transport.maxAttempts }),
    ...(transport.timeoutMs === undefined ? {} : { timeoutMs: transport.timeoutMs }),
    ...(transport.sleep === undefined ? {} : { sleep: transport.sleep }),
    // The client's clock is bridged from the run's own; retry jitter still uses
    // the client's default RNG, which never reaches the tree (INV-1 is about
    // bytes, not about when they were fetched).
    now: () => Date.parse(options.now()),
  });
}

/** A fatal before any plan existed: report through the real Planner's empty plan. */
async function finishBeforePlan(
  options: RunMirrorCommandOptions,
  error: unknown
): Promise<RunMirrorResult> {
  const planned = planSync({
    catalog: [],
    config: options.config,
    full: options.full,
    syncOrdinal: options.syncOrdinal,
    verifyQuiescent: options.verifyQuiescent,
    now: () => Date.parse(options.now()),
    newSweepId: options.newSweepId,
  });
  return finishRun(options, {
    plan: planned.plan,
    startedAt: planned.startedAt,
    tables: {},
    tablesDiscovered: 0,
    redactions: 0,
    fatal: fatalFromError(null, error),
    changedTables: [],
    scopes: [],
    resumeDecision: null,
    checkpointCleared: false,
  });
}

/**
 * Run one `mirror sync` sweep end to end. The module docblock is the contract;
 * this function is its order of operations.
 */
export async function runMirrorCommand(options: RunMirrorCommandOptions): Promise<RunMirrorResult> {
  const client = resolveClient(options);
  const config = options.config;
  const fs = options.fs;
  const root = options.root;
  const nowMs = (): number => Date.parse(options.now());

  // — Catalog. auth/unreachable/hibernating escape the build by contract; a run
  // that cannot see the schema has nothing else to say (exit 1, reports written).
  let catalog: CatalogBuildResult;
  try {
    catalog = await new CatalogService({ source: client, config }).build();
  } catch (error) {
    return finishBeforePlan(options, error);
  }

  // — Scope-name index. Fatal classes end the run like the catalog's would; any
  // other transport failure degrades to an empty index and the `global` fallback.
  let scopeIndex: Map<string, string>;
  try {
    scopeIndex = await buildScopeNameIndex(client);
  } catch (error) {
    const failure = fatalFromError(null, error);
    if (RUN_FATAL_CLASSES.has(failure.failureClass)) {
      return finishBeforePlan(options, error);
    }
    scopeIndex = new Map();
  }

  // — Checkpoint, shard state, pre-quiescence readings, plan.
  const checkpointRead = await readCheckpoint(fs, root);
  const includedTables = catalog.tables.filter((entry) => entry.status === "included");
  const shardState = await loadShardStates(
    fs,
    root,
    includedTables.map((entry) => entry.name)
  );
  let quiescenceReadings: Map<string, QuiescenceReading> | undefined;
  if (options.verifyQuiescent === true) {
    // D1's pre-sweep readings ARE the catalog's aggregates: they describe the
    // instant before the sweep, and re-asking would only widen the race window.
    quiescenceReadings = new Map();
    for (const entry of includedTables) {
      if (entry.rowCount !== null) {
        quiescenceReadings.set(entry.name, {
          count: entry.rowCount,
          maxUpdatedOn: entry.maxUpdatedOn,
        });
      }
    }
  }
  const planned = planSync({
    catalog: catalog.tables,
    config,
    shardState,
    full: options.full,
    syncOrdinal: options.syncOrdinal,
    verifyQuiescent: options.verifyQuiescent,
    ...(quiescenceReadings === undefined ? {} : { quiescenceReadings }),
    ...(checkpointRead.present ? { resume: checkpointRead.state } : {}),
    now: nowMs,
    newSweepId: options.newSweepId,
  });
  const plan = planned.plan;
  const decision = decideResume(checkpointRead, plan);
  const remaining = remainingTables(plan, decision);
  // Tables the interrupted attempt of THIS sweep completed. `decideResume`
  // guarantees each of them is in the current plan (a table that vanished from
  // it lands in `vanishedTables` instead), so the verdict row below IS the
  // completed table's row and carries its `expectedRows`.
  const resumedComplete = new Set(decision.completedTables);

  // — Coverage rows the planner already settled (R3: every fate stated).
  const coverage: Record<string, TableCoverage> = {};
  for (const verdict of planned.decisions) {
    switch (verdict.outcome) {
      case "planned":
        // Completed by the interrupted attempt: complete on disk, counted from
        // the shards that attempt flushed, skipped by this run.
        if (resumedComplete.has(verdict.table)) {
          coverage[verdict.table] = {
            status: "complete",
            expectedRows: verdict.expectedRows,
            mirroredRows: await countShardRecords(fs, root, verdict.table),
          };
        }
        break;
      case "skipped-empty":
        // T6: a table measured at zero rows is fully covered, not skipped.
        coverage[verdict.table] = {
          status: "complete",
          expectedRows: verdict.expectedRows,
          mirroredRows: 0,
        };
        break;
      default:
        coverage[verdict.table] = {
          status: "skipped",
          reason: SKIP_REASON[verdict.outcome],
          expectedRows: verdict.expectedRows,
          mirroredRows: 0,
        };
        break;
    }
  }

  // — Checkpoint sink (the Writer drives it) and the Writer itself.
  const sinkState = checkpointForPlan(plan, planned.startedAt);
  sinkState.completedTables = [...decision.completedTables];
  const sink = new SweepCheckpointSink({
    root,
    fs,
    state: sinkState,
    ...(options.checkpointFlushEvery === undefined
      ? {}
      : { flushEvery: options.checkpointFlushEvery }),
  });
  const writer = new MirrorWriter({ root, sweepId: plan.sweepId, fs, progress: sink });

  // — The sweep: one fetchSweep call per table (see module docblock).
  const refreshAuth = oncePerRun(options.refreshAuth);
  const changedTables = new Set<string>();
  const scopesCovered = new Set<string>();
  // INV-5's evidence ledger, minted here and never read off disk. What licenses
  // a deletion is a sweep THIS PROCESS ran to completion, so the entry is pushed
  // at the moment the outcome is known and the `DeletionAuthority` object the
  // Writer handed back travels with it — a serialized "yes, table X was swept"
  // read from a file at the start of the next run would be exactly the forged
  // witness §5.9 refuses to accept.
  const evidence: TableSweepEvidence[] = [];
  let redactions = 0;
  let fatal: FetchFatal | null = null;

  for (const plannedTable of remaining) {
    const entry = plannedTable.entry;
    const tableWriter: TableSweepWriter = writer.beginTable(entry.name, {
      // A sweep observes the table whole; a watermark walk observes a slice.
      // "reconcile" never reaches the Writer — its flush semantics only
      // distinguish whole from slice.
      mode: plannedTable.strategy === "sweep" ? "full" : "incremental",
    });
    const state: TableRunState = { written: 0, changed: false, notDecomposed: new Set() };
    const onRow: FetchRowSink = async (row) => {
      // INV-3: the ONLY path from a wire row to a writable record.
      const piped = serializeAndRedact(row, { table: entry, redaction: config.redaction });
      for (const field of piped.parseFailures) {
        state.notDecomposed.add(field);
      }
      const scope = scopeNameFor(row, entry, catalog.scopeSysIdByTable, scopeIndex);
      const outcome = await tableWriter.writeRecord({
        record: piped.record,
        scope,
        displayName: displayNameFor(row),
        sysUpdatedOn: row.sys_updated_on ?? "",
        sysUpdatedBy: row.sys_updated_by ?? "",
        sysModCount: parseModCount(row.sys_mod_count),
      });
      redactions += piped.record.redactions.length;
      state.written += 1;
      scopesCovered.add(scope);
      if (outcome.status === "written" || outcome.renames.length > 0) {
        state.changed = true;
      }
    };

    const result = await fetchSweep({
      client,
      plan: [plannedTable],
      onRow,
      ...(refreshAuth === undefined ? {} : { refreshAuth }),
    });
    const outcome: TableFetchOutcome | undefined = result.tables[0];
    if (outcome !== undefined) {
      const row = coverageRowFor(outcome, state);
      /* istanbul ignore else -- `null` needs the reasonless outcome whose
       * impossibility `coverageRowFor`'s own guard documents. */
      if (row !== null) {
        coverage[entry.name] = row;
      }
    }
    if (result.fatal !== null) {
      fatal = result.fatal;
      tableWriter.abandon();
      break;
    }
    if (outcome?.status === "complete") {
      try {
        const completion = await tableWriter.completeTable();
        // INV-5: a non-null `authority` means the Writer saw the whole table,
        // which is the only thing that licenses a deletion. The two arms are
        // correct by construction rather than by check — the Writer mints an
        // authority exactly for a table it opened in `full` mode, and it opened
        // `full` exactly for `strategy === "sweep"` (line above) — so a
        // watermark walk cannot reach the first arm and a sweep cannot reach
        // the second. The reconciler is told which of the two it got because
        // "swept whole" and "walked a slice" authorize different things: the
        // first licenses deletion of anything the sweep did not see, the second
        // licenses nothing at all and is recorded only so §5.9 can name the
        // table as a refusal rather than pass over it in silence (R3).
        evidence.push(
          completion.authority !== null
            ? { kind: "full-sweep", authority: completion.authority }
            : { kind: "watermark", table: entry.name }
        );
        // For a completed table the flush REPLACES the per-row changed signal
        // rather than OR-ing into it. A shard entry pins path, content hash and
        // the tracking columns (§4.3), so a flushed entry set equal to the
        // baseline means the tree ended byte-identical — even when the writer
        // physically churned on the way there. It does churn: D18 forbids
        // seeding a full sweep, so a case-collision pair's first arrival is
        // written under the transient plain name and renamed back to its
        // suffixed one every run, and the per-row signal dutifully reported
        // that no-op as a change. The per-row signal still decides for
        // abandoned tables below, where no flush exists to consult and "may
        // have changed" is the honest answer.
        state.changed = completion.shardsWritten.length > 0;
      } catch (error) {
        // F8 during the flush: the shard claim did not land, so the table has no
        // honest coverage row (reason null in the taxonomy) — only the fatal.
        delete coverage[entry.name];
        fatal = fatalFromError(entry.name, error);
        tableWriter.abandon();
        break;
      }
    } else {
      // Partial or failed: INV-4 forbids the shard claim, INV-5 the authority.
      tableWriter.abandon();
      // The table is still named to the reconciler, as a sweep that did not
      // finish rather than as a table nobody mentioned. Both readings refuse
      // every deletion; only this one can say WHY in the refusal (R3), and the
      // reason is the fetcher's own taxonomy rather than a second vocabulary
      // invented here.
      /* istanbul ignore else -- a missing outcome is unreachable HERE rather
       * than in general: `fetchSweep` omits the row only for the dispositions
       * whose coverage reason is "—", and every one of those is also fatal, so
       * the `break` above has already left the loop. The guard stays because the
       * type cannot say that, and dropping the table silently would be the one
       * refusal R3 forbids. */
      if (outcome !== undefined) {
        /* istanbul ignore else -- same disposition table, same reason: an
         * outcome that reached this line carries a reason, because the only
         * reasonless ones are fatal. */
        if (outcome.reason !== undefined) {
          evidence.push(
            outcome.status === "partial"
              ? { kind: "partial", table: entry.name, reason: outcome.reason }
              : { kind: "failed", table: entry.name, reason: outcome.reason }
          );
        } else {
          // Contract-impossible (§4.4 requires a reason whenever the status is
          // not `complete`) — kept as a degradation rather than an assertion:
          // `failed` with a null reason is the weaker claim, and the reconciler
          // refuses on it just as firmly while still naming the table.
          evidence.push({ kind: "failed", table: entry.name, reason: null });
        }
      }
    }
    if (state.changed) {
      changedTables.add(entry.name);
    }
  }

  // — D1: re-read the aggregates only after a clean sweep; see module docblock.
  let postQuiescence: Record<string, QuiescenceReading> | undefined;
  if (fatal === null && plan.preQuiescence !== undefined) {
    postQuiescence = {};
    try {
      for (const table of Object.keys(plan.preQuiescence).sort(compareBytewise)) {
        const aggregate = await client.getAggregate(table);
        if (aggregate !== null) {
          postQuiescence[table] = {
            count: aggregate.count,
            maxUpdatedOn: aggregate.maxUpdatedOn,
          };
        }
        // A null aggregate (acl/transient/drift/parse) leaves the table without a
        // post reading: one-sided evidence, so the verdict degrades to `false` —
        // "asked and could not prove", never a fabricated `true`.
      }
    } catch (error) {
      // getAggregate refuses to swallow auth/unreachable/hibernating; a
      // verification the instance will not allow ends the run (exit 1) with
      // `quiescent: null` — checked is different from provable.
      fatal = fatalFromError(null, error);
      postQuiescence = undefined;
    }
  }

  // — Reconcile (§5.9): the only place in the engine where anything is removed
  // from the tree, and it runs on the evidence gathered above rather than on
  // anything it reads back. It comes after the quiescence re-read purely to
  // keep that window tight — a deletion is licensed by a completed sweep, not
  // by a quiet instance, so the two are independent.
  //
  // A run that ended fatally does not reconcile at all. Its evidence ledger is
  // truthful about the tables it did reach, but the tables it never reached are
  // absent, and absent reads as `not-in-sweep` — a refusal, so nothing would be
  // wrongly deleted. Skipping is about honesty rather than safety: reporting a
  // hundred refusals caused by one dead connection describes the connection,
  // not the mirror.
  //
  // No tombstone advisory is passed. §5.9 calls it "an advisory optimization
  // between reconciliations", and the optimization needs a `sys_audit_delete`
  // watermark this orchestrator does not yet keep; without one it would re-read
  // the same tombstones every run. Nothing is lost meanwhile: a reconcile-mode
  // plan forces `strategy: "sweep"` for every table (§5.4), so deletions are
  // fully live on that cadence through full-sweep evidence — the advisory only
  // shortens the wait between reconciliations. The seam is `ReconcileOptions.
  // advisory`, and it is deliberately left unwired rather than half-wired.
  if (fatal === null) {
    try {
      const reconciliation = await reconcileSweep({
        fs,
        root,
        sweepId: plan.sweepId,
        evidence,
      });
      for (const deletion of reconciliation.deletions) {
        // A removed record is a changed table as surely as a rewritten one; D10's
        // trailer counts tables whose bytes moved, and a deletion moved them.
        changedTables.add(deletion.table);
      }
      // `reconciliation.refusals` is not surfaced separately: every refusal
      // names a table whose coverage row already carries the same fact in the
      // report's own vocabulary (`partial` / `failed` / `skipped`), and a second
      // rendering of it would be a second thing to keep in agreement with the
      // first. R3 is satisfied by the row, not by silence.
    } catch (error) {
      // The reconciler only touches the local tree, so a throw here is F8-class
      // local I/O. It ends the run the same way a failed flush does — including
      // leaving the checkpoint in place below, so the next run resumes rather
      // than re-sweeping what this one already proved.
      fatal = fatalFromError(null, error);
    }
  }

  // — Derived views (§5.12, INV-9): regenerated from the canonical tree alone,
  // after reconcile so the reference index cannot point at a record this run
  // deleted. Regeneration is unconditional rather than restricted to changed
  // tables: the views are a pure function of the canonical tree, so rebuilding
  // them when nothing changed reproduces the same bytes and costs INV-1
  // nothing, while rebuilding only "the changed ones" would need a dependency
  // map from tables to views that INV-9 exists precisely to avoid.
  if (fatal === null) {
    try {
      const derived = await generateDerivedViews(fs, root, config);
      const danglingByTable = new Map<string, number>();
      for (const ref of derived.danglingRefs) {
        danglingByTable.set(ref.table, (danglingByTable.get(ref.table) ?? 0) + 1);
      }
      // Walk the coverage rows rather than the counts, so a count can only ever
      // land on a table this run actually covered. The refs view reads the whole
      // canonical tree, which may still hold a table the catalog no longer
      // discovers; attaching its dangling references to an invented coverage row
      // would report a table as swept that this run never touched. That tree
      // region is `mirror status`'s business, where it surfaces as
      // `table-vanished` (§5.10) — a name for it already exists, in the command
      // whose job is to notice it.
      for (const [table, row] of Object.entries(coverage)) {
        const count = danglingByTable.get(table);
        if (count !== undefined) {
          // D2: reported, never repaired. The count is the whole remedy.
          coverage[table] = { ...row, danglingRefs: count };
        }
      }
    } catch (error) {
      // `ShardManifestCorrupt` from the canonical index, or local I/O: either
      // way the tree is not describable, which is F8 and ends the run.
      fatal = fatalFromError(null, error);
    }
  }

  // — Checkpoint: cleared by a run that reached its own end, persisted by one
  // that did not, so the next run can skip what this one proved.
  if (fatal === null) {
    await clearCheckpoint(fs, root);
  } else {
    await sink.flush();
  }

  return finishRun(options, {
    plan,
    startedAt: planned.startedAt,
    tables: coverage,
    tablesDiscovered: catalog.tables.length,
    redactions,
    suppressions: catalog.suppressions,
    ...(postQuiescence === undefined ? {} : { postQuiescence }),
    fatal,
    changedTables: [...changedTables].sort(compareBytewise),
    scopes: [...scopesCovered].sort(compareBytewise),
    resumeDecision: decision,
    checkpointCleared: fatal === null,
  });
}
