// A dot-walked field name (`sys_created_by.user_password`) reads a column of
// ANOTHER record: this table's dictionary has no row for it, so the unsafe-type
// check could only call it "unknown" and keep it. Regression tests for the
// review finding that a field-level `includes` entry, or a field file a
// hand-edited manifest lists, under such a name was requested and written —
// the creator's password in the working tree. The ATF step script
// (`sys_atf_step` `inputs.script`) is the one dotted name the CLI requests
// itself, and it keeps working.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  applyIncludeTypeRulesToManifest,
  buildBulkDownloadFromTableAPI,
  buildManifestFromTableAPI,
} from "../manifestBuilder.js";
import { logger } from "../Logger.js";

type Row = Record<string, unknown>;
type Get = jest.Mock<Promise<{ data: { result: Row[] } }>, [string, string, string, number?, number?]>;
const createClient = (tableAPIGet: Get) => ({ tableAPIGet }) as unknown as import("../snClient").SNClient;
const ref = (type: string) => ({ link: "https://x/api/now/table/sys_glide_object/abc", value: type });

const WALKED = "sys_created_by.user_password";
const TABLE = "x_demo_cred";

const fakeInstance = (o: {
  tableName?: string;
  fileColumns?: Row[];
  columns?: Row[];
  records?: Record<string, Row[]>;
}): Get => {
  const tableAPIGet: Get = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    const q = String(query);
    if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
    if (table === "sys_metadata") {
      if (q.includes("sys_class_name=")) return { data: { result: [] } };
      return { data: { result: [{ sys_class_name: o.tableName ?? TABLE }] } };
    }
    if (table === "sys_db_object") {
      const name = /name=([^^]+)/.exec(q)?.[1] ?? "";
      return { data: { result: [{ name }] } };
    }
    if (table === "sys_dictionary") {
      if (q.includes("internal_type=")) return { data: { result: o.fileColumns ?? [] } };
      return { data: { result: o.columns ?? [] } };
    }
    const rows = o.records?.[table] ?? [];
    if (q.startsWith("sys_idIN")) {
      const ids = q.slice("sys_idIN".length).split("^")[0].split(",");
      return { data: { result: rows.filter((r) => ids.includes(String(r.sys_id))) } };
    }
    return { data: { result: rows } };
  });
  return tableAPIGet;
};

const COLUMNS: Row[] = [
  { element: "name", internal_type: ref("string") },
  { element: "script", internal_type: ref("script") },
  { element: "u_label", internal_type: ref("string") },
];
const SCRIPT_ONLY: Row[] = [{ element: "script", internal_type: ref("script") }];
const RECORDS: Row[] = [
  { sys_id: "c1", name: "cred-one", script: "gs.info(1)", u_label: "label", [WALKED]: "hunter2" },
];

const includes = (): Sync.TablePropMap =>
  ({
    [TABLE]: { [WALKED]: { type: "txt" as SN.FileType }, u_label: { type: "txt" as SN.FileType } },
  }) as Sync.TablePropMap;
const buildConfig = () =>
  ({ includes: includes(), excludes: {}, tableOptions: {}, meta: false }) as unknown as Sync.Config;

const walkedWarning = (selector: string, table = TABLE, column = WALKED) =>
  `Table ${table}: ignoring the ${selector} entry for column "${column}" — ` +
  "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
  "so it is never written to the working tree.";

let warn: jest.SpiedFunction<typeof logger.warn>;
const warnings = () => warn.mock.calls.map((call) => String(call[0]));
const dotWalkWarnings = () => warnings().filter((m) => m.includes("a dot-walked column"));
const requested = (tableAPIGet: Get) =>
  tableAPIGet.mock.calls.map((call) => `${call[0]} ${call[1]} ${call[2]}`).join("\n");

beforeEach(() => {
  for (const level of ["info", "debug", "error"] as const) {
    jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
  }
  warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SYNCRONA_DATA_TABLES;
});

const builtFiles = async (tableAPIGet: Get, tableName = TABLE, record = "cred-one"): Promise<string[]> => {
  const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), buildConfig());
  return (manifest.tables[tableName]?.records[record]?.files ?? []).map((f) => f.name).sort();
};

describe("a dot-walked field-level includes entry (Table API build)", () => {
  it("is never listed, looked up or requested, and is named in one warning", async () => {
    const tableAPIGet = fakeInstance({ fileColumns: SCRIPT_ONLY, columns: COLUMNS, records: { [TABLE]: RECORDS } });

    expect(await builtFiles(tableAPIGet)).toEqual(["script", "u_label"]);
    expect(requested(tableAPIGet)).not.toContain("user_password");
    expect(dotWalkWarnings()).toEqual([walkedWarning("includes")]);
  });

  it("warns once per build although the data-field fallback judges the includes again", async () => {
    process.env.SYNCRONA_DATA_TABLES = TABLE;
    const tableAPIGet = fakeInstance({ fileColumns: [], columns: COLUMNS, records: { [TABLE]: RECORDS } });

    const files = await builtFiles(tableAPIGet);
    expect(files).toEqual(expect.arrayContaining(["u_label"]));
    expect(files).not.toContain(WALKED);
    expect(requested(tableAPIGet)).not.toContain("user_password");
    expect(dotWalkWarnings()).toEqual([walkedWarning("includes")]);

    await builtFiles(tableAPIGet);
    expect(dotWalkWarnings()).toEqual([walkedWarning("includes"), walkedWarning("includes")]);
  });

  it("still lists the ATF step script, the one dotted name the CLI requests itself", async () => {
    const tableAPIGet = fakeInstance({
      tableName: "sys_atf_step",
      records: { sys_atf_step: [{ sys_id: "s1", name: "step-one", "inputs.script": "gs.info(2)" }] },
    });
    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), buildConfig());
    const record = Object.values(manifest.tables.sys_atf_step.records)[0];

    expect(record.files.map((f) => f.name)).toEqual(["inputs.script"]);
    expect(dotWalkWarnings()).toEqual([]);
  });
});

describe("a dot-walked field-level includes entry (scoped endpoint answer)", () => {
  const scoped = (files: SN.File[]): SN.AppManifest =>
    ({
      scope: "x_demo",
      tables: { [TABLE]: { records: { "cred-one": { sys_id: "c1", name: "cred-one", files } } } },
    }) as never;

  it("is removed, content and all, from every record without a lookup", async () => {
    const tableAPIGet = fakeInstance({ columns: COLUMNS });
    const manifest = scoped([
      { name: "script", type: "js", content: "gs.info(1)" },
      { name: WALKED, type: "txt", content: "hunter2" },
    ] as SN.File[]);
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), {
      includes: includes(),
      dataModelTables: undefined,
    } as never);

    expect(manifest.tables[TABLE].records["cred-one"].files.map((f) => f.name)).toEqual(["script"]);
    expect(JSON.stringify(manifest)).not.toContain("hunter2");
    expect(tableAPIGet).not.toHaveBeenCalled();
    expect(dotWalkWarnings()).toEqual([walkedWarning("includes")]);
  });

  it("leaves the own columns to the type lookup", async () => {
    const tableAPIGet = fakeInstance({ columns: COLUMNS });
    const manifest = scoped([
      { name: "u_label", type: "txt", content: "label" },
      { name: WALKED, type: "txt", content: "hunter2" },
    ] as SN.File[]);
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), {
      includes: includes(),
      dataModelTables: undefined,
    } as never);

    expect(manifest.tables[TABLE].records["cred-one"].files.map((f) => f.name)).toEqual(["u_label"]);
    const lookups = tableAPIGet.mock.calls.filter((c) => c[0] === "sys_dictionary");
    expect(lookups).toHaveLength(1);
    expect(String(lookups[0][1])).toContain("elementINu_label");
    expect(String(lookups[0][1])).not.toContain("user_password");
  });
});

describe("a dot-walked field file a hand-edited manifest lists (bulk download)", () => {
  const file = (name: string, type = "txt") => ({ name, type }) as SN.File;

  it("is never requested or written, and two records listing it cost one warning", async () => {
    const tableAPIGet = fakeInstance({
      records: {
        [TABLE]: [
          ...RECORDS,
          { sys_id: "c2", name: "cred-two", script: "gs.info(3)", [WALKED]: "hunter3" },
        ],
      },
    });
    const missing = {
      [TABLE]: { c1: [file("script", "js"), file(WALKED)], c2: [file(WALKED), file("script", "js")] },
    } as unknown as SN.MissingFileTableMap;

    const tableMap = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {}, {
      [TABLE]: { c1: "cred-one", c2: "cred-two" },
    });

    for (const record of ["cred-one", "cred-two"]) {
      expect(tableMap[TABLE].records[record].files.map((f) => f.name)).toEqual(["script"]);
    }
    expect(JSON.stringify(tableMap)).not.toMatch(/hunter/);
    expect(requested(tableAPIGet)).not.toContain("user_password");
    expect(dotWalkWarnings()).toEqual([walkedWarning("manifest files")]);
  });

  it("still requests and writes the ATF step script", async () => {
    const tableAPIGet = fakeInstance({
      records: { sys_atf_step: [{ sys_id: "s1", name: "step-one", "inputs.script": "gs.info(2)" }] },
    });
    const missing = { sys_atf_step: { s1: [file("inputs.script", "js")] } } as unknown as SN.MissingFileTableMap;

    const tableMap = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {}, {
      sys_atf_step: { s1: "step-one" },
    });

    expect(tableMap.sys_atf_step.records["step-one"].files).toEqual([
      { name: "inputs.script", type: "js", content: "gs.info(2)" },
    ]);
    expect(requested(tableAPIGet)).toContain("inputs.script");
    expect(dotWalkWarnings()).toEqual([]);
  });

  it("refuses a dotted name on sys_atf_step other than inputs.script", async () => {
    const tableAPIGet = fakeInstance({
      records: { sys_atf_step: [{ sys_id: "s1", name: "step-one", "inputs.script": "x", [WALKED]: "hunter2" }] },
    });
    const missing = {
      sys_atf_step: { s1: [file("inputs.script", "js"), file(WALKED)] },
    } as unknown as SN.MissingFileTableMap;

    const tableMap = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {}, {
      sys_atf_step: { s1: "step-one" },
    });

    expect(tableMap.sys_atf_step.records["step-one"].files.map((f) => f.name)).toEqual(["inputs.script"]);
    expect(dotWalkWarnings()).toEqual([walkedWarning("manifest files", "sys_atf_step")]);
  });
});

describe("the dot-walk exemptions are exactly the ATF step script and the .meta sidecar (bulk download)", () => {
  it("refuses inputs.script on a table other than sys_atf_step", async () => {
    const tableAPIGet = fakeInstance({
      records: {
        sys_script_include: [{ sys_id: "s1", name: "one", script: "gs.info(1)", "inputs.script": "leak" }],
      },
    });
    const missing = {
      sys_script_include: { s1: [{ name: "inputs.script", type: "js" }, { name: "script", type: "js" }] },
    } as unknown as SN.MissingFileTableMap;

    const tableMap = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {}, {
      sys_script_include: { s1: "one" },
    });

    expect(tableMap.sys_script_include.records.one.files.map((f) => f.name)).toEqual(["script"]);
    expect(requested(tableAPIGet)).not.toContain("inputs.script");
    expect(dotWalkWarnings()).toEqual([walkedWarning("manifest files", "sys_script_include", "inputs.script")]);
  });

  it.each(["sys_created_by.meta", "foo.meta"])(
    "refuses %s, a dotted name that only ends like the sidecar",
    async (column) => {
      const tableAPIGet = fakeInstance({
        records: { [TABLE]: [{ sys_id: "c1", name: "cred-one", script: "gs.info(1)", [column]: "leak" }] },
      });
      const missing = {
        [TABLE]: { c1: [{ name: column, type: "txt" }, { name: "script", type: "js" }] },
      } as unknown as SN.MissingFileTableMap;

      const tableMap = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {}, {
        [TABLE]: { c1: "cred-one" },
      });

      expect(tableMap[TABLE].records["cred-one"].files.map((f) => f.name)).toEqual(["script"]);
      expect(requested(tableAPIGet)).not.toContain(column);
      expect(dotWalkWarnings()).toEqual([walkedWarning("manifest files", TABLE, column)]);
    }
  );
});
