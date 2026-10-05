// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4: the data model as editable local records — the manifest half.
//
// A data-model record (a dictionary entry, a choice, an ACL, …) usually has no
// field file at all. Before R4 such a table was dropped by the manifest builder
// ("no file fields, nothing to write"), so the data model never reached the
// working tree. These tests pin the sidecar-only record that represents it now,
// its stable name, and the opt-in that gates all of it.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  attachMetaFieldsToManifest,
  buildBulkDownloadFromTableAPI,
  buildManifestFromTableAPI,
  discoverTableMetaFields,
} from "../manifestBuilder.js";
import { buildManifestMetaFields, buildManifestRecordNames } from "../downloadPipeline.js";
import { applyDataModelTableOptions } from "../dataModel.js";
import { isMetaFile, metaFile } from "../metaFields.js";

type Row = Record<string, unknown>;
type TableApiGet = jest.Mock<
  Promise<{ data: { result: Row[] } }>,
  [string, string, string, number?, number?]
>;

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

// The dictionary of sys_dictionary itself, as the metadata discovery reads it.
// No column is script-typed, so its records come out sidecar-only.
const SYS_DICTIONARY_COLUMNS: Row[] = [
  { element: "name", internal_type: "table_name" },
  { element: "element", internal_type: "string" },
  { element: "column_label", internal_type: "string" },
  { element: "internal_type", internal_type: "reference" },
  { element: "max_length", internal_type: "integer" },
  { element: "mandatory", internal_type: "boolean" },
  { element: "sys_name", internal_type: "string", read_only: "true" },
  // Never carried: identity and per-save audit stamps.
  { element: "sys_id", internal_type: "GUID" },
  { element: "sys_updated_on", internal_type: "glide_date_time" },
];

const DICTIONARY_RECORDS: Row[] = [
  {
    sys_id: "d1",
    name: "x_demo_task",
    element: "u_foo",
    column_label: "Foo",
    internal_type: { value: "string", link: "https://x/api/now/table/sys_glide_object/s" },
    max_length: "40",
    mandatory: "false",
    sys_name: "u_foo",
  },
  // The collection entry of a table has no element: it is named by the table.
  { sys_id: "d2", name: "x_demo_task", element: "", column_label: "Task", max_length: "40" },
  { sys_id: "d3", name: "x_demo_task", element: "u_bar", column_label: "Bar", max_length: "100" },
];

interface FakeOptions {
  sweep?: Row[];
  records?: Row[];
  columns?: Row[] | Error;
  fileColumns?: Row[];
  scope?: Row[];
}

// One fake instance. Every sys_dictionary query is told apart by its filter,
// exactly as a real instance answers them: the records of the opted-in table
// (sys_scope=… / sys_idIN…), file-field discovery (internal_type=…) and
// metadata discovery (everything else).
const fakeInstance = (options: FakeOptions = {}): TableApiGet => {
  const records = options.records ?? DICTIONARY_RECORDS;
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    const q = String(query);
    if (table === "sys_app") {
      return { data: { result: options.scope ?? [{ sys_id: "scope-1" }] } };
    }
    if (table === "sys_metadata") {
      // The sweep answers only the scope-wide query; the per-table fallback
      // (sys_class_name=…) finds nothing.
      if (q.includes("sys_class_name=")) return { data: { result: [] } };
      return { data: { result: options.sweep ?? [{ sys_class_name: "sys_dictionary" }] } };
    }
    if (table === "sys_db_object") {
      const name = /name=([^^]+)/.exec(q)?.[1] ?? "";
      return { data: { result: [{ name }] } };
    }
    if (table === "sys_dictionary") {
      if (q.startsWith("sys_scope=")) return { data: { result: records } };
      if (q.startsWith("sys_idIN")) {
        const ids = q.slice("sys_idIN".length).split("^")[0].split(",");
        return { data: { result: records.filter((r) => ids.includes(String(r.sys_id))) } };
      }
      if (q.includes("internal_type=")) {
        return { data: { result: options.fileColumns ?? [] } };
      }
      if (options.columns instanceof Error) throw options.columns;
      return { data: { result: options.columns ?? SYS_DICTIONARY_COLUMNS } };
    }
    return { data: { result: [] } };
  });
  return tableAPIGet;
};

type BuildConfig = Pick<
  Sync.Config,
  "includes" | "excludes" | "tableOptions" | "meta" | "dataModelTables"
>;

// sys_dictionary is excluded by default; opting in has to override that.
const optedIn = (overrides: Partial<BuildConfig> = {}): BuildConfig => ({
  includes: {},
  excludes: { sys_dictionary: true },
  tableOptions: {},
  dataModelTables: ["sys_dictionary"],
  ...overrides,
});

const recordQueries = (tableAPIGet: TableApiGet, table: string): string[] =>
  tableAPIGet.mock.calls
    .filter(([t, q]) => t === table && String(q).startsWith("sys_scope="))
    .map(([, q]) => String(q));

describe("R4 manifest: sidecar-only data-model records", () => {
  it("AT-R4-1: a sys_dictionary record is listed with its sidecar alone", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn()
    );

    const table = manifest.tables.sys_dictionary;
    expect(table).toMatchSnapshot();
    expect(table.records["x_demo_task.u_foo"]).toEqual({
      sys_id: "d1",
      name: "x_demo_task.u_foo",
      files: [{ name: ".meta", type: "json" }],
    });
    // The field set is the dictionary's columns minus the denylist.
    expect(table.metaFields).not.toContain("sys_id");
    expect(table.metaFields).not.toContain("sys_updated_on");
    expect(table.metaReadOnlyFields).toEqual(["sys_name"]);

    // The record query selects the name columns, so names are built from data.
    const fields = tableAPIGet.mock.calls.find(
      ([t, q]) => t === "sys_dictionary" && String(q).startsWith("sys_scope=")
    )?.[2];
    expect(String(fields).split(",")).toEqual(
      expect.arrayContaining(["sys_id", "name", "element"])
    );
  });

  it("AT-R4-1: refresh writes the sidecar under the manifest's own name", async () => {
    const config = optedIn();
    const tableAPIGet = fakeInstance();
    const client = createClient(tableAPIGet);
    const manifest = await buildManifestFromTableAPI("x_demo", client, config);

    const tableMap = await buildBulkDownloadFromTableAPI(
      { sys_dictionary: { d1: [metaFile()] } },
      client,
      applyDataModelTableOptions(config),
      buildManifestRecordNames(manifest),
      buildManifestMetaFields(manifest)
    );

    const record = tableMap.sys_dictionary.records["x_demo_task.u_foo"];
    expect(record.files).toHaveLength(1);
    const sidecar = record.files.find(isMetaFile);
    expect(JSON.parse(String(sidecar?.content))).toEqual({
      column_label: "Foo",
      element: "u_foo",
      // A reference column is written as its value, not as the {link, value} pair.
      internal_type: "string",
      mandatory: "false",
      max_length: "40",
      name: "x_demo_task",
      sys_name: "u_foo",
    });
  });

  it("suffixes every member of a colliding name with its sys_id", async () => {
    const tableAPIGet = fakeInstance({
      records: [
        { sys_id: "b2", name: "x_demo_task", element: "u_foo" },
        { sys_id: "a1", name: "x_demo_task", element: "U_FOO" },
        { sys_id: "c3", name: "x_demo_task", element: "u_bar" },
      ],
    });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn()
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records).sort()).toEqual([
      "x_demo_task.U_FOO_a1",
      "x_demo_task.u_bar",
      "x_demo_task.u_foo_b2",
    ]);
  });

  it("keeps the pre-R4 result when the table is not opted in", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn({ dataModelTables: [], excludes: {} })
    );
    // Discovered, but with no field file it has nothing to write.
    expect(manifest.tables.sys_dictionary).toBeUndefined();
    expect(recordQueries(tableAPIGet, "sys_dictionary")).toEqual([]);
  });

  it("does not even discover a default-excluded table that is not opted in", async () => {
    const tableAPIGet = fakeInstance({
      sweep: [{ sys_class_name: "sys_dictionary" }, { sys_class_name: "sys_script" }],
    });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn({ dataModelTables: [] })
    );
    expect(manifest.tables.sys_dictionary).toBeUndefined();
    expect(tableAPIGet.mock.calls.some(([t, q]) => t === "sys_db_object" && q === "name=sys_dictionary")).toBe(false);
  });

  it("keeps the early return under meta: false — there is no sidecar to write", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn({ meta: false })
    );
    expect(manifest.tables.sys_dictionary).toBeUndefined();
  });

  it("leaves the table out when its dictionary cannot be read", async () => {
    const tableAPIGet = fakeInstance({ columns: new Error("403 Forbidden") });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn()
    );
    expect(manifest.tables.sys_dictionary).toBeUndefined();
    expect(recordQueries(tableAPIGet, "sys_dictionary")).toEqual([]);
  });

  it("keeps the field files of a data-model table that has them", async () => {
    const tableAPIGet = fakeInstance({
      fileColumns: [{ element: "calculation", internal_type: "script" }],
      columns: [...SYS_DICTIONARY_COLUMNS, { element: "calculation", internal_type: "script" }],
    });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn()
    );
    const table = manifest.tables.sys_dictionary;
    expect(table.records["x_demo_task.u_foo"].files).toEqual([
      { name: "calculation", type: "js" },
      { name: ".meta", type: "json" },
    ]);
    expect(table.metaFields).not.toContain("calculation");
  });

  it("enumerates an opted-in table the sys_metadata sweep did not list", async () => {
    const tableAPIGet = fakeInstance({ sweep: [{ sys_class_name: "sys_script" }] });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn()
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records)).toContain(
      "x_demo_task.u_foo"
    );
  });

  it("lets an explicit includes.<table>: false switch an opted-in table off", async () => {
    const tableAPIGet = fakeInstance({ sweep: [{ sys_class_name: "sys_script" }] });
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn({ includes: { sys_dictionary: false } })
    );
    expect(manifest.tables.sys_dictionary).toBeUndefined();
    expect(recordQueries(tableAPIGet, "sys_dictionary")).toEqual([]);
  });

  it("honours an operator's own displayField over the data-model naming", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      optedIn({ tableOptions: { sys_dictionary: { query: "", displayField: "column_label" } } })
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records).sort()).toEqual([
      "Bar",
      "Foo",
      "Task",
    ]);
  });
});

describe("R4 on the companion-app path (attachMetaFieldsToManifest)", () => {
  // What `sinc/getManifest` returns: the data-model table named by display value
  // (or absent), a script table that already carries its metadata layer.
  const endpointManifest = (): SN.AppManifest => ({
    scope: "x_demo",
    scopeId: "scope-1",
    tables: {
      sys_dictionary: {
        records: { x_demo_task: { sys_id: "d1", name: "x_demo_task", files: [] } },
      },
      sys_script_include: {
        metaFields: ["api_name"],
        records: { A: { sys_id: "s1", name: "A", files: [{ name: "script", type: "js" }] } },
      },
    },
  });

  it("rebuilds the opted-in table with the data-model names and sidecars", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await attachMetaFieldsToManifest(
      endpointManifest(),
      createClient(tableAPIGet),
      optedIn()
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records).sort()).toEqual([
      "x_demo_task",
      "x_demo_task.u_bar",
      "x_demo_task.u_foo",
    ]);
    expect(manifest.tables.sys_dictionary.metaFields).toContain("max_length");
    // Untouched: a table outside the opt-in keeps exactly what it had.
    expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
    // The manifest already knew its scope id, so nothing looked it up again.
    expect(tableAPIGet.mock.calls.some(([t]) => t === "sys_app")).toBe(false);
  });

  it("drops the endpoint's entry when the table has no record in scope", async () => {
    const tableAPIGet = fakeInstance({ records: [] });
    const manifest = await attachMetaFieldsToManifest(
      endpointManifest(),
      createClient(tableAPIGet),
      optedIn()
    );
    expect(manifest.tables.sys_dictionary).toBeUndefined();
    expect(manifest.tables.sys_script_include).toBeDefined();
  });

  it("looks the scope id up when the manifest does not carry one", async () => {
    const tableAPIGet = fakeInstance();
    const input = { ...endpointManifest(), scopeId: undefined };
    const manifest = await attachMetaFieldsToManifest(
      input,
      createClient(tableAPIGet),
      optedIn()
    );
    expect(tableAPIGet.mock.calls.some(([t]) => t === "sys_app")).toBe(true);
    expect(manifest.tables.sys_dictionary.records["x_demo_task.u_foo"]).toBeDefined();
  });

  it("fails loudly when the scope cannot be found", async () => {
    const tableAPIGet = fakeInstance({ scope: [] });
    await expect(
      attachMetaFieldsToManifest(
        { ...endpointManifest(), scopeId: undefined },
        createClient(tableAPIGet),
        optedIn()
      )
    ).rejects.toThrow(/Scope "x_demo" not found/);
  });

  it("is a no-op for the data model when nothing is opted in", async () => {
    const tableAPIGet = fakeInstance();
    const input = endpointManifest();
    input.tables.sys_dictionary.metaFields = ["max_length"];
    const manifest = await attachMetaFieldsToManifest(
      input,
      createClient(tableAPIGet),
      optedIn({ dataModelTables: [] })
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records)).toEqual(["x_demo_task"]);
    expect(tableAPIGet).not.toHaveBeenCalled();
  });

  it("is a no-op under meta: false", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = await attachMetaFieldsToManifest(
      endpointManifest(),
      createClient(tableAPIGet),
      optedIn({ meta: false })
    );
    expect(Object.keys(manifest.tables.sys_dictionary.records)).toEqual(["x_demo_task"]);
    expect(tableAPIGet).not.toHaveBeenCalled();
  });
});

describe("discoverTableMetaFields", () => {
  it("returns the sidecar columns without the file fields and the denylist", async () => {
    const tableAPIGet = fakeInstance({
      fileColumns: [{ element: "calculation", internal_type: "script" }],
      columns: [...SYS_DICTIONARY_COLUMNS, { element: "calculation", internal_type: "script" }],
    });
    const meta = await discoverTableMetaFields(
      createClient(tableAPIGet),
      "sys_dictionary",
      optedIn()
    );
    expect(meta.fields).toEqual([
      "column_label",
      "element",
      "internal_type",
      "mandatory",
      "max_length",
      "name",
      "sys_name",
    ]);
    expect(meta.readOnly).toEqual(["sys_name"]);
  });

  it("returns empty lists when the dictionary cannot be read", async () => {
    const tableAPIGet = fakeInstance({ columns: new Error("403 Forbidden") });
    await expect(
      discoverTableMetaFields(createClient(tableAPIGet), "sys_dictionary", optedIn())
    ).resolves.toEqual({ fields: [], readOnly: [] });
  });

  it("uses an explicit tableOptions.metaFields list as is", async () => {
    const tableAPIGet = fakeInstance();
    const meta = await discoverTableMetaFields(
      createClient(tableAPIGet),
      "sys_dictionary",
      optedIn({ tableOptions: { sys_dictionary: { query: "", metaFields: ["max_length"] } } })
    );
    expect(meta).toEqual({ fields: ["max_length"], readOnly: [] });
  });
});
