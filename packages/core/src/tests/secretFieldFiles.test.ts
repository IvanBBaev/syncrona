// SPDX-License-Identifier: GPL-3.0-or-later
//
// Secrets and opaque columns must never become working-tree files.
//
//  - `sys_dictionary.internal_type` is a reference column. Without
//    `sysparm_exclude_reference_link` the Table API may answer it as
//    `{ link, value }`, and `String()` on that is "[object Object]" — a type no
//    filter knows, so every filter keyed on it failed OPEN.
//  - `sys_properties.value` is a plain string column whose secrecy is decided
//    by the record's `type`. The sidecar honoured that; a field file made from
//    the same column (an `includes` entry, the data-field fallback) did not.
//  - The data-field fallback (`SYNCRONA_DATA_TABLES`,
//    `SYNCRONA_INCLUDE_DATA_FIELDS`) wrote every column as `.txt` with no type
//    filter at all.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  buildBulkDownloadFromTableAPI,
  buildManifestFromTableAPI,
} from "../manifestBuilder.js";
import {
  dictionaryInternalType,
  isMetaFieldCandidate,
  metaFile,
} from "../metaFields.js";
import { logger } from "../Logger.js";

type Row = Record<string, unknown>;
type TableApiGet = jest.Mock<
  Promise<{ data: { result: Row[] } }>,
  [string, string, string, number?, number?]
>;

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

const LINK = "https://x/api/now/table/sys_glide_object/abc";
// The three wire shapes a reference cell can take.
const shapes = {
  string: (type: string): unknown => type,
  "{link, value}": (type: string): unknown => ({ link: LINK, value: type }),
  "{value, display_value}": (type: string): unknown => ({ value: type, display_value: type }),
} as const;

interface FakeOptions {
  sweep: string[];
  /** Answer to the file-field query (`internal_type=` filter). */
  fileColumns?: Row[];
  /** Answer to the metadata / data-field dictionary query. */
  columns?: Row[];
  /** Records per table. */
  records?: Record<string, Row[]>;
}

const fakeInstance = (options: FakeOptions): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    const q = String(query);
    if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
    if (table === "sys_metadata") {
      if (q.includes("sys_class_name=")) return { data: { result: [] } };
      return { data: { result: options.sweep.map((name) => ({ sys_class_name: name })) } };
    }
    if (table === "sys_db_object") {
      const name = /name=([^^]+)/.exec(q)?.[1] ?? "";
      return { data: { result: [{ name }] } };
    }
    if (table === "sys_dictionary") {
      if (q.includes("internal_type=")) return { data: { result: options.fileColumns ?? [] } };
      return { data: { result: options.columns ?? [] } };
    }
    const rows = options.records?.[table] ?? [];
    if (q.startsWith("sys_idIN")) {
      const ids = q.slice("sys_idIN".length).split("^")[0].split(",");
      return { data: { result: rows.filter((r) => ids.includes(String(r.sys_id))) } };
    }
    return { data: { result: rows } };
  });
  return tableAPIGet;
};

type BuildConfig = Pick<
  Sync.Config,
  "includes" | "excludes" | "tableOptions" | "meta" | "dataModelTables"
>;

const fieldsRequested = (tableAPIGet: TableApiGet, table: string): string[] =>
  tableAPIGet.mock.calls
    .filter(([t]) => t === table)
    .map(([, , fields]) => String(fields));

beforeEach(() => {
  for (const level of ["info", "warn", "debug", "error"] as const) {
    jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SYNCRONA_DATA_TABLES;
  delete process.env.SYNCRONA_INCLUDE_DATA_FIELDS;
});

describe("C1: internal_type in every wire shape", () => {
  it.each(Object.entries(shapes))("dictionaryInternalType unwraps the %s form", (_label, shape) => {
    expect(dictionaryInternalType(shape("password2"))).toBe("password2");
  });

  it("dictionaryInternalType answers '' for a cell with no usable value", () => {
    expect(dictionaryInternalType(undefined)).toBe("");
    expect(dictionaryInternalType({ link: LINK })).toBe("");
  });

  it.each(Object.entries(shapes))(
    "isMetaFieldCandidate refuses password2, journal and script columns in the %s form",
    (_label, shape) => {
      for (const type of ["password", "password2", "journal", "journal_input", "script"]) {
        expect(isMetaFieldCandidate("u_col", shape(type))).toBe(false);
      }
      expect(isMetaFieldCandidate("u_col", shape("string"))).toBe(true);
    }
  );

  it.each(Object.entries(shapes))(
    "the manifest build keeps script files typed and secrets out of metaFields (%s)",
    async (_label, shape) => {
      const tableAPIGet = fakeInstance({
        sweep: ["sys_script_include"],
        fileColumns: [{ element: "script", internal_type: shape("script") }],
        columns: [
          { element: "script", internal_type: shape("script") },
          { element: "api_name", internal_type: shape("string") },
          { element: "u_secret", internal_type: shape("password2") },
          { element: "u_log", internal_type: shape("journal") },
        ],
        records: { sys_script_include: [{ sys_id: "si1", name: "IncludeA" }] },
      });

      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(tableAPIGet),
        { includes: {}, excludes: {}, tableOptions: {} } as BuildConfig
      );

      const table = manifest.tables.sys_script_include;
      expect(table.metaFields).toEqual(["api_name"]);
      expect(table.records.IncludeA.files).toEqual([
        { name: "script", type: "js" },
        metaFile(),
      ]);
    }
  );
});

const PROPERTIES: Row[] = [
  { sys_id: "p1", name: "x_demo.endpoint", type: "string", value: "https://example.test" },
  { sys_id: "p2", name: "x_demo.api_key", type: "password2", value: "s3cr3t" },
  { sys_id: "p3", name: "x_demo.legacy_pw", type: { value: "password", link: LINK }, value: "hunter2" },
  // No readable classifier: fails closed.
  { sys_id: "p4", name: "x_demo.unclassified", value: "maybe-secret" },
];

const propertyConfig = (): BuildConfig => ({
  includes: { sys_properties: { value: { type: "txt" as SN.FileType } } } as Sync.TablePropMap,
  excludes: {},
  tableOptions: {},
  meta: false,
});

describe("C2: includes-driven sys_properties.value follows the record secret rule", () => {
  it("lists value only for a record whose type is known and not a password", async () => {
    const tableAPIGet = fakeInstance({
      sweep: ["sys_properties"],
      records: { sys_properties: PROPERTIES },
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      propertyConfig()
    );

    const records = manifest.tables.sys_properties.records;
    expect(records["x_demo.endpoint"].files).toEqual([{ name: "value", type: "txt" }]);
    expect(records["x_demo.api_key"].files).toEqual([]);
    expect(records["x_demo.legacy_pw"].files).toEqual([]);
    expect(records["x_demo.unclassified"].files).toEqual([]);
    // The classifier is selected with the record query so each row can be judged.
    expect(fieldsRequested(tableAPIGet, "sys_properties")[0].split(",")).toContain("type");
  });

  it("the download withholds the value of a password property a manifest still lists", async () => {
    const tableAPIGet = fakeInstance({ sweep: [], records: { sys_properties: PROPERTIES } });
    const valueFile = [{ name: "value", type: "txt" as SN.FileType }];
    const missing: SN.MissingFileTableMap = {
      sys_properties: { p1: valueFile, p2: valueFile, p3: valueFile, p4: valueFile },
    };

    const result = await buildBulkDownloadFromTableAPI(
      missing,
      createClient(tableAPIGet),
      {},
      {
        sys_properties: {
          p1: "x_demo.endpoint",
          p2: "x_demo.api_key",
          p3: "x_demo.legacy_pw",
          p4: "x_demo.unclassified",
        },
      }
    );

    const records = result.sys_properties.records;
    expect(records["x_demo.endpoint"].files).toEqual([
      { name: "value", type: "txt", content: "https://example.test" },
    ]);
    for (const name of ["x_demo.api_key", "x_demo.legacy_pw", "x_demo.unclassified"]) {
      expect(records[name].files).toEqual([]);
    }
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t|hunter2|maybe-secret/);
    expect(fieldsRequested(tableAPIGet, "sys_properties")[0].split(",")).toContain("type");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("withheld 3 secret field value(s)")
    );
  });

  it("does not add the classifier to a table without a secret rule", async () => {
    const tableAPIGet = fakeInstance({
      sweep: [],
      records: { sys_script_include: [{ sys_id: "si1", name: "IncludeA", script: "x" }] },
    });
    await buildBulkDownloadFromTableAPI(
      { sys_script_include: { si1: [{ name: "script", type: "js" as SN.FileType }] } },
      createClient(tableAPIGet),
      {}
    );
    expect(fieldsRequested(tableAPIGet, "sys_script_include")[0]).toBe("sys_id,name,script");
  });
});

describe("C3: the data-field fallback applies the type and secret filters", () => {
  const dataColumns = (shape: (type: string) => unknown): Row[] => [
    { element: "name", internal_type: shape("string") },
    { element: "type", internal_type: shape("string") },
    { element: "value", internal_type: shape("string") },
    { element: "u_token", internal_type: shape("password2") },
    { element: "u_pw", internal_type: shape("password") },
    { element: "u_notes", internal_type: shape("journal") },
    { element: "u_pic", internal_type: shape("user_image") },
  ];

  it.each([
    ["SYNCRONA_DATA_TABLES", "sys_properties"],
    ["SYNCRONA_INCLUDE_DATA_FIELDS", "1"],
  ])("%s: no password, journal or image column becomes a field file", async (variable, value) => {
    process.env[variable] = value;
    const tableAPIGet = fakeInstance({
      sweep: ["sys_properties"],
      columns: dataColumns(shapes["{link, value}"]),
      records: { sys_properties: PROPERTIES },
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
      meta: false,
    } as BuildConfig);

    const records = manifest.tables.sys_properties.records;
    const names = (record: string) => records[record].files.map((f) => f.name).sort();
    expect(names("x_demo.endpoint")).toEqual(["name", "type", "value"]);
    // The record-level rule still applies to the fallback's `value` file.
    expect(names("x_demo.api_key")).toEqual(["name", "type"]);
    expect(names("x_demo.unclassified")).toEqual(["name", "type"]);
  });

  it("an unsafe type on any hierarchy row of a column excludes it", async () => {
    process.env.SYNCRONA_DATA_TABLES = "x_demo_cfg";
    const tableAPIGet = fakeInstance({
      sweep: ["x_demo_cfg"],
      columns: [
        { element: "u_key", internal_type: "string" },
        { element: "u_key", internal_type: { value: "password2", link: LINK } },
        { element: "u_label", internal_type: "string" },
      ],
      records: { x_demo_cfg: [{ sys_id: "c1", name: "cfg" }] },
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
      meta: false,
    } as BuildConfig);

    expect(manifest.tables.x_demo_cfg.records.cfg.files).toEqual([
      { name: "u_label", type: "txt" },
    ]);
    expect(
      tableAPIGet.mock.calls.some(
        ([t, q, f]) => t === "sys_dictionary" && !String(q).includes("internal_type=") && f === "element,internal_type"
      )
    ).toBe(true);
  });
});

describe("C4: an includes entry does not lift the unsafe-type filter", () => {
  const ref = (type: string): unknown => ({ link: LINK, value: type });
  const CRED_COLUMNS: Row[] = [
    { element: "name", internal_type: ref("string") },
    { element: "script", internal_type: ref("script") },
    { element: "u_token", internal_type: ref("password2") },
    { element: "u_pw", internal_type: ref("password") },
    { element: "u_notes", internal_type: ref("journal") },
    { element: "u_pic", internal_type: ref("user_image") },
    { element: "u_label", internal_type: ref("string") },
  ];
  const CRED_RECORDS: Row[] = [
    {
      sys_id: "c1",
      name: "cred-one",
      script: "gs.info(1)",
      u_token: "S3CR3T-TOKEN",
      u_pw: "S3CR3T-PW",
      u_notes: "journal text",
      u_pic: "img",
      u_label: "label",
    },
  ];
  const UNSAFE = ["u_token", "u_pw", "u_notes", "u_pic"];
  const includesFor = (columns: string[]): Sync.TablePropMap =>
    ({
      x_demo_cred: Object.fromEntries(
        columns.map((column) => [column, { type: "txt" as SN.FileType }])
      ),
    }) as Sync.TablePropMap;
  const config = (includes: Sync.TablePropMap): BuildConfig =>
    ({ includes, excludes: {}, tableOptions: {}, meta: false }) as BuildConfig;
  const warnings = (): string[] =>
    (logger.warn as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));

  const buildAndDownload = async (tableAPIGet: TableApiGet, includes: Sync.TablePropMap) => {
    const client = createClient(tableAPIGet);
    const manifest = await buildManifestFromTableAPI("x_demo", client, config(includes));
    const files = manifest.tables.x_demo_cred?.records["cred-one"]?.files ?? [];
    const download = await buildBulkDownloadFromTableAPI(
      { x_demo_cred: { c1: files.map((f) => ({ name: f.name, type: f.type })) } } as SN.MissingFileTableMap,
      client,
      {},
      { x_demo_cred: { c1: "cred-one" } }
    );
    return {
      names: files.map((f) => f.name).sort(),
      downloaded: JSON.stringify(download.x_demo_cred?.records["cred-one"]?.files ?? []),
    };
  };

  it("file-field path: drops an included password, journal or image column and warns once per column", async () => {
    const tableAPIGet = fakeInstance({
      sweep: ["x_demo_cred"],
      fileColumns: [{ element: "script", internal_type: ref("script") }],
      columns: CRED_COLUMNS,
      records: { x_demo_cred: CRED_RECORDS },
    });

    const out = await buildAndDownload(tableAPIGet, includesFor([...UNSAFE, "u_label"]));

    expect(out.names).toEqual(["script", "u_label"]);
    expect(out.downloaded).not.toMatch(/S3CR3T/);
    expect(out.downloaded).toContain("label");
    for (const column of UNSAFE) {
      expect(
        warnings().filter((w) => w.includes("x_demo_cred") && w.includes(`"${column}"`))
      ).toHaveLength(1);
    }
    // The included columns' types are read in one dictionary lookup.
    expect(
      tableAPIGet.mock.calls.filter(
        ([t, q]) => t === "sys_dictionary" && String(q).includes("^elementINu_token,u_pw,u_notes,u_pic,u_label")
      )
    ).toHaveLength(1);
  });

  it("data-field fallback: includes cannot re-add a column the filter dropped, and each warning is emitted once", async () => {
    process.env.SYNCRONA_DATA_TABLES = "x_demo_cred";
    const tableAPIGet = fakeInstance({
      sweep: ["x_demo_cred"],
      fileColumns: [],
      columns: CRED_COLUMNS,
      records: { x_demo_cred: CRED_RECORDS },
    });

    // Only unsafe columns are included, so the file-field path ends up empty and
    // the table falls through to the data-field fallback, which sees them again.
    const out = await buildAndDownload(tableAPIGet, includesFor(UNSAFE));

    expect(out.names).toEqual(["name", "script", "u_label"]);
    expect(out.downloaded).not.toMatch(/S3CR3T/);
    for (const column of UNSAFE) {
      expect(
        warnings().filter((w) => w.includes("x_demo_cred") && w.includes(`"${column}"`))
      ).toHaveLength(1);
    }
  });

  it("keeps an included column the dictionary has no row for", async () => {
    const tableAPIGet = fakeInstance({
      sweep: ["x_demo_cred"],
      fileColumns: [{ element: "script", internal_type: ref("script") }],
      columns: CRED_COLUMNS,
      records: { x_demo_cred: [{ ...CRED_RECORDS[0], u_calc: "derived" }] },
    });

    const out = await buildAndDownload(tableAPIGet, includesFor(["u_calc", "u_token"]));

    expect(out.names).toEqual(["script", "u_calc"]);
  });

  it("keeps the included columns, and says so, when their dictionary type cannot be read", async () => {
    const base = fakeInstance({
      sweep: ["x_demo_cred"],
      fileColumns: [{ element: "script", internal_type: ref("script") }],
      columns: CRED_COLUMNS,
      records: { x_demo_cred: CRED_RECORDS },
    });
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table, query, ...rest) => {
      if (table === "sys_dictionary" && String(query).includes("^elementIN")) {
        throw new Error("read ACL on sys_dictionary");
      }
      return base(table, query, ...rest);
    });

    const client = createClient(tableAPIGet);
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      client,
      config(includesFor(["u_label", "u_token"]))
    );

    expect(manifest.tables.x_demo_cred.records["cred-one"].files.map((f) => f.name).sort()).toEqual([
      "script",
      "u_label",
      "u_token",
    ]);
    expect(
      warnings().some(
        (w) =>
          w.includes("x_demo_cred") &&
          w.includes("could not read the dictionary type") &&
          w.includes("u_label, u_token")
      )
    ).toBe(true);
  });
});
