// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
import {
  buildManifestFromTableAPI,
  withStableOrder,
} from "../manifestBuilder.js";

// Two defects in one seam.
//
// (1) Unstable paging: tableAPIGetAllRows walks `offset += pageSize` over a
//     query with no ORDERBY. The Table API is free to return rows in a
//     different order for the second request, and a row that crosses a page
//     boundary in between is then never returned at all. It never reaches the
//     manifest, findOrphanFiles reports its local file as unclaimed, and
//     `repair --apply --prune` deletes it.
//
// (2) Silent truncation: field discovery and table discovery called
//     client.tableAPIGet directly with a fixed limit and no offset loop, so a
//     table with more dictionary rows than the limit produced a manifest that
//     was quietly missing fields — no error, no warning, and every later run
//     repeated the same partial answer.

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, string>[] } }>,
  [string, string, string, number?, number?]
>;

function createClient(tableAPIGet: TableApiGet) {
  return { tableAPIGet } as unknown as import("../snClient").SNClient;
}

const emptyConfig: Pick<Sync.Config, "includes" | "excludes" | "tableOptions"> =
  {
    includes: {},
    excludes: {},
    tableOptions: {},
  };

describe("withStableOrder", () => {
  it("appends a sys_id ordering to a query that has none", () => {
    expect(withStableOrder("sys_scope=scope-1")).toBe(
      "sys_scope=scope-1^ORDERBYsys_id"
    );
  });

  it("orders an empty query without emitting a leading caret", () => {
    // "^ORDERBYsys_id" would read as an empty first condition.
    expect(withStableOrder("")).toBe("ORDERBYsys_id");
  });

  it("leaves an ordering the caller already chose alone", () => {
    // ServiceNow honours the FIRST ORDERBY as the primary key, so appending
    // ours would silently demote theirs rather than replace it.
    expect(withStableOrder("active=true^ORDERBYname")).toBe(
      "active=true^ORDERBYname"
    );
    expect(withStableOrder("active=true^ORDERBYDESCsys_updated_on")).toBe(
      "active=true^ORDERBYDESCsys_updated_on"
    );
    expect(withStableOrder("ORDERBYname")).toBe("ORDERBYname");
  });

  it("does not mistake a field whose name merely contains 'orderby'", () => {
    // The clause is only an ordering at the start of the query or right after
    // a `^`; `u_orderby` is an ordinary column.
    expect(withStableOrder("u_orderby=1")).toBe("u_orderby=1^ORDERBYsys_id");
  });
});

describe("manifest paging", () => {
  it("walks every records page under a stable sys_id ordering", async () => {
    // A full first page forces a second request. Both must carry the same
    // ordered query, or the two offsets index into two different orders.
    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      sys_id: `rec-${i}`,
      name: `Include ${i}`,
      script: "gs.info('x');",
    }));

    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(
      async (table: string, _q: string, _f: string, _l?: number, offset?: number) => {
        if (table === "sys_app")
          return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        if (table === "sys_dictionary")
          return {
            data: {
              result: [{ element: "script", internal_type: "script_plain" }],
            },
          };
        if (table === "sys_script_include") {
          return {
            data: {
              result:
                offset === 0
                  ? firstPage
                  : [
                      {
                        sys_id: "rec-500",
                        name: "Include 500",
                        script: "gs.info('y');",
                      },
                    ],
            },
          };
        }
        return { data: { result: [] } };
      }
    );

    await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    const recordCalls = tableAPIGet.mock.calls.filter(
      (c) => c[0] === "sys_script_include"
    );
    expect(recordCalls).toHaveLength(2);
    for (const call of recordCalls) {
      expect(call[1]).toMatch(/\^ORDERBYsys_id$/);
    }
    // Same query text on both requests — an offset only means the same row on
    // the second request if the ordering it indexes into is identical.
    expect(recordCalls[0][1]).toBe(recordCalls[1][1]);
  });

  it("pages sys_dictionary field discovery past its limit instead of truncating", async () => {
    // Exactly 200 rows (the discovery page size) on the first page: the old
    // code stopped here and reported a table whose fields ended at 200.
    const firstFieldPage = Array.from({ length: 200 }, (_, i) => ({
      element: `field_${i}`,
      internal_type: "script_plain",
    }));

    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(
      async (table: string, _q: string, fields: string, _l?: number, offset?: number) => {
        if (table === "sys_app")
          return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        if (table === "sys_db_object") {
          // Single-row hierarchy lookup: no parent class.
          return { data: { result: [{ name: "sys_script_include" }] } };
        }
        if (table === "sys_dictionary" && fields === "element,internal_type") {
          return {
            data: {
              result:
                offset === 0
                  ? firstFieldPage
                  : [{ element: "late_field", internal_type: "script_plain" }],
            },
          };
        }
        if (table === "sys_script_include") {
          return {
            data: {
              result: [
                { sys_id: "rec-1", name: "Include A", script: "gs.info('a');" },
              ],
            },
          };
        }
        return { data: { result: [] } };
      }
    );

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    const files =
      manifest.tables.sys_script_include.records["Include A"].files.map(
        (f) => f.name
      );
    expect(files).toHaveLength(201);
    // The field that only exists on the second page is what truncation lost.
    expect(files).toContain("late_field");

    const dictOffsets = tableAPIGet.mock.calls
      .filter((c) => c[0] === "sys_dictionary" && c[2] === "element,internal_type")
      .map((c) => c[4]);
    expect(dictOffsets).toEqual([0, 200]);
  });

  it("pages the sys_db_object table list past its limit", async () => {
    // sys_metadata discovery returns nothing, so table discovery falls through
    // to sys_db_object. A truncated table list is invisible: the missing tables
    // simply never appear, and `repair --prune` treats their already-downloaded
    // files as orphans.
    const firstTablePage = Array.from({ length: 10000 }, (_, i) => ({
      name: `x_table_${i}`,
    }));

    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(
      async (table: string, query: string, fields: string, _l?: number, offset?: number) => {
        if (table === "sys_app")
          return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata" && fields === "sys_class_name") {
          return { data: { result: [] } };
        }
        if (table === "sys_db_object" && query.startsWith("sys_scope=")) {
          return {
            data: {
              result: offset === 0 ? firstTablePage : [{ name: "x_late_table" }],
            },
          };
        }
        return { data: { result: [] } };
      }
    );

    // Every discovered table returns no fields and no records, so the manifest
    // itself comes back empty; the table LIST is what this asserts.
    await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    const listOffsets = tableAPIGet.mock.calls
      .filter((c) => c[0] === "sys_db_object" && c[1].startsWith("sys_scope="))
      .map((c) => c[4]);
    expect(listOffsets).toEqual([0, 10000]);
    // The second page's table was actually enumerated, not dropped.
    expect(
      tableAPIGet.mock.calls.some(
        (c) => c[0] === "sys_dictionary" && c[1].includes("name=x_late_table")
      )
    ).toBe(true);
  });
});
