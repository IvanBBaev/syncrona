// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The sweep executor — architecture §5.5, WP-M8.
 *
 * Everything upstream decides WHAT to read (the catalog, then the planner) and
 * everything downstream decides what the bytes look like (serializer, redactor,
 * writer). This module is the only place that turns a `PlannedTable` into HTTP
 * traffic, and its entire job is to do that without ever lying about what came back.
 *
 * Four structural properties are load-bearing here, and each is far easier to keep
 * than to recover once lost:
 *
 * 1. **No filesystem.** There is no `node:fs` import in this file and there must not
 *    be one (§5.5); the only seam this module holds is an HTTP one. Rows leave
 *    through {@link FetchRowSink} and progress leaves through
 *    {@link FetchProgressReporter}; the caller owns the checkpoint file and the tree.
 *    A fetcher that could write would be a second place able to break INV-4 ("shards
 *    flush only when the table sweep completes") and R4 (atomic writes) — both of
 *    which are currently enforceable because exactly one module touches disk. (The
 *    planner import below reaches `write/fs` transitively, for the planner's own
 *    shard reader. That is a module graph, not a capability: nothing in this file is
 *    handed a `WriterFs`, and without one none of those functions can be called.)
 * 2. **No materialised table.** Rows go to the sink one at a time and the sink is
 *    awaited, so the walk holds at most one page plus one row regardless of table
 *    size. The bulk fixture is 24 000 rows and real `sys_metadata` descendants run
 *    into the hundreds of thousands; a function that returned `Row[]` would fix the
 *    tool's memory ceiling by accident. Awaiting the sink is also back-pressure —
 *    the next page is not requested until the writer has finished with the previous
 *    one, so a slow disk throttles the instance rather than filling a queue.
 * 3. **No second retry budget.** `MirrorHttpClient.send` already retries F1
 *    transients with jittered backoff and `Retry-After`, and retries nothing else. A
 *    {@link MirrorHttpError} with `failureClass === "transient"` reaching this module
 *    is therefore an *already exhausted* budget, not an invitation to try again;
 *    retrying here would turn four attempts into sixteen and quadruple the load the
 *    rate cap exists to bound (analyses §3 T6). This module never sleeps and never
 *    re-requests the same cursor — with one deliberate exception, F2's single
 *    credential refresh, which is a different remedy rather than a second attempt at
 *    the same one.
 * 4. **Sequential tables.** Table-level concurrency is 1 in Phase 1 (§5.5). The
 *    determinism of the tree does not depend on fetch order, but a fatal must stop a
 *    *bounded* amount of in-flight work, and {@link SweepFetchResult.notAttempted} is
 *    only a truthful list while there is exactly one table in flight.
 *
 * The failure behaviour is the taxonomy table of analyses §2, encoded once in
 * {@link DISPOSITIONS} instead of scattered across catch blocks, so "which failures
 * stop the run" is something you can read in ten lines rather than reconstruct.
 */
import type {
  CoverageReason,
  MirrorFailureClass,
  PlannedTable,
  TableCatalogEntry,
  TablePage,
} from "../contracts";
import { MirrorHttpError, type PageRequest } from "../http/client";
import { plannedQueryFor } from "./planner";

/**
 * The column the keyset walk orders and cursors on, always requested.
 *
 * Not optional and not configurable: `getPage` reads the next cursor out of the last
 * row's `sys_id`, so a projection that omitted it would stall the walk on page one.
 */
const CURSOR_FIELD = "sys_id";

/**
 * The slice of `MirrorHttpClient` the sweep needs.
 *
 * Structural rather than the concrete class so a test can drive the taxonomy with a
 * three-line fake, and so nothing here can reach for `getAggregate`, `send`, or any
 * other verb: INV-2 is a property of this package's whole surface, and the narrowest
 * seam is the one that cannot be widened by accident.
 */
export interface FetcherPageSource {
  getPage(table: string, cursor: string | null, request: PageRequest): Promise<TablePage>;
}

/** What the caller learns after every page, so it can checkpoint (F8, §4.7). */
export interface FetchProgress {
  /** Table currently in flight — `CheckpointState.inProgress.table`. */
  table: string;
  /** Highest `sys_id` confirmed handed to the sink — `inProgress.lastSysId`. */
  lastSysId: string;
  /** Rows emitted for this table so far, for progress display and assertions. */
  rowsFetched: number;
  /** Pages consumed for this table so far. */
  pages: number;
}

/**
 * Where progress goes. Injected, never a concrete sink.
 *
 * Deliberately NOT `SweepProgressSink` from `src/write/sweepProgress.ts`: that type
 * is record-level and filesystem-backed, and importing it would drag `node:fs` in
 * behind it, breaking property 1 of the module docblock. It also carries
 * `tableCompleted`, which is the writer's claim to make and not the fetcher's — the
 * fetcher knows the rows were *read*, the writer knows they were *stored*, and only
 * the latter may put a table into `completedTables` (INV-4, R2).
 */
export type FetchProgressReporter = (progress: FetchProgress) => Promise<void> | void;

/**
 * Where rows go, one at a time, awaited before the next.
 *
 * A callback rather than an async iterator: the fetcher must own the try/catch that
 * the taxonomy is written against, and with an iterator the consumer's loop owns it
 * instead — an F3 that should mark one table partial and continue would surface to
 * the caller as a throw out of `for await`, and every consumer would have to
 * re-derive the taxonomy to keep going. The callback keeps the failure policy in one
 * place and hands the caller only decisions it is entitled to make.
 */
export type FetchRowSink = (row: Record<string, string>, table: string) => Promise<void> | void;

/**
 * Everything the report generator needs about one table, and nothing it does not.
 *
 * This is deliberately not a `TableCoverage`: `mirroredRows` in that type means rows
 * that reached disk, which is the writer's number, and building a coverage entry
 * requires facts from stages this module cannot see (redaction overflow, name
 * collisions). `rowsFetched` is named differently for exactly that reason — a
 * generator that copies it into `mirroredRows` unexamined is making a claim the
 * fetcher never made.
 */
export interface TableFetchOutcome {
  /** Table name, as planned. */
  table: string;
  /** How the read ended. Never `"skipped"` — a skip is a planner verdict. */
  status: "complete" | "partial" | "failed";
  /**
   * Why it is not `"complete"` (R3). Present whenever `status` is not `"complete"`,
   * which is what lets the generator build a `TableCoverage` without inventing one.
   */
  reason?: CoverageReason;
  /** `TableCatalogEntry.rowCount`, echoed so the generator need not re-read the plan. */
  expectedRows: number | null;
  /** Rows handed to the sink. Not a claim that any of them were written. */
  rowsFetched: number;
  /** Pages consumed, for rate accounting and for the run report's diagnostics. */
  pages: number;
  /** Last cursor confirmed emitted, or null when the table produced no rows. */
  lastSysId: string | null;
  /**
   * Requested columns that appeared in no fetched row — F5 (§5.5).
   *
   * Empty unless the read completed: a truncated read cannot distinguish "the column
   * is gone" from "the rows carrying it are the ones we never reached", and guessing
   * would put a false `column-missing` into the coverage report.
   */
  missingColumns: string[];
  /** The taxonomy class behind a non-complete status, absent when complete. */
  failureClass?: MirrorFailureClass;
  /** The underlying error text, for the run report's human-readable line. */
  detail?: string;
}

/**
 * The run-ending failure, with D4's tri-state preserved.
 *
 * `failureClass` keeps `auth`, `unreachable` and `hibernating` distinguishable and
 * {@link FetchFatal.diagnosis} carries the three different sentences §10 requires:
 * collapsing them into one "could not reach the instance" is the specific regression
 * D4 exists to prevent, because the three have three different remedies (fix the
 * credential / fix the network / wake the PDI).
 */
export interface FetchFatal {
  /** Table in flight when the run stopped, or null if the plan never started. */
  table: string | null;
  /** Taxonomy class — the machine-readable half of the tri-state. */
  failureClass: MirrorFailureClass;
  /** The user-facing headline for this class (D4, §10). */
  diagnosis: string;
  /** The underlying error text. */
  message: string;
}

/**
 * What one sweep produced.
 *
 * The three fields partition the plan, and the partition is the contract: every
 * planned table is named in exactly one of {@link SweepFetchResult.tables},
 * {@link FetchFatal.table}, or {@link SweepFetchResult.notAttempted}. R3 forbids
 * silent skips, and a caller that renders all three has, by construction, accounted
 * for every table the planner chose.
 *
 * A table appears in `tables` if and only if its outcome carries a `CoverageReason`
 * or completed cleanly. That asymmetry is the taxonomy's, not an omission: F2, F8 and
 * F9 have "—" in the coverage column of analyses §2, because they are failures of the
 * *run*, not degradations of a table's coverage. Those surface through `fatal`. F4 is
 * both — fatal AND `instance-unreachable` — so it produces an entry in `tables` and a
 * `fatal`, which is exactly what "checkpoint and stop" needs to be reportable.
 */
export interface SweepFetchResult {
  /** Per-table outcomes, in plan order. */
  tables: TableFetchOutcome[];
  /** Set when the run stopped early (R1 exit 1); null on a run that reached the end. */
  fatal: FetchFatal | null;
  /** Planned tables the sweep never started, in plan order. Empty unless `fatal`. */
  notAttempted: string[];
}

/** Inputs to {@link fetchSweep}. */
export interface FetchSweepOptions {
  /** The HTTP seam. In production a `MirrorHttpClient`. */
  client: FetcherPageSource;
  /**
   * What to read, in the order to read it. Produced by the planner; consumed here
   * without reordering, because coverage ordering is the planner's guarantee (§5.5).
   */
  plan: readonly PlannedTable[];
  /** Receives every row, awaited. See {@link FetchRowSink}. */
  onRow: FetchRowSink;
  /** Receives progress after every page. Optional; omit to sweep without resumption. */
  onProgress?: FetchProgressReporter;
  /**
   * F2's single remedy: re-acquire the credential and report whether it worked.
   *
   * Injected because this package must not perform the token exchange itself —
   * INV-2 makes the OAuth POST unrepresentable here, and `resolveMirrorAuthorization`
   * already refuses every grant for that reason. With no hook supplied, a 401 is
   * immediately fatal, which is the honest behaviour for Basic auth: there is nothing
   * to refresh.
   */
  refreshAuth?: () => Promise<boolean>;
  /**
   * Table name → cursor to start after, for resuming an interrupted sweep (§4.7).
   *
   * Mechanism only. WHICH tables to resume and from where is the checkpoint reader's
   * decision; handing the fetcher a map keeps that policy out of this module and lets
   * the interrupt test drive a resume without a checkpoint file existing.
   */
  resumeCursors?: Readonly<Record<string, string>>;
}

/**
 * What a failure class does, straight out of the analyses §2 table.
 *
 * Exhaustive over `MirrorFailureClass` on purpose — no default arm — so that adding
 * a tenth class to the contract is a compile error here rather than a silently
 * mishandled failure at runtime. `reason: null` encodes the taxonomy's "—" coverage
 * column: those rows are run failures, not table degradations, and inventing a
 * `CoverageReason` for them would put a claim in `coverage.json` the taxonomy never
 * authorised.
 */
interface Disposition {
  /** Whether the run stops here (R1 exit 1) or the sweep moves to the next table. */
  fatal: boolean;
  /** The table's status when this class produces a coverage entry. */
  status: "partial" | "failed";
  /** The coverage reason, or null when the taxonomy records none. */
  reason: CoverageReason | null;
}

const DISPOSITIONS: Readonly<Record<MirrorFailureClass, Disposition>> = {
  // F1: the client's retry budget is already spent by the time this is thrown, so
  // the table fails and the sweep continues (exit 2, not 1).
  transient: { fatal: false, status: "failed", reason: "transient-exhausted" },
  // F2: one refresh has already been tried and failed by the time this is reached.
  auth: { fatal: true, status: "failed", reason: null },
  // F3: the classic partial — the rest of the instance is still readable.
  acl: { fatal: false, status: "partial", reason: "acl-403" },
  // F4, both halves of D4's reachable/awake distinction. Same coverage reason, three
  // different diagnoses; see `diagnosisFor`.
  unreachable: { fatal: true, status: "failed", reason: "instance-unreachable" },
  hibernating: { fatal: true, status: "failed", reason: "instance-unreachable" },
  // F5: keep the record, record the gap, do not fail the table.
  "schema-drift": { fatal: false, status: "partial", reason: "column-missing" },
  // F6/F7 are produced downstream, but a class that can reach this catch must have a
  // disposition or the exhaustive map is a lie; both are degradations, not stops.
  parse: { fatal: false, status: "partial", reason: "parse-failure" },
  "redaction-overflow": { fatal: false, status: "partial", reason: "redacted-overflow" },
  // F8: checkpoint and stop. The tree is atomic, so stopping is safe; continuing to
  // fetch against a disk that cannot be written to is not.
  "local-io": { fatal: true, status: "failed", reason: null },
  // F9 is resolved deterministically by the writer and never reaches here; if one
  // ever does, it is a bug in the collision rule and must not be papered over.
  "name-collision": { fatal: true, status: "failed", reason: null },
};

/** One planned table paired with the request that was validated for it. */
interface TableJob {
  planned: PlannedTable;
  request: PageRequest;
}

/** Mutable progress of a single table's walk, readable from the catch block. */
interface TableWalk {
  cursor: string | null;
  rowsFetched: number;
  pages: number;
  seenColumns: Set<string>;
}

/**
 * Read every planned table, in order, emitting rows as they arrive (§5.5).
 *
 * Resolves rather than throws for anything in the taxonomy: a sweep that stops is a
 * *result* with a `fatal`, because the caller still has to flush the checkpoint,
 * write the coverage report and choose an exit code, and none of that is reachable
 * from a rejected promise. It does throw — before issuing any request — for a plan
 * that is internally inconsistent, since that is a programming error in the planner
 * and D20 requires the bad query never be sent.
 */
export async function fetchSweep(options: FetchSweepOptions): Promise<SweepFetchResult> {
  const jobs = planJobs(options.plan);
  const auth = createAuthRefresher(options.refreshAuth);
  const tables: TableFetchOutcome[] = [];

  for (const [index, job] of jobs.entries()) {
    const table = job.planned.entry.name;
    const walk: TableWalk = {
      cursor: options.resumeCursors?.[table] ?? null,
      rowsFetched: 0,
      pages: 0,
      seenColumns: new Set<string>(),
    };

    let failure: MirrorHttpError | null = null;
    try {
      await walkTable(options, job, walk, auth);
    } catch (error) {
      failure = toMirrorHttpError(error);
    }

    if (failure === null) {
      tables.push(completedOutcome(job, walk));
      continue;
    }

    const disposition = DISPOSITIONS[failure.failureClass];
    if (disposition.reason !== null) {
      tables.push({
        table,
        status: disposition.status,
        reason: disposition.reason,
        expectedRows: job.planned.entry.rowCount,
        rowsFetched: walk.rowsFetched,
        pages: walk.pages,
        lastSysId: walk.cursor,
        // Empty by construction: see `TableFetchOutcome.missingColumns`.
        missingColumns: [],
        failureClass: failure.failureClass,
        detail: failure.message,
      });
    }
    if (!disposition.fatal) {
      continue;
    }
    return {
      tables,
      fatal: {
        table,
        failureClass: failure.failureClass,
        diagnosis: diagnosisFor(failure.failureClass),
        message: failure.message,
      },
      notAttempted: jobs.slice(index + 1).map((rest) => rest.planned.entry.name),
    };
  }

  return { tables, fatal: null, notAttempted: [] };
}

/**
 * Walk one table to the end, or throw the failure that stopped it.
 *
 * `walk` is mutated rather than returned so the caller's catch block can still see
 * how far the table got. That is not a convenience: F4 is "checkpoint and stop", and
 * a resume needs the last confirmed `sys_id` from the attempt that failed — a
 * throw that discarded the accumulator would make every interruption restart its
 * table from row one, which is the exact failure `src/write/sweepProgress.ts` was
 * written to avoid.
 */
async function walkTable(
  options: FetchSweepOptions,
  job: TableJob,
  walk: TableWalk,
  auth: AuthRefresher
): Promise<void> {
  const table = job.planned.entry.name;
  for (;;) {
    let page: TablePage;
    try {
      page = await options.client.getPage(table, walk.cursor, job.request);
    } catch (error) {
      const failure = toMirrorHttpError(error);
      // F2's one retry. `refresh` is budgeted per RUN, so a revoked credential
      // cannot drive one refresh per table across a 400-table plan; see
      // `createAuthRefresher`.
      if (failure.failureClass !== "auth" || !(await auth.refresh())) {
        throw failure;
      }
      continue;
    }

    walk.pages += 1;
    for (const row of page.rows) {
      // The union across rows, not the first row's keys: a column is only "missing"
      // if NO row carried it. Empty values arrive as "" and still key the object,
      // so a present-but-empty column is correctly not reported (measurement M8).
      for (const column of Object.keys(row)) {
        walk.seenColumns.add(column);
      }
      await options.onRow(row, table);
      walk.rowsFetched += 1;
    }

    // A page that claims more rows but hands back no new cursor would be fetched
    // again forever, re-emitting the same rows into the writer. `getPage` refuses a
    // last row whose `sys_id` is not a sys_id for the same reason; this is the other
    // half of that guard, covering a repeated final row and a `pageSize` of zero.
    if (!page.done && (page.lastSysId === null || page.lastSysId === walk.cursor)) {
      throw new MirrorHttpError(
        "schema-drift",
        `Table ${table} returned a non-final page that does not advance the keyset cursor past ${JSON.stringify(walk.cursor)}; the sweep would loop forever.`
      );
    }

    if (page.lastSysId !== null) {
      walk.cursor = page.lastSysId;
      // Reported after the rows are handed over, never before: the checkpoint claims
      // "everything up to and including this sys_id is dealt with", and a report
      // issued before the sink ran would let a crash skip a page it never wrote.
      await reportProgress(options.onProgress, {
        table,
        lastSysId: page.lastSysId,
        rowsFetched: walk.rowsFetched,
        pages: walk.pages,
      });
    }

    if (page.done) {
      return;
    }
  }
}

/**
 * Grade a table that was read to the end.
 *
 * Two degradations can survive a successful walk, and they are ranked. A row-count
 * shortfall (F3's second detector) outranks a missing column because a row nobody saw
 * is a strictly larger hole than a field nobody saw, and `TableCoverage` has room for
 * one reason.
 */
function completedOutcome(job: TableJob, walk: TableWalk): TableFetchOutcome {
  const expectedRows = job.planned.entry.rowCount;
  const missingColumns = missingColumnsOf(job.request.fields, walk);
  const base = {
    table: job.planned.entry.name,
    expectedRows,
    rowsFetched: walk.rowsFetched,
    pages: walk.pages,
    lastSysId: walk.cursor,
    missingColumns,
  };

  // F3 without a 403: the Aggregate count says there are rows this credential cannot
  // see. Only meaningful for a full sweep — a watermark read is *supposed* to return
  // fewer rows than the table holds, and applying this there would mark every
  // incremental run partial.
  if (
    job.planned.strategy === "sweep" &&
    expectedRows !== null &&
    walk.rowsFetched < expectedRows
  ) {
    return { ...base, status: "partial", reason: "not-visible", failureClass: "acl" };
  }
  if (missingColumns.length > 0) {
    return { ...base, status: "partial", reason: "column-missing", failureClass: "schema-drift" };
  }
  return { ...base, status: "complete" };
}

/**
 * Requested columns that no row carried — F5 detection (§5.5).
 *
 * Guarded on having seen a row, because on an empty table every requested column is
 * trivially absent and reporting the whole projection as drifted would turn the most
 * ordinary state a table can be in into a coverage incident.
 */
function missingColumnsOf(fields: readonly string[], walk: TableWalk): string[] {
  if (walk.rowsFetched === 0) {
    return [];
  }
  return fields.filter((field) => !walk.seenColumns.has(field));
}

/**
 * Validate the whole plan and build its requests before the first byte goes out.
 *
 * Up front rather than lazily, because D20's requirement is that a query naming an
 * uncataloged field is "a hard internal error, never sent" — a check performed just
 * before each request would still have sent the requests for every earlier table, and
 * a half-swept mirror is a worse outcome than a refusal to start. These throw rather
 * than producing a coverage entry: they describe a planner that is broken, not an
 * instance that is degraded.
 *
 * The watermark clause itself is built by `plannedQueryFor` and never here. The
 * planner owns both the D20 field check and the rendering of the bound into the
 * instance's `glide_date_time` form, and a second builder in this module would put
 * D20's gate on one code path while the requests went out on another — which is the
 * hazard D20 describes, not a defence against it.
 *
 * The one check that stays local is the converse of the contract's "present iff":
 * a `sweep` carrying a watermark is a plan that disagrees with itself, and
 * `plannedQueryFor` answers `null` for it — correctly, since a sweep is unfiltered —
 * so nothing downstream would ever notice the inconsistency.
 */
function planJobs(plan: readonly PlannedTable[]): TableJob[] {
  return plan.map((planned) => {
    if (planned.strategy === "sweep" && planned.watermark !== undefined) {
      throw new Error(
        `Internal error: table ${planned.entry.name} is planned as a full sweep but carries a watermark bound.`
      );
    }
    const fields = pageFields(planned.entry);
    const query = plannedQueryFor(planned);
    return { planned, request: query === null ? { fields } : { fields, extraQuery: query } };
  });
}

/**
 * The projection for one table.
 *
 * Denied field types are dropped here and not merely redacted later (D19): the
 * `password2` column comes off the wire as ciphertext, and the cheapest way to
 * guarantee it never reaches a buffer, a log line or a heap dump is not to ask for
 * it. The redactor still refuses it downstream — this is the first of two doors, not
 * a replacement for the second.
 *
 * Noise columns (`sys_updated_on`, `sys_updated_by`, `sys_mod_count`) are deliberately
 * KEPT. They never appear in `record.json`, but `RecordEntry` carries all three and
 * the planner reads `sys_updated_on` off the wire row for the next run's watermark —
 * dropping them here to match the serializer's output would break both.
 *
 * Sorted so the generated `sysparm_fields` is a function of the catalog alone; two
 * runs against an unchanged instance then issue byte-identical URLs, which is the
 * cheapest available evidence for the request half of INV-1.
 *
 * Exported for its second caller: `mirror status --deep` re-fetches rows and
 * re-derives their canonical bytes to compare against `contentHash`, so it must
 * ask for EXACTLY the projection the sweep asked for. A restatement there would
 * hash different bytes than the sweep wrote the moment either copy changed, and
 * the symptom would be a verify finding on a repository nobody touched — so the
 * rule has one implementation, here, and `status/driftDetector.ts` imports it.
 *
 * It reaches the package barrel through this module's `export *`, and that is the
 * same trade the planner's query builders are exported under: a projection is a
 * claim about a STRING, and a caller that can reuse the checked one is a caller
 * that will not write a third.
 */
export function pageFields(entry: TableCatalogEntry): string[] {
  const names = new Set<string>([CURSOR_FIELD]);
  for (const field of entry.fields) {
    if (field.isDenied) {
      continue;
    }
    names.add(field.element);
  }
  return [...names].sort();
}

/** One credential refresh per run. */
interface AuthRefresher {
  refresh(): Promise<boolean>;
}

/**
 * F2's budget, held for the whole run rather than per request.
 *
 * "One retry" in analyses §2 is a bound on the remedy, not on each site that might
 * apply it. Per-request budgeting reads the same on a single table and is unbounded
 * across a plan: a revoked credential would produce one refresh attempt per table,
 * so a 400-table plan would hammer the token endpoint 400 times before reporting the
 * failure the first 401 already proved.
 */
function createAuthRefresher(refreshAuth: (() => Promise<boolean>) | undefined): AuthRefresher {
  let used = false;
  return {
    async refresh(): Promise<boolean> {
      if (refreshAuth === undefined || used) {
        return false;
      }
      used = true;
      return await refreshAuth();
    },
  };
}

/** Invoke the reporter when there is one. */
async function reportProgress(
  reporter: FetchProgressReporter | undefined,
  progress: FetchProgress
): Promise<void> {
  if (reporter !== undefined) {
    await reporter(progress);
  }
}

/**
 * Put any thrown value into the taxonomy.
 *
 * A non-`MirrorHttpError` escaping the walk came from the row sink or the progress
 * reporter — in production, the writer and the checkpoint, i.e. the disk. That is F8:
 * checkpoint and stop, exit 1. Classifying it as anything continuable would let a
 * sweep keep fetching against a full disk or a held git lock and then report the
 * resulting emptiness as coverage, which is precisely what R3 forbids.
 */
function toMirrorHttpError(error: unknown): MirrorHttpError {
  if (error instanceof MirrorHttpError) {
    return error;
  }
  return new MirrorHttpError("local-io", error instanceof Error ? error.message : String(error));
}

/**
 * D4's tri-state, as three different sentences (§10).
 *
 * Three failures that all look like "no data came back" have three different
 * remedies, and a single "could not reach the instance" message sends the user to
 * debug the wrong one. Kept next to {@link DISPOSITIONS} so the pair that must not
 * drift — class and message — is one screen apart.
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
