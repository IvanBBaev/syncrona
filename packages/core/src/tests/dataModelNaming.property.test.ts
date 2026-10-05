// SPDX-License-Identifier: GPL-3.0-or-later
//
// AT-R4-4: stable data-model record names, as properties.
//
// A data-model record is named by a composite of its own columns (a choice is
// `<name>.<element>.<value>`). Such names still collide — two choices that
// differ only by language, or only by case on a case-insensitive volume — and
// the builder then suffixes every member of the colliding group with its
// sys_id. These properties pin what makes that usable as a folder name across
// refreshes: the result depends on the record SET, never on the order the
// instance returned it in, and no two records ever share a path.
import { jest } from "@jest/globals";
import fc from "fast-check";
import { buildManifestFromTableAPI } from "../manifestBuilder.js";
import { logger } from "../Logger.js";

type Row = Record<string, string>;

const TABLE = "sys_choice";

const clientFor = (rows: Row[]) =>
  ({
    tableAPIGet: async (table: string, query: string) => {
      const q = String(query);
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") return { data: { result: [{ sys_class_name: TABLE }] } };
      if (table === "sys_db_object") {
        // sys_choice has no sys_scope column, so the builder attributes a choice
        // to the scope through the table it belongs to. Both tables of the
        // generator below are the scope's own.
        if (q.startsWith("sys_scope=")) {
          return { data: { result: [{ name: "incident" }, { name: "x_demo_task" }] } };
        }
        return { data: { result: [{ name: TABLE }] } };
      }
      if (table === "sys_dictionary") {
        // The scope owns no column on another scope's table.
        if (q.startsWith("sys_scope=")) return { data: { result: [] } };
        if (q.includes("internal_type=")) return { data: { result: [] } };
        return {
          data: {
            result: [
              { element: "name", internal_type: "string" },
              { element: "element", internal_type: "string" },
              { element: "value", internal_type: "string" },
              { element: "label", internal_type: "string" },
            ],
          },
        };
      }
      if (table === TABLE && q.startsWith("nameIN")) return { data: { result: rows } };
      return { data: { result: [] } };
    },
  }) as unknown as import("../snClient").SNClient;

const build = async (rows: Row[]): Promise<Record<string, string>> => {
  const manifest = await buildManifestFromTableAPI("x_demo", clientFor(rows), {
    includes: {},
    excludes: {},
    tableOptions: {},
    dataModelTables: [TABLE],
  });
  const records = manifest.tables[TABLE]?.records ?? {};
  // name -> sys_id, the mapping that decides where each record lives on disk.
  return Object.fromEntries(Object.entries(records).map(([name, r]) => [name, r.sys_id]));
};

// A deliberately tiny alphabet so collisions — exact and case-only — are common.
const choiceRow = fc.record({
  sys_id: fc.hexaString({ minLength: 6, maxLength: 6 }),
  name: fc.constantFrom("incident", "x_demo_task"),
  element: fc.constantFrom("state", "State", "priority", ""),
  value: fc.constantFrom("1", "2", ""),
  label: fc.constantFrom("New", "Open"),
});

const rowsAndPermutation = fc
  .uniqueArray(choiceRow, { selector: (r) => r.sys_id, minLength: 1, maxLength: 12 })
  .chain((rows) =>
    fc.tuple(
      fc.constant(rows),
      fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length })
    )
  );

// The documented rule, restated independently of the implementation.
const baseName = (row: Row): string =>
  [row.name, row.element, row.value].filter((part) => part.length > 0).join(".");
const fold = (name: string): string => name.normalize("NFC").toLowerCase();

describe("AT-R4-4: data-model record names (properties)", () => {
  beforeEach(() => {
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not depend on the order the instance returns the records in", async () => {
    await fc.assert(
      fc.asyncProperty(rowsAndPermutation, async ([rows, shuffled]) => {
        expect(await build(shuffled)).toEqual(await build(rows));
      }),
      { numRuns: 100 }
    );
  });

  it("gives every record exactly one path, distinct even on a case-insensitive volume", async () => {
    await fc.assert(
      fc.asyncProperty(rowsAndPermutation, async ([rows]) => {
        const names = await build(rows);
        expect(Object.values(names).sort()).toEqual(rows.map((r) => r.sys_id).sort());
        const folded = Object.keys(names).map(fold);
        expect(new Set(folded).size).toBe(folded.length);
      }),
      { numRuns: 100 }
    );
  });

  it("suffixes every member of a colliding group with its sys_id, and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(rowsAndPermutation, async ([rows]) => {
        const names = await build(rows);
        const groupSize = new Map<string, number>();
        for (const row of rows) {
          const key = fold(baseName(row));
          groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
        }
        for (const row of rows) {
          const base = baseName(row);
          const expected =
            (groupSize.get(fold(base)) ?? 0) > 1 ? `${base}_${row.sys_id}` : base;
          expect(names[expected]).toBe(row.sys_id);
        }
      }),
      { numRuns: 100 }
    );
  });
});
