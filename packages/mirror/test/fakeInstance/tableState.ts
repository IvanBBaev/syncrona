// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mutable per-table state behind the fake instance's Table API.
 *
 * The state exists because §5.14 requires mid-sweep mutation: the analyses §1
 * consistency scenarios (insert behind the cursor, insert ahead of it, delete
 * ahead of it, update in place) can only be replayed against a table whose
 * contents change between two page requests. A read-only fixture can prove that
 * paging visits every row; only a mutable one can prove what happens when the
 * rows move under the cursor.
 *
 * Rows are kept in a sorted key array plus a body map rather than in a single
 * sorted array of objects. Three reasons:
 *
 *   - Keyset paging is defined by sys_id order, so the key array IS the index;
 *     a page is a binary search plus a bounded scan.
 *   - An insert costs one splice instead of a re-sort, which matters because a
 *     mutation script fires between two pages and a re-sort there would be the
 *     one place a stale comparator could reorder rows the client already saw.
 *   - It lets the >16 000-row table exist without bodies: the key array is
 *     materialized lazily and each body is synthesized from its own sys_id.
 */
import {
  synthesizeBulkRow,
  synthesizeBulkSysIds,
  type FixtureColumn,
  type FixtureRow,
  type FixtureTable,
} from "./corpus";
import {
  evaluateQuery,
  rowMatchesAll,
  splitConditions,
  type ParsedQuery,
  type QueryCondition,
} from "./query";

/** Index of the first element >= `value`. */
function lowerBound(keys: readonly string[], value: string): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((keys[mid] as string) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Index of the first element > `value`. */
function upperBound(keys: readonly string[], value: string): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((keys[mid] as string) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface PageResult {
  rows: FixtureRow[];
  /** Fields the query named and the table does not have (M12). */
  droppedFields: string[];
  /**
   * Total matching rows, or null when computing it would have forced the
   * synthetic table to materialize. Only feeds `X-Total-Count`, which the
   * mirror always suppresses anyway.
   */
  total: number | null;
}

export class TableState {
  readonly definition: FixtureTable;
  /** Own + inherited wire columns, keyed by element. Phantoms are absent by construction. */
  readonly columns: ReadonlyMap<string, FixtureColumn>;
  readonly wireFields: ReadonlySet<string>;

  /** Sorted sys_ids. `null` means "synthetic and not materialized yet". */
  #keys: string[] | null;
  /** Explicit bodies: every corpus row, plus any row a mutation created or patched. */
  readonly #stored: Map<string, FixtureRow>;
  readonly #synthetic: { rowCount: number; seed: number } | null;

  constructor(definition: FixtureTable, columns: readonly FixtureColumn[]) {
    this.definition = definition;
    this.columns = new Map(columns.map((column) => [column.element, column] as const));
    this.wireFields = new Set(columns.map((column) => column.element));
    this.#synthetic = definition.synthetic;
    this.#stored = new Map(definition.rows.map((row) => [row.sys_id as string, { ...row }] as const));
    // A materialized table's keys are known immediately; a synthetic table's
    // are built on first use, which is what keeps 24 000 sys_ids out of both
    // the committed corpus and the start-up cost of every unrelated test.
    this.#keys = definition.synthetic ? null : [...this.#stored.keys()].sort();
  }

  get name(): string {
    return this.definition.name;
  }

  /**
   * Row count.
   *
   * This is the one operation that must NOT materialize a synthetic table: the
   * §5.10/D1 quiescence probe counts every table twice per run, and forcing
   * 24 000 row bodies into memory to answer "how many?" would make the cheap
   * proof the expensive one.
   */
  count(): number {
    if (this.#keys !== null) return this.#keys.length;
    return this.#synthetic?.rowCount ?? 0;
  }

  #materializedKeys(): string[] {
    if (this.#keys === null) {
      /* c8 ignore next -- #keys is only null while #synthetic is set */
      const synthetic = this.#synthetic as { rowCount: number; seed: number };
      this.#keys = synthesizeBulkSysIds(synthetic.seed, synthetic.rowCount);
    }
    return this.#keys;
  }

  #bodyAt(key: string): FixtureRow {
    const stored = this.#stored.get(key);
    if (stored) return stored;
    return synthesizeBulkRow(key, this.definition.name, this.definition.scopeSysId);
  }

  /** A row by sys_id, or undefined if the table does not hold it. */
  rowOf(sysId: string): FixtureRow | undefined {
    const stored = this.#stored.get(sysId);
    if (stored) return stored;
    if (this.#synthetic === null) return undefined;
    const keys = this.#materializedKeys();
    return keys[lowerBound(keys, sysId)] === sysId ? this.#bodyAt(sysId) : undefined;
  }

  /** Every row, in sys_id order. Materializes a synthetic table. */
  allRows(): FixtureRow[] {
    return this.#materializedKeys().map((key) => this.#bodyAt(key));
  }

  /**
   * Serve one page.
   *
   * The keyset fast path (`ORDERBYsys_id` ascending plus cursor conditions on
   * `sys_id`) narrows the key array by binary search and materializes only the
   * rows it returns. Any other shape falls back to materializing the table,
   * which is correct but costs all 24 000 bodies on the bulk table — acceptable,
   * because the mirror never issues such a query and only a test that
   * deliberately asks for one pays for it.
   */
  page(parsed: ParsedQuery, limit: number): PageResult {
    const { effective, droppedFields } = splitConditions(parsed.conditions, this.wireFields);
    const isKeysetShape =
      parsed.orderBy.length === 1 &&
      parsed.orderBy[0]?.field === "sys_id" &&
      parsed.orderBy[0]?.descending === false;

    if (!isKeysetShape || this.#synthetic === null) {
      const evaluated = evaluateQuery(this.allRows(), parsed, this.wireFields, this.name);
      return {
        rows: evaluated.rows.slice(0, limit),
        droppedFields: evaluated.droppedFields,
        total: evaluated.rows.length,
      };
    }

    const keys = this.#materializedKeys();
    let start = 0;
    for (const condition of effective) {
      if (condition.field !== "sys_id") continue;
      if (condition.operator === ">") start = Math.max(start, upperBound(keys, condition.value));
      else if (condition.operator === ">=") start = Math.max(start, lowerBound(keys, condition.value));
    }

    const rows: FixtureRow[] = [];
    for (let index = start; index < keys.length && rows.length < limit; index += 1) {
      const row = this.#bodyAt(keys[index] as string);
      if (rowMatchesAll(row, effective)) rows.push(row);
    }
    // `total` stays null here on purpose: counting would defeat the windowing
    // this path exists for, and its only consumer is a pagination header the
    // mirror suppresses (INV-2's keyset-only rule).
    return { rows, droppedFields, total: null };
  }

  /** Greatest `sys_updated_on` among matching rows, or null when there are none (§5.10/D1). */
  maxUpdatedOn(conditions: readonly QueryCondition[]): string | null {
    const { effective } = splitConditions(conditions, this.wireFields);
    let max: string | null = null;
    for (const row of this.allRows()) {
      if (!rowMatchesAll(row, effective)) continue;
      const value = row.sys_updated_on ?? "";
      // Lexicographic max is chronological max because of M9's zero-padded
      // `YYYY-MM-DD HH:MM:SS` format. No date parsing, no timezone question.
      if (value !== "" && (max === null || value > max)) max = value;
    }
    return max;
  }

  /** Count of matching rows; falls back to {@link count} when nothing filters. */
  countMatching(conditions: readonly QueryCondition[]): number {
    const { effective } = splitConditions(conditions, this.wireFields);
    if (effective.length === 0) return this.count();
    return this.allRows().filter((row) => rowMatchesAll(row, effective)).length;
  }

  /**
   * Insert a row.
   *
   * Missing wire columns are filled with `""` rather than left absent, because
   * M8 says that is what the wire does; a test-inserted row that behaved
   * differently from a corpus row would make mid-sweep assertions depend on
   * which of the two the client happened to see.
   */
  insert(partial: FixtureRow): FixtureRow {
    const sysId = partial.sys_id;
    if (typeof sysId !== "string" || sysId === "") {
      throw new Error(`insert into ${this.name} requires an explicit sys_id`);
    }
    const row: FixtureRow = {};
    for (const element of this.wireFields) row[element] = partial[element] ?? "";
    for (const [key, value] of Object.entries(partial)) row[key] = value;

    // Mutating a synthetic table materializes it: a splice needs the key array,
    // and a caller who is scripting mutations against the bulk table has
    // already decided to pay for its rows.
    const keys = this.#materializedKeys();
    const index = lowerBound(keys, sysId);
    if (keys[index] !== sysId) keys.splice(index, 0, sysId);
    this.#stored.set(sysId, row);
    return row;
  }

  /** Patch a row in place, leaving its position in the key order untouched. */
  update(sysId: string, fields: Record<string, string>): FixtureRow {
    const current = this.rowOf(sysId);
    if (!current) throw new Error(`cannot update missing row ${sysId} in ${this.name}`);
    const next: FixtureRow = { ...current, ...fields, sys_id: sysId };
    this.#stored.set(sysId, next);
    return next;
  }

  /** Remove a row. Returns whether it was there. */
  remove(sysId: string): boolean {
    const keys = this.#materializedKeys();
    const index = lowerBound(keys, sysId);
    const existed = keys[index] === sysId;
    if (existed) keys.splice(index, 1);
    this.#stored.delete(sysId);
    return existed;
  }
}
