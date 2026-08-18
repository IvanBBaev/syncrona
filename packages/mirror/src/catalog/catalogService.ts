// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CatalogService — the instance's table universe, as the planner and the
 * coverage report need it (§5.3, design §4.1/§4.2).
 *
 * Two sweeps and no third: `sys_db_object` gives the hierarchy, `sys_dictionary`
 * gives the columns, and everything else — which tier a table is in, which
 * fields survive, whether the table is worth fetching at all — is computed from
 * those two in memory. The alternative (a request per table, as v1's manifest
 * builder does) costs one round trip per table on an instance with thousands of
 * them, and the rate limiter turns that into minutes before the first record is
 * read.
 *
 * The three decisions this module exists to get right
 * ---------------------------------------------------
 *  1. **Discovery is dynamic (design §4.2).** T1 is every table whose
 *     `super_class` chain reaches `sys_metadata`, computed here. No list of
 *     metadata tables appears in this package, so a plugin table nobody has
 *     heard of is mirrored the day it is installed.
 *  2. **Fields are inherited (D21).** A table's effective field set is the UNION
 *     of dictionary rows along its whole chain. Measured on ven01800:
 *     `sys_hub_flow_snapshot` owns 3 dictionary rows and returns 44 fields.
 *     A catalog built from own-name rows only would silently mirror 3 columns of
 *     a 44-column table and every byte of the difference would be lost with no
 *     error anywhere.
 *  3. **Nothing is skipped silently (R3).** Every table the instance admits to
 *     having appears in the output with a `status` that says what happened to
 *     it — including the ones excluded by tier or by config, and including the
 *     ones whose rows the mirroring account cannot read.
 *
 * Ordering is part of the contract, not a convenience: the catalog feeds the
 * plan and the coverage report, and INV-1 makes a re-run against an unchanged
 * instance a byte-identical tree. So the output is sorted (tier, then name)
 * before it leaves, and the input order — which is the instance's `sys_id`
 * order, i.e. effectively random — is not allowed to reach any consumer.
 */
import { SYS_ID_RE } from "../constants";
import type {
  FieldDescriptor,
  MirrorConfig,
  TableAggregate,
  TableCatalogEntry,
  TablePage,
} from "../contracts";
import { MirrorHttpError, type PageRequest } from "../http/client";
import { compareBytewise } from "../order";
import { describeField, isActiveColumnRow, NOISE_ELEMENTS } from "./fieldPolicy";
import { assignTier } from "./tiers";

/**
 * The transport surface the catalog needs — a subset of `MirrorHttpClient`.
 *
 * Declared structurally so the service can be driven by a stub that replays a
 * page sequence no fake instance can produce (a cursor that does not advance, a
 * dictionary row the server should have filtered out). `MirrorHttpClient`
 * satisfies it without implementing anything, and a test asserts that
 * assignability so this interface cannot drift away from the client it stands
 * in for.
 */
export interface CatalogSource {
  getPage(table: string, cursor: string | null, request: PageRequest): Promise<TablePage>;
  getAggregate(table: string, extraQuery?: string): Promise<TableAggregate | null>;
}

/** Something about the instance's schema that the catalog had to work around. */
export type CatalogAnomalyKind =
  /** A `sys_db_object` row with no usable name or no valid sys_id (INV-6). */
  | "unusable-table-row"
  /** Two `sys_db_object` rows claiming the same table name. */
  | "duplicate-table"
  /** A `super_class` pointing at a sys_id no `sys_db_object` row has. */
  | "dangling-super-class"
  /** A `super_class` chain that returns to a table it already visited. */
  | "cyclic-super-class";

/**
 * One schema anomaly, in reportable form.
 *
 * These are not thrown. A broken hierarchy is a property of the instance, not a
 * failure of the mirror, and a run that aborted on one would be a run that
 * cannot mirror an instance with a single bad row — while R3 still demands that
 * the operator be told. So the affected table gets the honest answer (its chain
 * stops where the evidence stops) and the reason travels alongside it.
 */
export interface CatalogAnomaly {
  kind: CatalogAnomalyKind;
  /** Table the anomaly is about. */
  table: string;
  /** Human-readable specifics, including the value that could not be resolved. */
  detail: string;
}

/**
 * What was suppressed for one table, decomposed as D7 requires.
 *
 * `FieldDescriptor.isNoise` is one boolean over two very different decisions —
 * the engine's built-in churn list and the operator's own `ignoreFields` — and
 * a coverage report that could only say "suppressed" would leave an operator
 * unable to tell a mirror bug from their own configuration. The boolean stays
 * (the serializer wants exactly one question answered); the decomposition lives
 * here.
 */
export interface TableSuppressions {
  table: string;
  /** Built-in churn columns dropped by the engine. */
  engineNoise: string[];
  /** Columns dropped because `PerTableConfig.ignoreFields` named them. */
  userIgnored: string[];
  /** Columns dropped because their TYPE is never safe to mirror (D19). */
  denied: string[];
}

/** Everything one catalog build produced. */
export interface CatalogBuildResult {
  /** Every discovered table, sorted by (tier, name) — INV-1. */
  tables: TableCatalogEntry[];
  /** Schema problems found while building, in a content-derived order (INV-1). */
  anomalies: CatalogAnomaly[];
  /** Suppression breakdown for the included tables only, in `tables` order (D7). */
  suppressions: TableSuppressions[];
  /**
   * `sys_db_object.sys_scope` per table, keyed in the same order as `tables`.
   *
   * Kept out of {@link TableCatalogEntry} because that contract is not mine to
   * change, and kept at all because §5.3 sweeps the column: the scope a TABLE is
   * defined in is what lets the coverage report group by application. It is
   * deliberately not used to filter — M11 measured that `sys_choice` has no
   * `sys_scope` at all, so a catalog that dropped scopeless tables would drop
   * real configuration, and `MirrorConfig.scopes` is about the scope of a RECORD
   * anyway.
   */
  scopeSysIdByTable: Record<string, string>;
}

/** Construction inputs. */
export interface CatalogServiceOptions {
  /** Transport to read the two schema tables through. */
  source: CatalogSource;
  /** Config whose include/exclude/perTable rules decide `status` and suppressions. */
  config: MirrorConfig;
}

/** Columns of `sys_db_object` the hierarchy needs (`sys_id` is forced in by the query builder). */
const TABLE_SWEEP_FIELDS: readonly string[] = ["name", "super_class", "sys_scope"];

/** Columns of `sys_dictionary` a {@link FieldDescriptor} is built from. */
const DICTIONARY_SWEEP_FIELDS: readonly string[] = [
  "name",
  "element",
  "internal_type",
  "reference",
  "max_length",
  "active",
];

/**
 * Server-side filter for the dictionary sweep.
 *
 * A bandwidth optimization and NOTHING MORE: M12/D20 measured that a condition
 * naming a column the table does not have is silently dropped and the query
 * then matches every row, so a run where this filter quietly evaporates must
 * still produce the same catalog. `isActiveColumnRow` re-checks every row that
 * comes back, which is what makes that true.
 */
const ACTIVE_COLUMNS_QUERY = "active=true";

/** One `sys_db_object` row, reduced to what the hierarchy walk uses. */
interface TableRecord {
  name: string;
  sysId: string;
  /** Raw `super_class` value — a sys_id, or `""` for a root table (M8). */
  superSysId: string;
  /** Raw `sys_scope` value — a sys_id, or `""` where the table has no scope column (M11). */
  scopeSysId: string;
}

/**
 * One catalog entry plus the two things the assembly pass still needs and the
 * {@link TableCatalogEntry} contract has no room for: the table's own scope, and
 * the operator's suppressions for it. Carried alongside rather than looked up
 * again afterwards, so that sorting the entries cannot desynchronize them.
 */
interface CatalogRow {
  entry: TableCatalogEntry;
  scopeSysId: string;
  ignoreFields: ReadonlySet<string>;
}

/** Result of walking one table's `super_class` chain. */
interface ChainWalk {
  /** Root first, the table itself last — the order D21's override rule needs. */
  chain: TableRecord[];
  /** The anomaly the walk hit, if it hit one. */
  anomaly: CatalogAnomaly | null;
}

/**
 * Sort key that makes two anomalies with the same table (or the same kind) still
 * deterministic.
 *
 * The separator is NUL, written as an escape rather than as a literal byte. NUL
 * is the one character a ServiceNow table name, an anomaly kind and a detail
 * string can never contain, so it is the only separator that cannot be forged by
 * a value into colliding with a different triple. Written literally it also made
 * this file binary to every text tool — `grep` silently reports no matches in a
 * file it detects as binary, which is a bad property for a source file to have.
 */
const anomalyKey = (anomaly: CatalogAnomaly): string =>
  `${anomaly.table}\u0000${anomaly.kind}\u0000${anomaly.detail}`;

/**
 * Builds the table catalog for one instance.
 *
 * Stateless between builds: `build()` reads the instance fresh every time and
 * shares nothing with a previous call, because the schema is exactly the thing
 * that changes when someone installs a plugin mid-run.
 */
export class CatalogService {
  private readonly source: CatalogSource;
  private readonly config: MirrorConfig;

  constructor(options: CatalogServiceOptions) {
    this.source = options.source;
    this.config = options.config;
  }

  /** Read the instance and produce the catalog. */
  async build(): Promise<CatalogBuildResult> {
    const anomalies: CatalogAnomaly[] = [];

    const tableRows = await this.sweep("sys_db_object", { fields: TABLE_SWEEP_FIELDS });
    const records = this.indexTables(tableRows, anomalies);

    const dictionaryRows = await this.sweep("sys_dictionary", {
      fields: DICTIONARY_SWEEP_FIELDS,
      extraQuery: ACTIVE_COLUMNS_QUERY,
    });
    const dictionary = indexDictionary(dictionaryRows);

    const bySysId = new Map(records.map((record) => [record.sysId, record] as const));
    const tableNameOfSysId = (sysId: string): string | null => bySysId.get(sysId)?.name ?? null;

    const rows: CatalogRow[] = [];

    for (const record of records) {
      const walk = walkSuperClassChain(record, bySysId);
      if (walk.anomaly !== null) {
        anomalies.push(walk.anomaly);
      }
      const isMetadata = walk.chain.some((link) => link.name === "sys_metadata");
      const { tier, kind } = assignTier(record.name, isMetadata);
      const ignoreFields = new Set(this.config.tables.perTable[record.name]?.ignoreFields ?? []);
      const fields = resolveFields(walk.chain, dictionary, { ignoreFields, tableNameOfSysId });
      const status = this.classify(record.name, kind);

      rows.push({
        entry: {
          name: record.name,
          sysId: record.sysId,
          // A dangling `super_class` reports as no parent rather than as the
          // unresolvable sys_id: `superClass` is documented as a table NAME, and
          // a consumer handed 32 hex characters would look for a table by that
          // name and find nothing. The anomaly above carries the raw value.
          superClass: bySysId.get(record.superSysId)?.name ?? null,
          isMetadata,
          tier,
          rowCount: null,
          maxUpdatedOn: null,
          fields,
          status,
        },
        scopeSysId: record.scopeSysId,
        ignoreFields,
      });
    }

    // Enrichment before sorting, because it can still change a status
    // (`skipped-empty`, `acl-denied`) and the suppression list below must
    // describe what will actually be written.
    for (const row of rows) {
      await this.enrich(row.entry);
    }

    rows.sort(
      (left, right) =>
        left.entry.tier - right.entry.tier || compareBytewise(left.entry.name, right.entry.name)
    );
    anomalies.sort((left, right) => compareBytewise(anomalyKey(left), anomalyKey(right)));

    const tables: TableCatalogEntry[] = [];
    const suppressions: TableSuppressions[] = [];
    const scopeSysIdByTable: Record<string, string> = {};
    for (const row of rows) {
      tables.push(row.entry);
      scopeSysIdByTable[row.entry.name] = row.scopeSysId;
      if (row.entry.status === "included") {
        suppressions.push(
          summarizeSuppressions(row.entry.name, row.entry.fields, row.ignoreFields)
        );
      }
    }

    return { tables, anomalies, suppressions, scopeSysIdByTable };
  }

  /**
   * Read a whole table through the keyset cursor.
   *
   * The stall guard is not defensive decoration. The loop's exit condition is
   * the server's `done` flag, so a server that returns a full page and a cursor
   * that does not move — a proxy replaying a cached response, an instance whose
   * `ORDERBYsys_id` was rewritten — spins forever, holding the rate limiter and
   * producing nothing. `schema-drift` (F5) is the honest class: the instance
   * answered, and the answer contradicts the ordering the protocol is built on.
   */
  private async sweep(table: string, request: PageRequest): Promise<Array<Record<string, string>>> {
    const rows: Array<Record<string, string>> = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.source.getPage(table, cursor, request);
      for (const row of page.rows) {
        rows.push(row);
      }
      if (page.done) {
        return rows;
      }
      const next = page.lastSysId;
      if (next === null || (cursor !== null && next <= cursor)) {
        throw new MirrorHttpError(
          "schema-drift",
          `${table} paging did not advance past ${cursor ?? "the first page"}`
        );
      }
      cursor = next;
    }
  }

  /**
   * Turn raw `sys_db_object` rows into hierarchy records.
   *
   * Both rejections produce an anomaly rather than an exception, for the reason
   * {@link CatalogAnomaly} gives. The first row wins a duplicate-name fight
   * because the sweep arrives in `sys_id` order, so "first" is a property of the
   * data and not of the schedule — INV-1 would be lost to whichever row happened
   * to be paged first otherwise.
   */
  private indexTables(
    rows: ReadonlyArray<Record<string, string>>,
    anomalies: CatalogAnomaly[]
  ): TableRecord[] {
    const byName = new Map<string, TableRecord>();
    for (const row of rows) {
      const name = row.name ?? "";
      const sysId = row.sys_id ?? "";
      if (name === "" || !SYS_ID_RE.test(sysId)) {
        anomalies.push({
          kind: "unusable-table-row",
          table: name,
          detail: `sys_db_object row ${sysId === "" ? "(no sys_id)" : sysId} has no usable name/sys_id pair`,
        });
        continue;
      }
      const existing = byName.get(name);
      if (existing !== undefined) {
        anomalies.push({
          kind: "duplicate-table",
          table: name,
          detail: `sys_db_object row ${sysId} repeats a name already claimed by ${existing.sysId}`,
        });
        continue;
      }
      byName.set(name, {
        name,
        sysId,
        superSysId: row.super_class ?? "",
        scopeSysId: row.sys_scope ?? "",
      });
    }
    return [...byName.values()];
  }

  /**
   * Decide what happens to a table, in a fixed precedence order.
   *
   * The order of these branches IS the precedence, and it is deliberate:
   *
   *  1. `exclude` beats everything, including `include`. An operator who names
   *     a table in both has asked two questions at once, and the safe answer to
   *     "should this leave the instance?" is no. (`loadMirrorConfig` rejects the
   *     overlap outright; this is the last line of defence for a config object
   *     assembled in code, exactly as the client clamps a rate limit the loader
   *     would have rejected.)
   *  2. `include` beats the tier rules — that is what "force-included beyond the
   *     tier rules" means in the contract, and it is the only way to mirror a
   *     table the engine bands as T4.
   *  3. T1/T2 are mirrored by default; T3 only when `tiers.referenceData` is on;
   *     everything else is `excluded-tier`, named in the report but not fetched.
   */
  private classify(name: string, kind: ReturnType<typeof assignTier>["kind"]): TableCatalogEntry["status"] {
    if (this.config.tables.exclude.includes(name)) {
      return "excluded-config";
    }
    if (this.config.tables.include.includes(name)) {
      return "included";
    }
    if (kind === "metadata" || kind === "config-table") {
      return "included";
    }
    if (kind === "reference-data" && this.config.tiers.referenceData) {
      return "included";
    }
    return "excluded-tier";
  }

  /**
   * Attach `rowCount`/`maxUpdatedOn`, and let the aggregate refine the status.
   *
   * Only included tables are counted: an aggregate costs a request, and asking
   * for the row count of a table the run will never fetch spends the rate limit
   * on a number no consumer reads.
   *
   * A null aggregate is AMBIGUOUS — §5.2 collapses acl, schema-drift, transient
   * and parse into it — so it cannot by itself mean "denied". One 1-row page
   * request disambiguates: if the rows come back, the table is readable and only
   * the aggregate was refused (some instances restrict `stats` separately), and
   * the entry stays included with an unknown count. `auth`, `unreachable` and
   * `hibernating` are never swallowed here, by either call: a catalog built
   * against a hibernating instance would be an EMPTY catalog, and an empty
   * catalog is indistinguishable from an instance with nothing on it — the
   * planner would then plan nothing, the reconciler would see every local file
   * as an orphan, and a `--prune` run would delete the entire mirror. That is
   * the one failure mode that must be loud.
   */
  private async enrich(entry: TableCatalogEntry): Promise<void> {
    if (entry.status !== "included") {
      return;
    }
    const aggregate = await this.source.getAggregate(entry.name);
    if (aggregate !== null) {
      entry.rowCount = aggregate.count;
      entry.maxUpdatedOn = aggregate.maxUpdatedOn;
      if (aggregate.count === 0) {
        // T6: an empty table is not fetched at all, and says so in the report.
        entry.status = "skipped-empty";
      }
      return;
    }
    if ((await this.probeReadable(entry.name)) === "acl") {
      entry.status = "acl-denied";
    }
  }

  /**
   * Ask for one row to find out whether a null aggregate meant "denied".
   *
   * Returns the failure class that answered, or null when the table read fine.
   * Fatal classes are rethrown rather than reported, for the reason
   * {@link CatalogService.enrich} gives; anything else leaves the table included
   * with an unknown count, which is the honest state — the run will find out
   * when it fetches.
   */
  private async probeReadable(table: string): Promise<string | null> {
    try {
      await this.source.getPage(table, null, { fields: ["sys_id"], pageSize: 1 });
      return null;
    } catch (error) {
      if (!(error instanceof MirrorHttpError)) {
        throw error;
      }
      if (
        error.failureClass === "auth" ||
        error.failureClass === "unreachable" ||
        error.failureClass === "hibernating"
      ) {
        throw error;
      }
      return error.failureClass;
    }
  }
}

/**
 * Group dictionary rows by the table that OWNS them.
 *
 * Owning is not the same as having: `sys_hub_flow_snapshot` owns two rows and
 * has seventeen fields. The union happens in {@link resolveFields}; this index
 * only has to be honest about ownership.
 */
function indexDictionary(
  rows: ReadonlyArray<Record<string, string>>
): Map<string, Array<Record<string, string>>> {
  const byTable = new Map<string, Array<Record<string, string>>>();
  for (const row of rows) {
    if (!isActiveColumnRow(row)) {
      continue;
    }
    const table = row.name ?? "";
    const existing = byTable.get(table);
    if (existing === undefined) {
      byTable.set(table, [row]);
    } else {
      existing.push(row);
    }
  }
  return byTable;
}

/**
 * Walk one table's `super_class` chain to its root.
 *
 * Two ways the walk can end badly, and both must end — the catalog runs against
 * whatever the instance contains, and neither a hang nor a throw is an
 * acceptable answer to a bad row:
 *
 *  - **Dangling**: `super_class` names a sys_id no row has (an uninstalled
 *    plugin leaves these behind; the committed fixture has one on purpose). The
 *    chain stops there, and the table is treated as everything the walk COULD
 *    prove — so a dangling table is not metadata unless the visited part already
 *    reached `sys_metadata`. Guessing the other way would mirror a table on the
 *    strength of a pointer to nothing.
 *  - **Cyclic**: the chain returns to a table it already visited. The `seen` set
 *    is what makes this terminate; without it the loop is infinite, which on a
 *    catalog build means a hang with no output and no error.
 *
 * Either way the visited prefix is returned as the chain, because a partial
 * truth about a table's fields beats no table at all — and the anomaly rides
 * along so the report can say which of the two happened.
 */
function walkSuperClassChain(
  record: TableRecord,
  bySysId: ReadonlyMap<string, TableRecord>
): ChainWalk {
  const chain: TableRecord[] = [];
  const seen = new Set<string>();
  let current = record;
  for (;;) {
    // Root-first: D21's union lets a child override an inherited column, and
    // "override" only means anything if the parent's row is written first.
    chain.unshift(current);
    seen.add(current.sysId);
    if (current.superSysId === "") {
      return { chain, anomaly: null };
    }
    const parent = bySysId.get(current.superSysId);
    if (parent === undefined) {
      return {
        chain,
        anomaly: {
          kind: "dangling-super-class",
          table: record.name,
          detail: `${current.name}.super_class points at ${current.superSysId}, which no sys_db_object row has`,
        },
      };
    }
    if (seen.has(parent.sysId)) {
      return {
        chain,
        anomaly: {
          kind: "cyclic-super-class",
          table: record.name,
          detail: `${current.name}.super_class returns to ${parent.name}, which the chain already visited`,
        },
      };
    }
    current = parent;
  }
}

/**
 * The effective field set: the union along the chain, child last (D21).
 *
 * A `Map` keyed by element does both jobs at once — union and override — and the
 * override direction is the one the platform uses: a child's dictionary row for
 * an inherited element redefines it (a longer `max_length`, a different
 * reference), so the last write along a root-first chain must win.
 *
 * `ignoreFields` belongs to the table being described, never to the table that
 * owns the row: suppressing `description` on `sys_hub_flow_snapshot` must not
 * suppress it on `sys_hub_flow_base`, which is a different file in the tree.
 */
function resolveFields(
  chain: readonly TableRecord[],
  dictionary: ReadonlyMap<string, Array<Record<string, string>>>,
  context: { ignoreFields: ReadonlySet<string>; tableNameOfSysId: (sysId: string) => string | null }
): FieldDescriptor[] {
  const byElement = new Map<string, FieldDescriptor>();
  for (const link of chain) {
    for (const row of dictionary.get(link.name) ?? []) {
      const descriptor = describeField(row, context);
      byElement.set(descriptor.element, descriptor);
    }
  }
  return [...byElement.values()].sort((left, right) =>
    compareBytewise(left.element, right.element)
  );
}

/**
 * Split a table's suppressions into the three answers D7 asks for.
 *
 * Read off the resolved descriptors rather than off the policy sets a second
 * time, so the report can only ever describe fields that actually exist on the
 * table — an `ignoreFields` entry naming a column the table does not have shows
 * up as an empty list here, not as a phantom suppression.
 */
function summarizeSuppressions(
  table: string,
  fields: readonly FieldDescriptor[],
  ignoreFields: ReadonlySet<string>
): TableSuppressions {
  const engineNoise: string[] = [];
  const userIgnored: string[] = [];
  const denied: string[] = [];
  for (const field of fields) {
    if (NOISE_ELEMENTS.has(field.element)) {
      engineNoise.push(field.element);
    } else if (ignoreFields.has(field.element)) {
      userIgnored.push(field.element);
    }
    if (field.isDenied) {
      denied.push(field.element);
    }
  }
  return { table, engineNoise, userIgnored, denied };
}
