// SPDX-License-Identifier: GPL-3.0-or-later
//
// Decision points of the manifest builder that no other suite pinned: which
// query a table's records are read with, which rows and columns become manifest
// records and files, and how the companion-app enrichment passes treat a
// manifest that is incomplete or already partly enriched. The manifest decides
// what is tracked, so a wrong turn at any of these is a file that silently
// stops syncing — or one that should never have reached the working tree.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  applyIncludeTypeRulesToManifest,
  attachDataModelTablesToManifest,
  attachMetaFieldsToManifest,
  buildBulkDownloadFromTableAPI,
  buildManifestFromTableAPI,
  listAppsFromTableAPI,
} from "../manifestBuilder.js";
import { logger } from "../Logger.js";
import { META_DICTIONARY_FIELDS, isMetaFile, metaFile } from "../metaFields.js";

type Row = Record<string, unknown>;
type TableApiGet = jest.Mock<
  Promise<{ data: unknown }>,
  [string, string, string, number?, number?]
>;

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

// Paged reads append `^ORDERBYsys_id` (withStableOrder); assertions compare the
// caller's half of the query.
const withoutOrder = (query: string): string => query.replace(/\^?ORDERBYsys_id$/, "");

// The sys_dictionary reads, told apart the way a real instance answers them.
const isFileFieldQuery = (query: string): boolean => query.includes("^internal_type=");
const isTypeLookup = (query: string): boolean => query.includes("^elementIN");
const isMetaQuery = (fields: string): boolean => fields === META_DICTIONARY_FIELDS;
const isTextFieldQuery = (query: string, fields: string): boolean =>
  fields === "element,internal_type" && !isFileFieldQuery(query) && !isTypeLookup(query);

interface FakeOptions {
  /** The tables the scope-wide sys_metadata sweep reports. */
  sweep?: string[];
  /** Answers of the per-table `sys_metadata` fallback (sys_class_name=…). */
  metadataIds?: Row[];
  fileFields?: Row[];
  textFields?: Row[];
  columnTypes?: Row[];
  metaColumns?: Row[];
  /** Answers for every non-system table, by table and query. */
  records?: (table: string, query: string) => Row[];
}

const fakeInstance = (options: FakeOptions = {}): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
    const q = String(query);
    const rows = (result: Row[]) => ({ data: { result } });
    if (table === "sys_app") return rows([{ sys_id: "scope-1" }]);
    if (table === "sys_metadata") {
      if (q.includes("sys_class_name=")) return rows(options.metadataIds ?? []);
      return rows((options.sweep ?? ["sys_script_include"]).map((name) => ({ sys_class_name: name })));
    }
    if (table === "sys_db_object") {
      // A root table: found, no parent.
      return rows([{ name: /name=([^^]+)/.exec(q)?.[1] ?? "" }]);
    }
    if (table === "sys_dictionary") {
      if (isFileFieldQuery(q)) return rows(options.fileFields ?? []);
      if (isTypeLookup(q)) return rows(options.columnTypes ?? []);
      if (isMetaQuery(fields)) return rows(options.metaColumns ?? []);
      if (isTextFieldQuery(q, fields)) return rows(options.textFields ?? []);
      return rows([]);
    }
    return rows(options.records?.(table, withoutOrder(q)) ?? []);
  });
  return tableAPIGet;
};

const SCRIPT_FIELD: Row[] = [{ element: "script", internal_type: "script_plain" }];

const config = (
  overrides: Partial<Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "meta">> = {}
): Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "meta"> => ({
  includes: {},
  excludes: {},
  tableOptions: {},
  // The sidecar layer has its own suites; most cases here are about records
  // and field files, and leave it off so the expected file lists stay exact.
  meta: false,
  ...overrides,
});

const callsTo = (tableAPIGet: TableApiGet, table: string) =>
  tableAPIGet.mock.calls.filter(([t]) => t === table);

// Runs `fn` with the data-materialization env vars set, restoring them after.
async function withDataEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const DATA_FIELDS_ON = { SYNCRONA_INCLUDE_DATA_FIELDS: "true", SYNCRONA_DATA_TABLES: undefined };

afterEach(() => {
  jest.restoreAllMocks();
});

describe("tableOptions.query bounds every record read of a table", () => {
  it("is ANDed to the scope filter of the primary read", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      records: (table, query) =>
        table === "sys_script_include" && query.endsWith("^active=true")
          ? [{ sys_id: "a1", name: "Active", script: "x" }]
          : [{ sys_id: "a2", name: "Unfiltered", script: "x" }],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({ tableOptions: { sys_script_include: { query: "active=true" } } })
    );

    expect(Object.keys(manifest.tables.sys_script_include.records)).toEqual(["Active"]);
    expect(withoutOrder(callsTo(tableAPIGet, "sys_script_include")[0][1])).toBe(
      "sys_scope=scope-1^sys_class_name=sys_script_include^active=true"
    );
  });

  it("is ANDed to every sys_idIN chunk of the sys_metadata fallback", async () => {
    // The primary read returns nothing, so the records are found by their
    // sys_metadata ids. Dropping the operator's filter here would track the
    // records the filter exists to keep out.
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      metadataIds: [{ sys_id: "m1" }, { sys_id: "m2" }, { sys_class_name: "sys_script_include" }],
      records: (table, query) => {
        if (table !== "sys_script_include" || !query.startsWith("sys_idIN")) return [];
        return query.endsWith("^active=true")
          ? [{ sys_id: "m1", name: "Kept", script: "x" }]
          : [
              { sys_id: "m1", name: "Kept", script: "x" },
              { sys_id: "m2", name: "Filtered out", script: "x" },
            ];
      },
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({ tableOptions: { sys_script_include: { query: "active=true" } } })
    );

    expect(Object.keys(manifest.tables.sys_script_include.records)).toEqual(["Kept"]);
    const fallback = callsTo(tableAPIGet, "sys_script_include").find(([, q]) =>
      q.startsWith("sys_idIN")
    );
    // A metadata row without a sys_id contributes no id.
    expect(fallback?.[1]).toBe("sys_idINm1,m2^active=true");
  });
});

describe("which rows become records", () => {
  it("drops every row that cannot be keyed or named, and counts them in one warning", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      records: (table) =>
        table === "sys_script_include"
          ? [
              { sys_id: "a1", name: "Good", script: "x" },
              // A name but no sys_id: no push could ever target it.
              { name: "No id", script: "x" },
              // Neither: nothing to name it after.
              {},
              // A "name" and a sys_id that both resolve to the parent directory.
              { sys_id: "..", name: "..", script: "x" },
            ]
          : [],
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), config());

    const records = manifest.tables.sys_script_include.records;
    expect(Object.keys(records)).toEqual(["Good"]);
    expect(records.Good.sys_id).toBe("a1");
    expect(warn).toHaveBeenCalledWith(
      "Table sys_script_include: skipped 3 record(s) the instance returned without a usable sys_id."
    );
  });

  it("names a record by the first non-empty differentiator of an array, as field:value", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      records: (table) =>
        table === "sys_script_include"
          ? [
              { sys_id: "a1", name: "Widget", u_first: "", u_second: "blue", script: "x" },
              { sys_id: "a2", name: "Widget", u_first: "red", u_second: "blue", script: "x" },
              { sys_id: "a3", name: "Plain", u_first: "", u_second: "", script: "x" },
            ]
          : [],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({
        tableOptions: { sys_script_include: { differentiatorField: ["u_first", "u_second"] } },
      })
    );

    expect(Object.keys(manifest.tables.sys_script_include.records).sort()).toEqual([
      "Plain",
      "Widget (u_first:red)",
      "Widget (u_second:blue)",
    ]);
    // Both differentiator columns were selected, or the names could not be built.
    const fields = callsTo(tableAPIGet, "sys_script_include")[0][2].split(",");
    expect(fields).toEqual(expect.arrayContaining(["u_first", "u_second"]));
  });

  it("falls back to the default display value when a reference displayField has no string value", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      records: (table) =>
        table === "sys_script_include"
          ? [
              { sys_id: "a1", name: "By display", u_ref: { link: "https://x", value: null }, script: "x" },
              { sys_id: "a2", name: "Ignored", u_ref: { link: "https://x", value: "By reference" }, script: "x" },
            ]
          : [],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({ tableOptions: { sys_script_include: { displayField: "u_ref" } } })
    );

    const records = manifest.tables.sys_script_include.records;
    expect(Object.keys(records).sort()).toEqual(["By display", "By reference"]);
    expect(records["By display"].sys_id).toBe("a1");
  });

  it("names a non-Error rejection in the failure and fails the build", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const tableAPIGet = fakeInstance({ fileFields: SCRIPT_FIELD });
    const base = tableAPIGet.getMockImplementation()!;
    tableAPIGet.mockImplementation(async (table, query, fields, limit, offset) => {
      if (table === "sys_script_include") throw "connection reset";
      return base(table, query, fields, limit, offset);
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), config())
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_script_include");
    expect(warn).toHaveBeenCalledWith(
      "Failed to enumerate table sys_script_include: connection reset"
    );
  });
});

describe("field-level includes", () => {
  it("does not list a column twice when an include names a discovered file field", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      records: (table) =>
        table === "sys_script_include" ? [{ sys_id: "a1", name: "A", script: "x" }] : [],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({ includes: { sys_script_include: { script: { type: "txt" } } } })
    );

    // The discovered entry (with its dictionary-derived type) is the one kept.
    expect(manifest.tables.sys_script_include.records.A.files).toEqual([
      { name: "script", type: "js" },
    ]);
    // Nothing was pending, so no type lookup was spent on it.
    expect(
      callsTo(tableAPIGet, "sys_dictionary").some(([, q]) => isTypeLookup(q))
    ).toBe(false);
  });

  it("lists an include without a type as a .txt field file", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      columnTypes: [{ element: "u_notes", internal_type: "string" }],
      records: (table) =>
        table === "sys_script_include"
          ? [{ sys_id: "a1", name: "A", script: "x", u_notes: "n" }]
          : [],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({
        includes: { sys_script_include: { u_notes: {} as Sync.FieldConfig } },
      })
    );

    expect(manifest.tables.sys_script_include.records.A.files).toEqual([
      { name: "script", type: "js" },
      { name: "u_notes", type: "txt" },
    ]);
  });
});

describe("the data-field (text) fallback", () => {
  it.each([
    ["unsafe row first", ["password2", "string"]],
    ["safe row first", ["string", "password2"]],
  ])("drops a column any hierarchy row types as unsafe (%s)", async (_label, types) => {
    await withDataEnv(DATA_FIELDS_ON, async () => {
      const tableAPIGet = fakeInstance({
        sweep: ["x_data"],
        textFields: [
          { element: "u_secret", internal_type: types[0] },
          { element: "u_secret", internal_type: types[1] },
          { element: "u_label", internal_type: "string" },
        ],
        records: (table) =>
          table === "x_data" ? [{ sys_id: "r1", name: "Row", u_label: "L", u_secret: "s" }] : [],
      });

      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), config());

      expect(manifest.tables.x_data.records.Row.files).toEqual([{ name: "u_label", type: "txt" }]);
    });
  });

  it("keeps an excluded-but-included column in the query, yet still drops it when its type is unsafe", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    await withDataEnv(DATA_FIELDS_ON, async () => {
      const tableAPIGet = fakeInstance({
        sweep: ["x_data"],
        // The include's type lookup rules it unsafe, so the file-field pass
        // ends with no file and the table falls through to the text fallback.
        columnTypes: [{ element: "u_secret", internal_type: "password2" }],
        textFields: [
          { element: "u_secret", internal_type: "password2" },
          { element: "u_label", internal_type: "string" },
        ],
        records: (table) =>
          table === "x_data" ? [{ sys_id: "r1", name: "Row", u_label: "L", u_secret: "s" }] : [],
      });

      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(tableAPIGet),
        config({
          includes: { x_data: { u_secret: { type: "txt" } } },
          excludes: { x_data: { u_secret: { type: "txt" }, u_drop: { type: "txt" } } },
        })
      );

      const textQuery = callsTo(tableAPIGet, "sys_dictionary").find(([, q, f]) =>
        isTextFieldQuery(q, f)
      );
      expect(textQuery?.[1]).toContain("^element!=u_drop");
      expect(textQuery?.[1]).not.toContain("^element!=u_secret");
      expect(manifest.tables.x_data.records.Row.files).toEqual([{ name: "u_label", type: "txt" }]);
      // Warned once, though the column was judged on both passes.
      const unsafeWarnings = warn.mock.calls.filter(([m]) =>
        String(m).includes('ignoring the includes entry for column "u_secret"')
      );
      expect(unsafeWarnings).toHaveLength(1);
    });
  });

  it("adds no column filter for a table-level (boolean) exclude the table is included past", async () => {
    await withDataEnv(DATA_FIELDS_ON, async () => {
      const tableAPIGet = fakeInstance({
        sweep: ["x_data"],
        textFields: [{ element: "u_label", internal_type: "string" }],
        records: (table) => (table === "x_data" ? [{ sys_id: "r1", name: "Row", u_label: "L" }] : []),
      });

      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(tableAPIGet),
        config({ includes: { x_data: true }, excludes: { x_data: true } })
      );

      expect(manifest.tables.x_data.records.Row.files).toEqual([{ name: "u_label", type: "txt" }]);
      const textQuery = callsTo(tableAPIGet, "sys_dictionary").find(([, q, f]) =>
        isTextFieldQuery(q, f)
      );
      expect(textQuery?.[1]).not.toContain("element!=");
    });
  });
});

describe("the sidecar layer", () => {
  it("writes no sidecar for an explicit empty metaFields list and reads no dictionary for it", async () => {
    const tableAPIGet = fakeInstance({
      fileFields: SCRIPT_FIELD,
      metaColumns: [{ element: "description", internal_type: "string" }],
      records: (table) =>
        table === "sys_script_include" ? [{ sys_id: "a1", name: "A", script: "x" }] : [],
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      config({ meta: undefined, tableOptions: { sys_script_include: { metaFields: [] } } })
    );

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toBeUndefined();
    expect(table.records.A.files).toEqual([{ name: "script", type: "js" }]);
    const dictionary = callsTo(tableAPIGet, "sys_dictionary");
    expect(dictionary.some(([, q, f]) => isMetaQuery(f) || isTypeLookup(q))).toBe(false);
  });
});

describe("attachMetaFieldsToManifest", () => {
  const enrich = { tableOptions: {} };

  it("returns a manifest without tables unchanged and asks the instance nothing", async () => {
    const tableAPIGet = fakeInstance();
    const manifest = { scope: "x_demo", scopeId: "scope-1" } as SN.AppManifest;

    await expect(
      attachMetaFieldsToManifest(manifest, createClient(tableAPIGet), enrich)
    ).resolves.toBe(manifest);
    expect(tableAPIGet).not.toHaveBeenCalled();
  });

  it("adds exactly one sidecar per record, keeps an existing one, and skips record-less tables", async () => {
    const tableAPIGet = fakeInstance({
      metaColumns: [
        { element: "description", internal_type: "string" },
        // A file field this manifest lists is never a sidecar column too.
        { element: "script", internal_type: "string" },
      ],
    });
    const manifest: SN.AppManifest = {
      scope: "x_demo",
      scopeId: "scope-1",
      tables: {
        sys_script_include: {
          records: {
            Already: {
              sys_id: "a1",
              name: "Already",
              files: [{ name: "script", type: "js" }, metaFile()],
            },
            NoFiles: { sys_id: "a2", name: "NoFiles" } as unknown as SN.MetaRecord,
          },
        },
        sys_ui_page: { records: {} },
      },
    };

    await attachMetaFieldsToManifest(manifest, createClient(tableAPIGet), enrich);

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toEqual(["description"]);
    expect(table.records.Already.files.filter(isMetaFile)).toHaveLength(1);
    expect(table.records.Already.files.map((f) => f.name)).toEqual(["script", metaFile().name]);
    expect(table.records.NoFiles.files).toEqual([metaFile()]);
    // The table without records cost no request and gained no layer.
    expect(manifest.tables.sys_ui_page.metaFields).toBeUndefined();
    expect(
      tableAPIGet.mock.calls.some(([, q]) => String(q).includes("sys_ui_page"))
    ).toBe(false);
  });
});

describe("applyIncludeTypeRulesToManifest", () => {
  it("strips an unsafe include from every record, tolerating records that list no files", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const tableAPIGet = fakeInstance({
      columnTypes: [{ element: "u_secret", internal_type: "password2" }],
    });
    const manifest: SN.AppManifest = {
      scope: "x_demo",
      scopeId: "scope-1",
      tables: {
        x_data: {
          records: {
            Listed: {
              sys_id: "r1",
              name: "Listed",
              files: [
                { name: "u_label", type: "txt" },
                { name: "u_secret", type: "txt" },
              ],
            },
            Bare: { sys_id: "r2", name: "Bare" } as unknown as SN.MetaRecord,
          },
        },
        x_empty: {} as SN.TableConfig,
      },
    };

    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), {
      includes: { x_data: { u_secret: { type: "txt" } }, x_empty: { u_secret: { type: "txt" } } },
    });

    const records = manifest.tables.x_data.records;
    expect(records.Listed.files).toEqual([{ name: "u_label", type: "txt" }]);
    expect(records.Bare.files).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Table x_data: ignoring the includes entry for column "u_secret"')
    );
    // The table that lists no records cost no lookup.
    expect(tableAPIGet.mock.calls.some(([, q]) => String(q).includes("x_empty"))).toBe(false);
  });
});

describe("attachDataModelTablesToManifest", () => {
  const DICTIONARY_COLUMNS: Row[] = [
    { element: "element", internal_type: "string" },
    { element: "column_label", internal_type: "string" },
  ];
  const DICTIONARY_RECORDS: Row[] = [
    { sys_id: "d1", name: "x_demo_task", element: "u_foo", column_label: "Foo" },
  ];
  const dataModelInstance = () =>
    fakeInstance({
      metaColumns: DICTIONARY_COLUMNS,
      records: () => [],
    });
  // sys_dictionary is both the data-model table and the dictionary itself, so
  // its record reads (sys_scope=… / sys_idIN…) are answered here.
  const answerRecords = (tableAPIGet: TableApiGet): void => {
    const base = tableAPIGet.getMockImplementation()!;
    tableAPIGet.mockImplementation(async (table, query, fields, limit, offset) => {
      if (table === "sys_dictionary" && String(query).startsWith("sys_scope=")) {
        return { data: { result: DICTIONARY_RECORDS } };
      }
      return base(table, query, fields, limit, offset);
    });
  };
  const optedIn = (
    overrides: Partial<Pick<Sync.Config, "includes">> = {}
  ): Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "dataModelTables"> => ({
    includes: {},
    excludes: { sys_dictionary: true },
    tableOptions: {},
    dataModelTables: ["sys_dictionary"],
    ...overrides,
  });

  it("adds the opted-in table to a manifest the endpoint returned without tables", async () => {
    const tableAPIGet = dataModelInstance();
    answerRecords(tableAPIGet);
    const manifest = { scope: "x_demo", scopeId: "scope-1" } as SN.AppManifest;

    await attachDataModelTablesToManifest(manifest, createClient(tableAPIGet), optedIn());

    expect(Object.keys(manifest.tables)).toEqual(["sys_dictionary"]);
    expect(Object.keys(manifest.tables.sys_dictionary.records)).toEqual(["x_demo_task.u_foo"]);
  });

  it("leaves the manifest's tables as they were when the opted-in table is excluded by includes", async () => {
    const tableAPIGet = dataModelInstance();
    answerRecords(tableAPIGet);
    const existing: SN.TableConfig = {
      records: { x_demo_task: { sys_id: "d1", name: "x_demo_task", files: [] } },
    };
    const manifest: SN.AppManifest = {
      scope: "x_demo",
      scopeId: "scope-1",
      tables: { sys_dictionary: existing },
    };

    await attachDataModelTablesToManifest(
      manifest,
      createClient(tableAPIGet),
      optedIn({ includes: { sys_dictionary: false } })
    );

    expect(manifest.tables.sys_dictionary).toBe(existing);
    expect(
      tableAPIGet.mock.calls.some(([, q]) => String(q).startsWith("sys_scope="))
    ).toBe(false);
  });
});

describe("buildBulkDownloadFromTableAPI", () => {
  it("issues no request and returns no entry for a table with no missing records", async () => {
    const tableAPIGet = fakeInstance();

    const result = await buildBulkDownloadFromTableAPI(
      { sys_script_include: {} },
      createClient(tableAPIGet),
      {}
    );

    expect(Object.keys(result)).toEqual([]);
    expect(tableAPIGet).not.toHaveBeenCalled();
  });
});

describe("listAppsFromTableAPI", () => {
  it("reads a response without a result array as no apps rather than crashing", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockResolvedValue({ data: { error: "unexpected shape" } });

    await expect(listAppsFromTableAPI(createClient(tableAPIGet))).resolves.toEqual([]);
  });
});
