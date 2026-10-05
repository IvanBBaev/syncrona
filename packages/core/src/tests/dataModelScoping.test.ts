// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4: which records of a data-model table belong to the scope.
//
// Every table the manifest builder enumerates is filtered by `sys_scope`. That
// is only a filter on a table that HAS the column. sys_choice does not: it does
// not extend sys_metadata, and the Table API ignores an encoded-query term on a
// column the table lacks. `sys_scope=<id>^sys_class_name=sys_choice` therefore
// matched every choice on the instance, and a download of a nine-table scope
// wrote tens of thousands of foreign choices into the working tree.
//
// The fake instance below answers sys_choice the way the platform does — it
// drops the terms it has no column for — so a scope filter sent to it returns
// the whole table and fails these tests the same way it failed on an instance.
import { jest } from "@jest/globals";
import type { SN, Sync } from "@syncrona/types";

// manifestBuilder reads the PREVIOUS manifest through ConfigManager, so the
// module has to be mocked before the subject is imported (ESM mocks do not
// hoist).
const getManifest = jest.fn();
jest.unstable_mockModule("../config.js", () => ({
  getManifest: (...a: unknown[]) => getManifest(...a),
}));

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn(), success: jest.fn() },
}));

type Row = Record<string, string>;
type TableApiGet = jest.Mock<
  (
    table: string,
    query: string,
    fields: string,
    limit?: number,
    offset?: number
  ) => Promise<{ data: { result: Row[] } }>
>;

let buildManifestFromTableAPI: typeof import("../manifestBuilder.js").buildManifestFromTableAPI;
let attachDataModelTablesToManifest: typeof import("../manifestBuilder.js").attachDataModelTablesToManifest;
let DATA_MODEL_DEFAULT_TABLES: typeof import("../dataModel.js").DATA_MODEL_DEFAULT_TABLES;

beforeAll(async () => {
  ({ buildManifestFromTableAPI, attachDataModelTablesToManifest } = await import(
    "../manifestBuilder.js"
  ));
  ({ DATA_MODEL_DEFAULT_TABLES } = await import("../dataModel.js"));
});

beforeEach(() => {
  jest.clearAllMocks();
  getManifest.mockReturnValue(undefined);
});

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

const httpError = (status: number): Error =>
  Object.assign(new Error(`http ${status}`), {
    isAxiosError: true,
    response: { status },
  });

// The columns sys_choice really has. A query term on anything else is ignored.
const CHOICE_COLUMNS = new Set(["sys_id", "name", "element", "value", "label", "language"]);

const matchesChoiceQuery = (row: Row, query: string): boolean =>
  query.split("^").every((term) => {
    if (term.startsWith("ORDERBY")) return true;
    const parsed = /^([a-z_]+)(IN|=)(.*)$/.exec(term);
    if (!parsed) throw new Error(`fake sys_choice cannot evaluate "${term}"`);
    const [, column, operator, operand] = parsed;
    // The platform default: no such column, no such condition.
    if (!CHOICE_COLUMNS.has(column)) return true;
    return operator === "IN"
      ? operand.split(",").includes(row[column] ?? "")
      : (row[column] ?? "") === operand;
  });

const choice = (sysId: string, name: string, element: string, value: string, extra: Row = {}): Row => ({
  sys_id: sysId,
  name,
  element,
  value,
  label: `${element} ${value}`,
  language: "en",
  ...extra,
});

// Every choice of the fake instance: two lists on the scope's own table, and
// lists on a table of another scope.
const CHOICES: Row[] = [
  choice("c01", "x_demo_task", "state", "1"),
  choice("c02", "x_demo_task", "state", "2"),
  choice("c03", "x_demo_task", "kind", "a", { language: "de" }),
  choice("c04", "incident", "state", "1"),
  choice("c05", "incident", "state", "2"),
  choice("c06", "incident", "u_demo_reason", "late"),
  choice("c07", "incident", "u_demo_reason", "lost", { language: "de" }),
  choice("c08", "incident", "category", "network"),
  choice("c09", "problem", "state", "1"),
];

interface Instance {
  /** sys_db_object rows of the scope. */
  ownedTables?: Row[];
  /** sys_dictionary rows of the scope. */
  ownedColumns?: Row[];
  /** sys_choice_set rows of the scope. */
  ownedChoiceSets?: Row[];
  /** The WHOLE sys_choice table. */
  choices?: Row[];
  /** table -> its super class. */
  parents?: Record<string, string>;
  /** Tables that declare a sys_scope column themselves. */
  scopeColumnTables?: string[];
  /** Rows of any other table, as the scope filter or an operator query sees them. */
  rows?: Record<string, Row[]>;
  /** Errors, by what is being read. */
  fail?: {
    ownedTables?: Error;
    ownedColumns?: Error;
    ownedChoiceSets?: Error;
    choices?: Error;
    scopeProbe?: Error;
  };
}

const fakeInstance = (instance: Instance = {}): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table, query, _fields, limit, offset) => {
    const q = String(query);
    const page = (rows: Row[]) => {
      const start = offset ?? 0;
      return { data: { result: rows.slice(start, start + (limit ?? rows.length)) } };
    };
    if (table === "sys_app") return page([{ sys_id: "scope-1" }]);
    if (table === "sys_metadata") {
      // The sweep answers only the scope-wide query; the per-table fallback
      // (sys_class_name=…) finds nothing.
      return q.includes("sys_class_name=") ? page([]) : page([{ sys_class_name: "sys_script_include" }]);
    }
    if (table === "sys_db_object") {
      if (q.startsWith("sys_scope=")) {
        if (instance.fail?.ownedTables) throw instance.fail.ownedTables;
        return page(instance.ownedTables ?? []);
      }
      const name = /^name=([^^]+)/.exec(q)?.[1] ?? "";
      return page([{ name, "super_class.name": instance.parents?.[name] ?? "" }]);
    }
    if (table === "sys_dictionary") {
      if (q.includes("^element=sys_scope")) {
        if (instance.fail?.scopeProbe) throw instance.fail.scopeProbe;
        const names = q.slice("nameIN".length).split("^")[0].split(",");
        return page(
          names
            .filter((name) => (instance.scopeColumnTables ?? []).includes(name))
            .map((name) => ({ name }))
        );
      }
      if (q.startsWith("sys_scope=") && q.includes("sys_class_name=")) return page([]);
      if (q.startsWith("sys_scope=")) {
        if (instance.fail?.ownedColumns) throw instance.fail.ownedColumns;
        return page(instance.ownedColumns ?? []);
      }
      // File-field discovery: no table here has a script column.
      if (q.includes("internal_type")) return page([]);
      // Metadata discovery: the same plain columns for every table.
      return page(
        ["name", "element", "value", "label", "language"].map((element) => ({
          element,
          internal_type: "string",
        }))
      );
    }
    if (table === "sys_choice_set") {
      if (instance.fail?.ownedChoiceSets) throw instance.fail.ownedChoiceSets;
      return page(instance.ownedChoiceSets ?? []);
    }
    if (table === "sys_choice") {
      if (instance.fail?.choices) throw instance.fail.choices;
      return page((instance.choices ?? CHOICES).filter((row) => matchesChoiceQuery(row, q)));
    }
    return page(instance.rows?.[table] ?? []);
  });
  return tableAPIGet;
};

type BuildConfig = Pick<
  Sync.Config,
  "includes" | "excludes" | "tableOptions" | "meta" | "dataModelTables"
>;

const config = (overrides: Partial<BuildConfig> = {}): BuildConfig => ({
  includes: {},
  excludes: {},
  tableOptions: {},
  dataModelTables: ["sys_choice"],
  ...overrides,
});

const queriesOn = (tableAPIGet: TableApiGet, table: string): string[] =>
  tableAPIGet.mock.calls.filter(([t]) => t === table).map(([, q]) => String(q));

const build = async (instance: Instance, overrides: Partial<BuildConfig> = {}) => {
  const tableAPIGet = fakeInstance(instance);
  const manifest = await buildManifestFromTableAPI(
    "x_demo",
    createClient(tableAPIGet),
    config(overrides)
  );
  return { manifest, tableAPIGet };
};

const recordIds = (manifest: SN.AppManifest, table: string): string[] =>
  Object.values(manifest.tables[table]?.records ?? {})
    .map((record) => record.sys_id)
    .sort();

describe("R4 scoping: sys_choice has no sys_scope column", () => {
  it("lists the choices of the scope's own tables and nothing else", async () => {
    const { manifest, tableAPIGet } = await build({ ownedTables: [{ name: "x_demo_task" }] });

    expect(Object.keys(manifest.tables.sys_choice.records).sort()).toEqual([
      "x_demo_task.kind.a",
      "x_demo_task.state.1",
      "x_demo_task.state.2",
    ]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual(["nameINx_demo_task^ORDERBYsys_id"]);
  });

  it("never sends sys_choice a scope filter, and never asks sys_metadata for it", async () => {
    const { tableAPIGet } = await build({
      ownedTables: [{ name: "x_demo_task" }],
      ownedColumns: [{ name: "incident", element: "u_demo_reason" }],
      ownedChoiceSets: [{ name: "incident", element: "category" }],
    });

    for (const query of queriesOn(tableAPIGet, "sys_choice")) {
      expect(query).not.toContain("sys_scope");
      expect(query).not.toContain("sys_class_name");
    }
    expect(
      queriesOn(tableAPIGet, "sys_metadata").filter((q) => q.includes("sys_class_name=sys_choice"))
    ).toEqual([]);
  });

  it("follows a column the scope added to another scope's table", async () => {
    const { manifest, tableAPIGet } = await build({
      ownedTables: [{ name: "x_demo_task" }],
      ownedColumns: [
        { name: "incident", element: "u_demo_reason" },
        // A column of an owned table adds nothing: the table already covers it.
        { name: "x_demo_task", element: "state" },
      ],
    });

    expect(recordIds(manifest, "sys_choice")).toEqual(["c01", "c02", "c03", "c06", "c07"]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual([
      "nameINx_demo_task^ORDERBYsys_id",
      "name=incident^elementINu_demo_reason^ORDERBYsys_id",
    ]);
  });

  it("follows a choice list the scope owns on another scope's column", async () => {
    const { manifest, tableAPIGet } = await build({
      ownedChoiceSets: [{ name: "incident", element: "category" }],
    });

    expect(Object.keys(manifest.tables.sys_choice.records)).toEqual(["incident.category.network"]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual([
      "name=incident^elementINcategory^ORDERBYsys_id",
    ]);
  });

  it("merges the columns and choice lists it owns on one foreign table into one request", async () => {
    const { manifest, tableAPIGet } = await build({
      ownedColumns: [{ name: "incident", element: "u_demo_reason" }],
      ownedChoiceSets: [
        { name: "incident", element: "category" },
        { name: "incident", element: "u_demo_reason" },
      ],
    });

    expect(recordIds(manifest, "sys_choice")).toEqual(["c06", "c07", "c08"]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual([
      "name=incident^elementINcategory,u_demo_reason^ORDERBYsys_id",
    ]);
  });

  it("applies the operator's own query on top of every ownership query", async () => {
    const { manifest, tableAPIGet } = await build(
      {
        ownedTables: [{ name: "x_demo_task" }],
        ownedColumns: [{ name: "incident", element: "u_demo_reason" }],
      },
      { tableOptions: { sys_choice: { query: "language=en" } } }
    );

    // The German choices of both lists are filtered out by the operator.
    expect(recordIds(manifest, "sys_choice")).toEqual(["c01", "c02", "c06"]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual([
      "nameINx_demo_task^language=en^ORDERBYsys_id",
      "name=incident^elementINu_demo_reason^language=en^ORDERBYsys_id",
    ]);
  });

  it("sends no sys_choice request at all for a scope that owns nothing", async () => {
    const { manifest, tableAPIGet } = await build({});

    expect(manifest.tables.sys_choice).toBeUndefined();
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual([]);
    // Nothing was refused, so nothing is reported as unreadable.
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the three ownership lists by scope, with the columns it needs", async () => {
    const { tableAPIGet } = await build({ ownedTables: [{ name: "x_demo_task" }] });

    const ownershipCall = (table: string) =>
      tableAPIGet.mock.calls.find(
        ([t, q]) => t === table && String(q).startsWith("sys_scope=scope-1^name")
      );
    expect(ownershipCall("sys_db_object")?.slice(1, 3)).toEqual([
      "sys_scope=scope-1^nameISNOTEMPTY^ORDERBYsys_id",
      "name",
    ]);
    expect(ownershipCall("sys_dictionary")?.slice(1, 3)).toEqual([
      "sys_scope=scope-1^nameISNOTEMPTY^elementISNOTEMPTY^ORDERBYsys_id",
      "name,element",
    ]);
    expect(ownershipCall("sys_choice_set")?.slice(1, 3)).toEqual([
      "sys_scope=scope-1^nameISNOTEMPTY^elementISNOTEMPTY^ORDERBYsys_id",
      "name,element",
    ]);
  });

  it("drops a table or column name that would add conditions to the query", async () => {
    const { tableAPIGet } = await build({
      ownedTables: [
        { name: "x_demo_task" },
        { name: "x_a,incident" },
        { name: "x_a^ORnameISNOTEMPTY" },
        { name: "" },
      ],
      ownedColumns: [
        { name: "incident", element: "state^ORelementISNOTEMPTY" },
        { name: "inc,ident", element: "state" },
        { name: "problem", element: "a,state" },
      ],
    });

    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual(["nameINx_demo_task^ORDERBYsys_id"]);
  });

  it("splits long lists of owned names into several bounded requests", async () => {
    const pad = (n: number) => String(n).padStart(3, "0");
    const { tableAPIGet } = await build({
      ownedTables: Array.from({ length: 120 }, (_, i) => ({ name: `x_demo_t${pad(119 - i)}` })),
      ownedColumns: Array.from({ length: 51 }, (_, i) => ({
        name: "incident",
        element: `u_demo_c${pad(50 - i)}`,
      })),
    });

    const queries = queriesOn(tableAPIGet, "sys_choice");
    const names = (query: string) => query.replace(/\^ORDERBYsys_id$/, "").split("IN")[1].split(",");
    expect(queries.map((q) => names(q).length)).toEqual([50, 50, 20, 50, 1]);
    // Sorted, so the same scope always sends the same requests.
    expect(names(queries[0])[0]).toBe("x_demo_t000");
    expect(names(queries[2])[19]).toBe("x_demo_t119");
    expect(queries[3].startsWith("name=incident^elementINu_demo_c000,")).toBe(true);
    expect(queries[4]).toBe("name=incident^elementINu_demo_c050^ORDERBYsys_id");
  });

  it("keeps the previously known choices when an ownership list is refused", async () => {
    getManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        sys_choice: {
          records: {
            "incident.u_demo_reason.late": {
              sys_id: "c06",
              name: "incident.u_demo_reason.late",
              files: [{ name: ".meta", type: "json" }],
            },
          },
        },
      },
    });

    // sys_dictionary is refused, so the columns the scope owns on foreign
    // tables are unknown: what was read is kept, and so is what was known.
    const { manifest } = await build({
      ownedTables: [{ name: "x_demo_task" }],
      fail: { ownedColumns: httpError(403) },
    });

    expect(recordIds(manifest, "sys_choice")).toEqual(["c01", "c02", "c03", "c06"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Kept the previously known records for: sys_choice")
    );
  });

  it.each([
    ["sys_db_object", { ownedTables: httpError(403) }],
    ["sys_choice_set", { ownedChoiceSets: httpError(404) }],
    ["sys_choice", { choices: httpError(403) }],
  ])("reports a refused %s read instead of treating it as empty", async (_table, fail) => {
    const { manifest } = await build({
      ownedColumns: [{ name: "incident", element: "u_demo_reason" }],
      fail,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fully read 1 table(s) while building the manifest")
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sys_choice"));
    // Whatever was readable is still listed; a refused sys_choice lists nothing.
    expect(manifest.tables.sys_choice === undefined).toBe("choices" in fail);
  });

  it.each([
    ["sys_db_object", { ownedTables: httpError(500) }],
    ["sys_dictionary", { ownedColumns: httpError(503) }],
    ["sys_choice_set", { ownedChoiceSets: new Error("socket hang up") }],
    ["sys_choice", { choices: httpError(500) }],
  ])("fails the build when the %s read fails outright", async (_table, fail) => {
    await expect(
      build({ ownedTables: [{ name: "x_demo_task" }], fail })
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_choice");
  });

  it("keeps the rule when includes gives sys_choice a file of its own", async () => {
    // With a file field the table is no longer sidecar-only, which is a
    // different path through the enumeration. The scoping must not depend on it.
    const { manifest, tableAPIGet } = await build(
      { ownedTables: [{ name: "x_demo_task" }] },
      { includes: { sys_choice: { label: { type: "txt" } } } }
    );

    expect(recordIds(manifest, "sys_choice")).toEqual(["c01", "c02", "c03"]);
    expect(manifest.tables.sys_choice.records["x_demo_task.state.1"].files).toEqual(
      expect.arrayContaining([{ name: "label", type: "txt" }])
    );
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual(["nameINx_demo_task^ORDERBYsys_id"]);
  });

  it("applies the rule on the companion-app path too", async () => {
    // The endpoint's manifest carries a sys_choice entry built by the old rule.
    const manifest = {
      scope: "x_demo",
      scopeId: "scope-1",
      tables: {
        sys_choice: {
          records: {
            foreign: { sys_id: "c09", name: "foreign", files: [{ name: ".meta", type: "json" }] },
          },
        },
      },
    } as unknown as SN.AppManifest;
    const tableAPIGet = fakeInstance({ ownedTables: [{ name: "x_demo_task" }] });

    await attachDataModelTablesToManifest(manifest, createClient(tableAPIGet), config());

    expect(recordIds(manifest, "sys_choice")).toEqual(["c01", "c02", "c03"]);
    expect(queriesOn(tableAPIGet, "sys_choice")).toEqual(["nameINx_demo_task^ORDERBYsys_id"]);
  });
});

describe("R4 scoping: a table the operator added to dataModelTables", () => {
  const LOOKUP_ROWS: Row[] = [
    { sys_id: "l1", name: "alpha" },
    { sys_id: "l2", name: "beta" },
  ];

  it("leaves out a table without a sys_scope column, and says why", async () => {
    const { manifest, tableAPIGet } = await build(
      { rows: { x_lookup: LOOKUP_ROWS } },
      { dataModelTables: ["x_lookup"] }
    );

    expect(manifest.tables.x_lookup).toBeUndefined();
    // Not one request reaches the table: a scope filter would return all of it.
    expect(queriesOn(tableAPIGet, "x_lookup")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Table x_lookup is listed in dataModelTables but has no sys_scope column, so its records cannot be attributed to a scope. It was left out; set tableOptions.x_lookup.query to select its records."
    );
    // Left out on purpose is not "could not be read".
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Could not fully read"));
  });

  it("reads such a table by the operator's query alone", async () => {
    const { manifest, tableAPIGet } = await build(
      { rows: { x_lookup: LOOKUP_ROWS } },
      { dataModelTables: ["x_lookup"], tableOptions: { x_lookup: { query: "active=true" } } }
    );

    expect(recordIds(manifest, "x_lookup")).toEqual(["l1", "l2"]);
    expect(queriesOn(tableAPIGet, "x_lookup")).toEqual(["active=true^ORDERBYsys_id"]);
  });

  it("does not fall back to sys_metadata when the operator's query matches nothing", async () => {
    const { manifest, tableAPIGet } = await build(
      {},
      { dataModelTables: ["x_lookup"], tableOptions: { x_lookup: { query: "active=true" } } }
    );

    expect(manifest.tables.x_lookup).toBeUndefined();
    expect(
      queriesOn(tableAPIGet, "sys_metadata").filter((q) => q.includes("sys_class_name=x_lookup"))
    ).toEqual([]);
  });

  it("keeps the scope filter for a table that inherits sys_scope", async () => {
    const { manifest, tableAPIGet } = await build(
      {
        parents: { x_demo_setting: "sys_metadata" },
        scopeColumnTables: ["sys_metadata"],
        rows: { x_demo_setting: LOOKUP_ROWS },
      },
      { dataModelTables: ["x_demo_setting"] }
    );

    expect(recordIds(manifest, "x_demo_setting")).toEqual(["l1", "l2"]);
    expect(queriesOn(tableAPIGet, "x_demo_setting")).toEqual([
      "sys_scope=scope-1^sys_class_name=x_demo_setting^ORDERBYsys_id",
    ]);
    // One probe, over the whole hierarchy, asking for a single row.
    const probes = tableAPIGet.mock.calls.filter(
      ([t, q]) => t === "sys_dictionary" && String(q).includes("element=sys_scope")
    );
    expect(probes.map(([, q, fields, limit]) => [q, fields, limit])).toEqual([
      ["nameINx_demo_setting,sys_metadata^element=sys_scope", "name", 1],
    ]);
  });

  it("keeps the previous entry when the column lookup is refused", async () => {
    getManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        x_lookup: {
          records: {
            alpha: { sys_id: "l1", name: "alpha", files: [{ name: ".meta", type: "json" }] },
          },
        },
      },
    });

    const { manifest, tableAPIGet } = await build(
      { rows: { x_lookup: LOOKUP_ROWS }, fail: { scopeProbe: httpError(403) } },
      { dataModelTables: ["x_lookup"] }
    );

    // Unknown is not "no": nothing is read, nothing is dropped.
    expect(queriesOn(tableAPIGet, "x_lookup")).toEqual([]);
    expect(recordIds(manifest, "x_lookup")).toEqual(["l1"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Kept the previously known records for: x_lookup")
    );
  });

  it("fails the build when the column lookup fails outright", async () => {
    await expect(
      build({ fail: { scopeProbe: httpError(500) } }, { dataModelTables: ["x_lookup"] })
    ).rejects.toThrow("Manifest build incomplete — failed tables: x_lookup");
  });

  it("does not probe the documented data-model tables", async () => {
    const { tableAPIGet } = await build({}, { dataModelTables: [...DATA_MODEL_DEFAULT_TABLES] });

    expect(
      queriesOn(tableAPIGet, "sys_dictionary").filter((q) => q.includes("element=sys_scope"))
    ).toEqual([]);
    // Each of them but sys_choice is still read by the scope filter.
    for (const table of DATA_MODEL_DEFAULT_TABLES.filter((name) => name !== "sys_choice")) {
      const records = tableAPIGet.mock.calls
        .filter(([t, q]) => t === table && String(q).includes(`sys_class_name=${table}`))
        .map(([, q]) => String(q));
      expect(records).toContain(`sys_scope=scope-1^sys_class_name=${table}^ORDERBYsys_id`);
    }
  });
});
