// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Planner — turning a catalog into an ordered, justified list of table fetches
 * (WP-M8, §5.4, §4.5, §4.2, D1, D20).
 *
 * The Planner is where every "should we even ask the instance for this?" decision is
 * made, and it is deliberately the only place. The Fetcher receives a `SyncPlan` and
 * executes it; it does not consult the config, re-derive a watermark, or decide that
 * a table looks empty. That split exists so the answer to "why did this table not get
 * fetched?" is a single structure that can be rendered into the coverage report,
 * rather than an emergent property of four modules.
 *
 * Four properties are load-bearing.
 *
 * **Order is a contract (§4.5).** Tier ascending, then table name ascending by
 * UTF-16 code unit. Committed files are rendered from this sequence, so a locale- or
 * insertion-order-dependent sort would produce a different diff on a different
 * machine for the same instance — INV-1's failure mode, showing up as noise in a
 * git history rather than as an error anyone would notice.
 *
 * **Everything is injected (§4.2's testability rule).** The clock and the sweep-id
 * source are parameters, in the same shape `http/client.ts` injects its clock, sleep
 * and RNG. A planner that called `Date.now()` internally could not be tested for the
 * watermark arithmetic that is its most error-prone part, and a plan that embeds an
 * ambient timestamp is not reproducible.
 *
 * **Aggregate-first (T6).** A table whose Aggregate `count` is 0 is planned as
 * `skipped-empty` and NO row request is issued for it. `rowCount === null` is NOT
 * zero — it means the Aggregate call did not answer — and such a table is swept.
 * Collapsing the two would make an Aggregate outage look like an empty instance and
 * hand INV-5 permission to delete everything it could not measure.
 *
 * **D20 is the reason this module builds the query string at all.** Measured on a
 * real instance: `sysparm_query` naming a field that does not exist is SILENTLY
 * IGNORED, and the surviving query then matches every row. A one-character typo in an
 * incremental watermark clause therefore does not fail — it downloads the whole table
 * while the report says "incremental", and it makes a reconcile pass conclude that
 * rows are present that the query never actually filtered for. So the planner
 * generates the encoded query here, validates every field name in it against the
 * catalog's effective field set for that table BEFORE the plan is returned, and
 * treats a violation as a hard internal error. A table that cannot be queried safely
 * is downgraded to a sweep — never to an unvalidated query.
 */
import { WATERMARK_OVERLAP_MS } from "../constants";
import type {
  CheckpointState,
  CoverageReason,
  MirrorConfig,
  PlannedTable,
  QuiescenceReading,
  SyncMode,
  SyncPlan,
  TableCatalogEntry,
} from "../contracts";
import { compareBytewise } from "../order";
import { listScopesWithShards, loadShardSet } from "../shards/shardStore";
import type { WriterFs } from "../write/fs";

/**
 * The single field the planner ever names in a generated query.
 *
 * Kept as a constant so the D20 validation and the query construction cannot drift
 * apart: the check is only worth anything if it inspects the same string the request
 * carries.
 */
const WATERMARK_FIELD = "sys_updated_on";

/** Why a planner-generated query was refused. */
export type PlannerQueryFault =
  | "uncataloged-query-field"
  | "unparseable-query"
  | "unparseable-watermark";

/**
 * A generated query that could not be proven safe — D20's hard internal error.
 *
 * An exception rather than a downgrade-in-place, because by the time this throws the
 * planner has already decided it wants a filtered fetch. Silently converting that
 * into an unfiltered one is the exact outcome D20 describes; silently converting it
 * into a sweep would be safe for the data but would mislabel the run. The planner's
 * own paths avoid the throw by checking the catalog first and choosing a sweep
 * BEFORE building a query; the throw is what protects callers that build one
 * themselves (a future `--since` flag, a test fixture, a resumed plan whose
 * `PlannedTable` was assembled by hand).
 */
export class PlannerQueryError extends Error {
  readonly fault: PlannerQueryFault;
  readonly table: string;

  constructor(fault: PlannerQueryFault, table: string, message: string) {
    super(message);
    this.name = "PlannerQueryError";
    this.fault = fault;
    this.table = table;
  }
}

/**
 * A fixed-width instant, in either the instance's `YYYY-MM-DD HH:MM:SS` form or the
 * ISO-8601 form the plan carries.
 *
 * Hand-parsed rather than handed to `Date.parse`, which is specified to accept
 * implementation-defined formats and has historically differed between engines on
 * exactly the space-separated form ServiceNow returns — reading a watermark as local
 * time on one machine and UTC on another would shift every incremental boundary by
 * the operator's timezone offset, which INV-1 would surface as a mirror that
 * re-downloads a different slice of rows on every machine.
 */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/;

/** Two-digit, zero-padded — for rendering a `glide_date_time` back out. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Render an epoch-millisecond instant as the instance's `glide_date_time` form.
 *
 * Always UTC. See {@link buildWatermarkQuery} for why that matters and what it
 * assumes about the mirroring account.
 */
function toGlideDateTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getUTCFullYear()).padStart(4, "0")}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())} ${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}:${pad2(at.getUTCSeconds())}`;
}

/**
 * Epoch milliseconds for a fixed-width instant, or `null` when it is not one.
 *
 * The round-trip comparison at the end is not belt-and-braces. `Date.UTC` rolls
 * out-of-range components over rather than rejecting them — month 13 becomes January
 * of the next year, day 32 becomes the 1st — and it maps two-digit years into the
 * 1900s. A corrupt `sys_updated_on` of `2026-13-01 00:00:00` would otherwise become a
 * watermark four months in the future, and the next incremental sync would fetch
 * nothing at all while reporting success.
 */
export function parseInstantMs(value: string): number | null {
  const match = INSTANT_RE.exec(value);
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millis] = match;
  const epochMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis === undefined ? 0 : Number(millis.padEnd(3, "0"))
  );
  return toGlideDateTime(epochMs) === `${year}-${month}-${day} ${hour}:${minute}:${second}`
    ? epochMs
    : null;
}

/** Encoded-query comparison operators, longest first so `>=` is not read as `>`. */
const QUERY_OPERATORS = [">=", "<=", "!=", "=", ">", "<"] as const;
const ORDER_BY_DESC = "ORDERBYDESC";
const ORDER_BY = "ORDERBY";

/** Index of the earliest operator in a clause, or -1 when it has none. */
function firstOperatorIndex(clause: string): number {
  let best = -1;
  for (const operator of QUERY_OPERATORS) {
    const at = clause.indexOf(operator);
    if (at >= 0 && (best === -1 || at < best)) {
      best = at;
    }
  }
  return best;
}

/**
 * Every field name an encoded query mentions, or `null` when it cannot be read.
 *
 * The parser is intentionally narrow — `^`-separated conditions with a leading field
 * name, plus `ORDERBY`/`ORDERBYDESC` — because it is a VALIDATOR, not a query engine.
 * A query shape it does not understand must be rejected rather than approximated:
 * approving a query by failing to find a field name in it is the same outcome as not
 * checking at all, which is what D20 forbids. If a future clause form is needed
 * (`^OR`, `^NQ`, `IN`), it is added here deliberately and with a test.
 */
function queryFieldsOf(query: string): string[] | null {
  const fields: string[] = [];
  for (const clause of query.split("^")) {
    if (clause === "") {
      return null;
    }
    if (clause.startsWith(ORDER_BY_DESC)) {
      fields.push(clause.slice(ORDER_BY_DESC.length));
      continue;
    }
    if (clause.startsWith(ORDER_BY)) {
      fields.push(clause.slice(ORDER_BY.length));
      continue;
    }
    const at = firstOperatorIndex(clause);
    if (at <= 0) {
      return null;
    }
    fields.push(clause.slice(0, at));
  }
  return fields;
}

/** The effective field set for a table, as the catalog resolved it (D21 included). */
export function effectiveFieldSet(entry: TableCatalogEntry): Set<string> {
  return new Set(entry.fields.map((field) => field.element));
}

/**
 * D20's gate: refuse any generated query naming a field the catalog does not have.
 *
 * `sys_id` is deliberately NOT validated through here, and that is a considered
 * exclusion rather than an oversight. The keyset cursor and `ORDERBYsys_id` are built
 * inside `@syncrona/sn-transport`, not by this module, and `sys_id` frequently has no
 * `sys_dictionary` row of its own on a child table — so validating it would reject
 * correct queries for a field that is present on every table in the product. This
 * function guards the fields the PLANNER chose to name, which is where a typo can
 * actually originate.
 */
export function assertQueryFieldsCataloged(entry: TableCatalogEntry, query: string): void {
  const fields = queryFieldsOf(query);
  if (fields === null) {
    throw new PlannerQueryError(
      "unparseable-query",
      entry.name,
      `Refusing to issue a query against ${entry.name} that this build cannot validate: ${JSON.stringify(query)} (D20).`
    );
  }
  const known = effectiveFieldSet(entry);
  for (const field of fields) {
    if (!known.has(field)) {
      throw new PlannerQueryError(
        "uncataloged-query-field",
        entry.name,
        `Query field ${JSON.stringify(field)} is not in the catalog for ${entry.name}. ServiceNow ignores unknown query fields silently, so this query would have matched every row instead of failing (D20).`
      );
    }
  }
}

/**
 * The `sysparm_query` fragment for a watermark fetch — validated before it is
 * returned.
 *
 * The value is rendered as `YYYY-MM-DD HH:MM:SS` in UTC. ServiceNow interprets a
 * bare datetime in an encoded query using the SESSION timezone of the account
 * issuing it, so the mirroring account must be configured for UTC (GMT). This is a
 * documented deployment requirement rather than something the client can compensate
 * for: `WATERMARK_OVERLAP_MS` is 5 minutes of commit-vs-stamp skew and is nowhere
 * near large enough to absorb a whole-timezone offset, and a misconfigured account
 * would silently skip up to 13 hours of changes on every incremental sync.
 */
export function buildWatermarkQuery(entry: TableCatalogEntry, watermark: string): string {
  const epochMs = parseInstantMs(watermark);
  if (epochMs === null) {
    throw new PlannerQueryError(
      "unparseable-watermark",
      entry.name,
      `Watermark ${JSON.stringify(watermark)} for ${entry.name} is not a fixed-width instant; refusing to build a query around it.`
    );
  }
  const query = `${WATERMARK_FIELD}>=${toGlideDateTime(epochMs)}`;
  assertQueryFieldsCataloged(entry, query);
  return query;
}

/**
 * The extra `sysparm_query` a planned table needs, or `null` for a sweep.
 *
 * The Fetcher's single entry point for this — it must never assemble a query itself,
 * because then D20's gate would sit on one code path and the requests would go out on
 * another.
 *
 * A `watermark` strategy with no `watermark` value throws rather than returning
 * `null`. The contract says the field is present iff the strategy is `watermark`, but
 * the type permits the disagreement, and the failure mode of returning `null` there
 * is the whole D20 hazard wearing a different hat: an unfiltered full-table download
 * reported to the operator as an incremental fetch.
 */
export function plannedQueryFor(planned: PlannedTable): string | null {
  if (planned.strategy !== "watermark") {
    return null;
  }
  if (planned.watermark === undefined) {
    throw new PlannerQueryError(
      "unparseable-watermark",
      planned.entry.name,
      `Planned table ${planned.entry.name} claims the watermark strategy but carries no watermark; an unfiltered fetch here would be reported as incremental (D20).`
    );
  }
  return buildWatermarkQuery(planned.entry, planned.watermark);
}

/** What the existing mirror tree knows about one table, for watermark derivation. */
export interface TableShardState {
  /**
   * Whether every scope directory for this table holds a complete shard set.
   *
   * INV-4: a shard on disk means that table's sweep finished. Anything less is not a
   * baseline a watermark may be measured against, because the rows that were never
   * written have no `sys_updated_on` on disk to raise the maximum — so the watermark
   * would sit at the last row the interrupted run happened to reach and every row
   * after it would be skipped forever.
   */
  complete: boolean;
  /** Highest `sys_updated_on` across the table's shards, or `null` when there is none. */
  maxSysUpdatedOn: string | null;
}

/**
 * Read the shard state for a set of tables off the existing mirror tree.
 *
 * Separated from {@link planSync} so the planner itself stays pure and synchronous:
 * the plan is the part worth testing exhaustively, and it should not need a
 * filesystem to be exercised.
 *
 * `sysUpdatedOn` values are compared with {@link compareBytewise} rather than parsed.
 * The instance emits a fixed-width `YYYY-MM-DD HH:MM:SS`, and for a fixed-width
 * big-endian format lexical order IS chronological order — so this needs no date
 * arithmetic and cannot be wrong about a timezone. A value that is not in that form
 * simply fails to parse in {@link planSync}, which downgrades the table to a sweep.
 */
export async function loadShardStates(
  fs: WriterFs,
  root: string,
  tables: readonly string[]
): Promise<Map<string, TableShardState>> {
  const states = new Map<string, TableShardState>();
  for (const table of tables) {
    const scopes = await listScopesWithShards(fs, root, table);
    let complete = scopes.length > 0;
    let maxSysUpdatedOn: string | null = null;
    for (const scope of scopes) {
      const set = await loadShardSet(fs, root, scope, table);
      complete = complete && set.complete;
      for (const entry of set.entries.values()) {
        if (maxSysUpdatedOn === null || compareBytewise(entry.sysUpdatedOn, maxSysUpdatedOn) > 0) {
          maxSysUpdatedOn = entry.sysUpdatedOn;
        }
      }
    }
    states.set(table, { complete, maxSysUpdatedOn });
  }
  return states;
}

/** What the planner concluded about one table. */
export type PlanOutcome =
  | "planned"
  | "skipped-empty"
  | "excluded-config"
  | "excluded-tier"
  | "acl-denied";

/**
 * The full record of one table's planning decision.
 *
 * Returned alongside the plan rather than folded into it, because `SyncPlan.tables`
 * is normative (§4.7) and holds only tables that WILL be fetched, while the coverage
 * report has to enumerate the ones that will not and say why (R3: no silent skip).
 * The report generator owns `src/report/*` and consumes these; every field is
 * non-optional so it never has to distinguish "absent" from "not applicable".
 */
export interface TablePlanDecision {
  /** Table name — the join key against the catalog and the coverage rows. */
  table: string;
  /** Tier as the catalog assigned it, so the report can group without re-deriving. */
  tier: 1 | 2 | 3;
  /** What the planner concluded. */
  outcome: PlanOutcome;
  /** Fetch strategy, or `null` when the table is not fetched. */
  strategy: "sweep" | "watermark" | null;
  /** ISO-8601 watermark, or `null` for a sweep or a skipped table. */
  watermark: string | null;
  /** The validated `sysparm_query` fragment, or `null` when none is needed. */
  extraQuery: string | null;
  /** Coverage reason for a table that will not be fetched, or `null`. */
  reason: CoverageReason | null;
  /** Aggregate row count as measured, `null` when the Aggregate call did not answer. */
  expectedRows: number | null;
}

/** Everything {@link planSync} needs. All ambient state arrives as a parameter. */
export interface PlannerInput {
  /** The catalog to plan from — order is irrelevant, §4.5 ordering is applied here. */
  catalog: readonly TableCatalogEntry[];
  /** Effective configuration, already merged and validated. */
  config: MirrorConfig;
  /** Existing shard state per table, from {@link loadShardStates}. Absent means none. */
  shardState?: ReadonlyMap<string, TableShardState>;
  /** `--full` — force a sweep of every included table. */
  full?: boolean;
  /**
   * How many syncs have run against this mirror including this one, 1-based.
   *
   * Supplied rather than counted internally because the count lives in the mirror's
   * own state (`syncCounter.ts`) and the planner must stay pure; the promotion rule
   * is then a function of two numbers that can be tested at every boundary. Absent,
   * this run counts as the first of a cycle.
   */
  syncOrdinal?: number;
  /**
   * `--reconcile` — promote this run to a reconcile whatever the count says.
   *
   * The cadence is the routine path and this is the operator's override for the day
   * the routine is not enough: a deletion known to have happened, a mirror whose
   * counter was lost, an audit. It is deliberately weaker than `--full`, which still
   * wins: both sweep every table, but `full` also refuses to inherit an incremental
   * checkpoint, and an operator who asked for the stronger thing should get it.
   *
   * It does NOT reset the count. A forced reconcile answers a question about today;
   * moving the cadence would silently change when the next automatic one lands.
   */
  reconcile?: boolean;
  /** `--verify-quiescent` — record D1's pre-sweep readings on the plan. */
  verifyQuiescent?: boolean;
  /** Pre-sweep Aggregate readings by table, gathered by the caller before planning. */
  quiescenceReadings?: ReadonlyMap<string, QuiescenceReading>;
  /** A checkpoint being resumed — its sweep identity is adopted when modes agree. */
  resume?: CheckpointState;
  /** Clock seam. */
  now: () => number;
  /** Sweep-id seam — injected so a plan is reproducible in a test. */
  newSweepId: () => string;
}

/**
 * Where this run sits in the §5.4 reconcile cycle.
 *
 * Reported rather than left implicit because the cadence is the mirror's answer to
 * "when do deletions arrive?", and an operator staring at an `incremental` run has
 * no other way to tell whether the reconcile is one sync away or nine. It is also
 * the cheapest possible regression detector for the defect this type was added
 * alongside: a cadence that never advances is visible in one line of output.
 */
export interface SyncCadence {
  /** 1-based position of this run, as supplied by the caller's counter. */
  ordinal: number;
  /** `sync.reconcileEveryNSyncs` as it applied to this run. */
  everyN: number;
  /**
   * Runs still to go before the next automatic reconcile — `0` when this run IS
   * one. `null` when the numbers cannot express a cadence (a non-integer ordinal or
   * an `everyN` below 1), which is the same input on which promotion is refused.
   */
  syncsUntilReconcile: number | null;
  /** Whether `reconcile` (or `full`) promoted this run irrespective of the count. */
  forced: boolean;
}

/** The plan plus the facts the coverage report and the checkpoint need. */
export interface PlanResult {
  /** The normative §4.7 plan handed to the Fetcher. */
  plan: SyncPlan;
  /** ISO-8601 start instant — adopted from the checkpoint on a resume. */
  startedAt: string;
  /** One entry per catalog table, in the same §4.5 order as {@link plan}. */
  decisions: TablePlanDecision[];
  /** Duplicate catalog names that were dropped, keeping the first occurrence. */
  duplicateTables: string[];
  /** This run's position in the reconcile cycle (§5.4). */
  cadence: SyncCadence;
}

/** Coverage reason for each non-planned outcome. */
const REASON_BY_OUTCOME: Record<PlanOutcome, CoverageReason | null> = {
  planned: null,
  // A table measured at zero rows is fully covered, not skipped: there is nothing to
  // fetch and nothing missing, so it carries no coverage reason (T6).
  "skipped-empty": null,
  "excluded-config": "excluded-config",
  "excluded-tier": "excluded-tier",
  "acl-denied": "acl-403",
};

/**
 * How many syncs remain before the periodic reconcile — `0` on the reconcile
 * itself, `null` when the pair does not describe a cadence at all (§5.4).
 *
 * Both guards reject rather than coerce. A zero or negative `reconcileEveryNSyncs`
 * would make `ordinal % n` throw or match everything, and "every sync is a reconcile"
 * is a materially different and far more expensive mirror than the operator asked
 * for — so a nonsensical setting disables promotion instead of maximising it.
 *
 * The countdown and the promotion are one function rather than two because they are
 * one question asked twice. Two implementations of "every Nth" would be two things
 * to keep in step, and the failure mode of them drifting is a report that promises a
 * reconcile on a run that plans an incremental — the mirror lying about exactly the
 * property this cadence exists to provide.
 */
function cadencePosition(ordinal: number, everyN: number): number | null {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    return null;
  }
  if (!Number.isInteger(everyN) || everyN < 1) {
    return null;
  }
  return (everyN - (ordinal % everyN)) % everyN;
}

/**
 * Classify one table against config and catalog status (§5.4).
 *
 * The order of the tests is the priority order and is deliberate: an explicit
 * operator exclusion outranks anything measured, and an ACL denial outranks a tier
 * gate because "we were not allowed to see it" is a materially different report line
 * from "we chose not to fetch it". `tables.include` acts as an override of the tier
 * gate only — it cannot resurrect a table the operator also excluded, and it cannot
 * grant access the instance refused.
 *
 * The config checks duplicate what the catalog's own `status` already says, on
 * purpose. The two are computed from the same config by different modules, and if
 * they ever disagree the safe reading of the disagreement is the one that fetches
 * less.
 */
function classify(
  entry: TableCatalogEntry,
  include: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
  referenceDataEnabled: boolean
): PlanOutcome {
  if (exclude.has(entry.name) || entry.status === "excluded-config") {
    return "excluded-config";
  }
  if (entry.status === "acl-denied") {
    return "acl-denied";
  }
  if (
    !include.has(entry.name) &&
    (entry.status === "excluded-tier" || (entry.tier === 3 && !referenceDataEnabled))
  ) {
    return "excluded-tier";
  }
  // `rowCount === null` is NOT zero — it means the Aggregate API did not answer, and
  // treating an unanswered measurement as an empty table would let INV-5 authorise
  // deleting every record the mirror could not count (T6).
  if (entry.status === "skipped-empty" || entry.rowCount === 0) {
    return "skipped-empty";
  }
  return "planned";
}

/**
 * Choose the fetch strategy for one included table (§5.4).
 *
 * Every downgrade to a sweep is a deliberate refusal to guess. No baseline on disk,
 * an interrupted baseline, an unreadable timestamp, or a table whose catalog has no
 * `sys_updated_on` at all — in each case a watermark would be a claim about which
 * rows are already mirrored that nothing on disk supports. A sweep costs API calls;
 * a wrong watermark costs rows that are never fetched again, because the next run's
 * watermark will be even higher.
 */
function chooseStrategy(
  entry: TableCatalogEntry,
  mode: SyncMode,
  shard: TableShardState | undefined
): { strategy: "sweep" | "watermark"; watermark: string | null } {
  if (mode !== "incremental") {
    return { strategy: "sweep", watermark: null };
  }
  if (shard === undefined || !shard.complete || shard.maxSysUpdatedOn === null) {
    return { strategy: "sweep", watermark: null };
  }
  // D20 applied preventively: a table whose catalog has no `sys_updated_on` cannot
  // be queried by one, and the query that would be built is precisely the kind
  // ServiceNow ignores while returning every row.
  if (!effectiveFieldSet(entry).has(WATERMARK_FIELD)) {
    return { strategy: "sweep", watermark: null };
  }
  const epochMs = parseInstantMs(shard.maxSysUpdatedOn);
  if (epochMs === null) {
    return { strategy: "sweep", watermark: null };
  }
  // The overlap rewind (§9.2): a record's `sys_updated_on` is stamped when the
  // business rule runs, but the row becomes visible when the transaction commits, so
  // a row can appear with a timestamp slightly earlier than the highest one already
  // mirrored. Re-fetching the overlap window is free in bytes — identical records
  // serialize to identical files (INV-1) — and not doing it loses rows permanently.
  return {
    strategy: "watermark",
    watermark: new Date(epochMs - WATERMARK_OVERLAP_MS).toISOString(),
  };
}

/**
 * Derive a {@link SyncPlan} from a catalog (§5.4).
 *
 * Synchronous and free of ambient state: given the same inputs it returns the same
 * plan, including the same `sweepId` and `startedAt`, because both come from injected
 * seams. That is what makes the ordering contract (§4.5) and the D20 gate testable at
 * all, and it is why the shard state is read by a separate function.
 */
export function planSync(input: PlannerInput): PlanResult {
  const { config } = input;
  const ordinal = input.syncOrdinal ?? 1;
  const everyN = config.sync.reconcileEveryNSyncs;
  const syncsUntilReconcile = cadencePosition(ordinal, everyN);
  const forced = input.full === true || input.reconcile === true;
  const mode: SyncMode =
    input.full === true
      ? "full"
      : input.reconcile === true || syncsUntilReconcile === 0
        ? "reconcile"
        : "incremental";
  const cadence: SyncCadence = { ordinal, everyN, syncsUntilReconcile, forced };

  // A resumed checkpoint keeps its sweep identity only while the mode still matches.
  // On a mismatch the planner mints a fresh identity, which is what makes
  // `decideResume` refuse with `different-sweep` instead of the run half-inheriting a
  // list of completed tables whose evidence has different authority (INV-5).
  const carried =
    input.resume !== undefined && input.resume.mode === mode ? input.resume : null;
  const sweepId = carried === null ? input.newSweepId() : carried.sweepId;
  const startedAt = carried === null ? new Date(input.now()).toISOString() : carried.startedAt;

  // §4.5: tier ascending, then name ascending bytewise. `compareBytewise` rather than
  // `localeCompare`, which would order `sys_a` against `sys_B` differently under
  // different locales and rewrite committed files on a machine move.
  const ordered = [...input.catalog].sort(
    (left, right) => left.tier - right.tier || compareBytewise(left.name, right.name)
  );

  const include = new Set(config.tables.include);
  const exclude = new Set(config.tables.exclude);
  const seen = new Set<string>();
  const duplicateTables: string[] = [];
  const decisions: TablePlanDecision[] = [];
  const tables: PlannedTable[] = [];

  for (const entry of ordered) {
    // A duplicated catalog name would produce two plan entries writing the same
    // directory, where the second sweep's shard flush would replace the first's and
    // the coverage report would count the table twice.
    if (seen.has(entry.name)) {
      duplicateTables.push(entry.name);
      continue;
    }
    seen.add(entry.name);

    const outcome = classify(entry, include, exclude, config.tiers.referenceData);
    if (outcome !== "planned") {
      decisions.push({
        table: entry.name,
        tier: entry.tier,
        outcome,
        strategy: null,
        watermark: null,
        extraQuery: null,
        reason: REASON_BY_OUTCOME[outcome],
        expectedRows: entry.rowCount,
      });
      continue;
    }

    const chosen = chooseStrategy(entry, mode, input.shardState?.get(entry.name));
    const planned: PlannedTable = {
      entry,
      strategy: chosen.strategy,
      ...(chosen.watermark === null ? {} : { watermark: chosen.watermark }),
    };
    // Built here, inside the planner, so that D20's gate runs before the plan exists
    // rather than at the moment of the request. A plan that got this far is one whose
    // every generated query field has been proven to be in the catalog.
    const extraQuery = plannedQueryFor(planned);
    tables.push(planned);
    decisions.push({
      table: entry.name,
      tier: entry.tier,
      outcome,
      strategy: chosen.strategy,
      watermark: chosen.watermark,
      extraQuery,
      reason: null,
      expectedRows: entry.rowCount,
    });
  }

  const plan: SyncPlan = {
    sweepId,
    mode,
    tables,
    ...(input.verifyQuiescent === true
      ? { preQuiescence: collectQuiescence(tables, carried, input.quiescenceReadings) }
      : {}),
  };

  return { plan, startedAt, decisions, duplicateTables, cadence };
}

/**
 * Assemble D1's pre-sweep readings for the planned tables.
 *
 * The key is present-or-absent, never fabricated. §4.7's `quiescent` is tri-state and
 * `null` ("not checked") is a different claim from `false` ("checked, and it moved") —
 * so a planned table with no reading gets no entry, and the post-sweep comparison
 * reports it as unchecked rather than inventing a baseline it can then match against.
 * By the same argument the whole key is omitted when `--verify-quiescent` was not
 * passed, and an EMPTY object is emitted when it was but nothing could be read: "we
 * asked and got nothing" and "we never asked" must stay distinguishable.
 *
 * A resumed checkpoint's readings win over freshly gathered ones. They describe the
 * instant the sweep actually began, which is the only instant a quiescence proof can
 * be about; re-reading them after an interruption would move the baseline forward and
 * quietly excuse every change that happened during the outage (D1).
 */
function collectQuiescence(
  tables: readonly PlannedTable[],
  carried: CheckpointState | null,
  fresh: ReadonlyMap<string, QuiescenceReading> | undefined
): Record<string, QuiescenceReading> {
  const readings: Record<string, QuiescenceReading> = {};
  for (const planned of tables) {
    const name = planned.entry.name;
    const reading = carried?.preQuiescence?.[name] ?? fresh?.get(name);
    if (reading !== undefined) {
      readings[name] = reading;
    }
  }
  return readings;
}
