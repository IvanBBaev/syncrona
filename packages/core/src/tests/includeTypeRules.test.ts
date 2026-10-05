// The `includes` unsafe-type rule and its warnings, on both manifest sources,
// plus the record secret rule's partial re-read. Regression tests for review
// findings: the filter used to run in the Table API build only (a scoped
// manifest listed and filled a password2 include), an included column whose
// type could not be read was kept without a word unless the lookup threw, and
// a re-read that returned fewer rows than asked for left no trace.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import { applyIncludeTypeRulesToManifest, buildManifestFromTableAPI } from "../manifestBuilder.js";
import { applyRecordSecretRulesToContent } from "../downloadPipeline.js";
import { classifyColumn } from "../metaFields.js";
import { logger } from "../Logger.js";

type Row = Record<string, unknown>;
type Get = jest.Mock<Promise<{ data: { result: Row[] } }>, [string, string, string, number?, number?]>;
const createClient = (tableAPIGet: Get) => ({ tableAPIGet }) as unknown as import("../snClient").SNClient;
const LINK = "https://x/api/now/table/sys_glide_object/abc";
const ref = (type: string) => ({ link: LINK, value: type });
const forbidden = () =>
  Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } });

const fakeInstance = (o: {
  fileColumns?: Row[];
  columns?: Row[];
  includeLookup?: (query: string) => Row[];
  records?: Record<string, Row[]>;
}): Get => {
  const tableAPIGet: Get = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    const q = String(query);
    if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
    if (table === "sys_metadata") {
      if (q.includes("sys_class_name=")) return { data: { result: [] } };
      return { data: { result: [{ sys_class_name: "x_demo_cred" }] } };
    }
    if (table === "sys_db_object") {
      const name = /name=([^^]+)/.exec(q)?.[1] ?? "";
      return { data: { result: [{ name }] } };
    }
    if (table === "sys_dictionary") {
      if (q.includes("internal_type=")) return { data: { result: o.fileColumns ?? [] } };
      if (q.includes("elementIN") && o.includeLookup) return { data: { result: o.includeLookup(q) } };
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

type BuildConfig = Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "meta" | "dataModelTables">;

const COLUMNS: Row[] = [
  { element: "name", internal_type: ref("string") },
  { element: "script", internal_type: ref("script") },
  { element: "u_token", internal_type: ref("password2") },
  { element: "u_pw", internal_type: ref("password") },
  { element: "u_notes", internal_type: ref("journal") },
  { element: "u_pic", internal_type: ref("user_image") },
  { element: "u_label", internal_type: ref("string") },
];
const SCRIPT_ONLY: Row[] = [{ element: "script", internal_type: ref("script") }];
const RECORDS: Row[] = [{ sys_id: "c1", name: "cred-one", script: "gs.info(1)", u_label: "label" }];
const INCLUDED = ["u_token", "u_pw", "u_notes", "u_pic", "u_label"];
const includeAll = (): Sync.TablePropMap =>
  ({
    x_demo_cred: Object.fromEntries(INCLUDED.map((name) => [name, { type: "txt" as SN.FileType }])),
  }) as Sync.TablePropMap;
const buildConfig = (): BuildConfig =>
  ({ includes: includeAll(), excludes: {}, tableOptions: {}, meta: false }) as BuildConfig;

const unsafeWarning = (column: string, type: string) =>
  `Table x_demo_cred: ignoring the includes entry for column "${column}" — its dictionary type is ` +
  `${type}, and a value of that type is never written to the working tree.`;
const untypedWarning = (columns: string, reason: string) =>
  `Table x_demo_cred: could not read the dictionary type of included column(s) ${columns} ` +
  `(${reason}); they are kept without the unsafe-type check.`;
const NO_TYPE = "no dictionary row or an empty internal_type";

let warn: jest.SpiedFunction<typeof logger.warn>;
const warnings = () => warn.mock.calls.map((call) => String(call[0]));

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

const builtFiles = async (tableAPIGet: Get): Promise<string[]> => {
  const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), buildConfig());
  return (manifest.tables.x_demo_cred?.records["cred-one"]?.files ?? []).map((f) => f.name).sort();
};

describe("classifyColumn", () => {
  it.each<[string | undefined, string, unknown, string]>([
    ["x_demo_cred", "u_token", "password2", "unsafe"],
    ["x_demo_cred", "u_notes", ref("journal"), "unsafe"],
    // A credential type wins over the record rule: never written, not judged per row.
    ["sys_properties", "value", "password", "unsafe"],
    ["sys_properties", "value", "string", "secret"],
    ["sys_properties", "value", undefined, "secret"],
    ["sys_properties", "description", "string", "safe"],
    ["x_demo_cred", "u_ghost", undefined, "unknown"],
    ["x_demo_cred", "u_ghost", { link: LINK, value: "" }, "unknown"],
    [undefined, "script", "script", "safe"],
  ])("%s.%s typed %j is %s", (table, column, type, expected) => {
    expect(classifyColumn(table, column, type)).toBe(expected);
  });
});

describe("includes on the Table API build: a type that cannot be read is named", () => {
  it("E1: the lookup answers 200 with no row — every included column is kept, with one warning", async () => {
    const files = await builtFiles(
      fakeInstance({ fileColumns: SCRIPT_ONLY, columns: COLUMNS, includeLookup: () => [], records: { x_demo_cred: RECORDS } })
    );
    expect(files).toEqual(["script", ...INCLUDED].sort());
    expect(warnings().filter((m) => m.includes("included column"))).toEqual([
      untypedWarning(INCLUDED.join(", "), NO_TYPE),
    ]);
  });

  it("E2: rows with an empty type are kept with a warning; typed ones are judged", async () => {
    const files = await builtFiles(
      fakeInstance({
        fileColumns: SCRIPT_ONLY,
        columns: COLUMNS,
        includeLookup: () => [
          { element: "u_token", internal_type: "" },
          { element: "u_pw", internal_type: { link: LINK, value: "" } },
          { element: "u_notes" },
          { element: "u_pic", internal_type: ref("user_image") },
          { element: "u_label", internal_type: ref("string") },
        ],
        records: { x_demo_cred: RECORDS },
      })
    );
    expect(files).toEqual(["script", "u_label", "u_notes", "u_pw", "u_token"]);
    expect(warnings()).toEqual(
      expect.arrayContaining([
        unsafeWarning("u_pic", "user_image"),
        untypedWarning("u_token, u_pw, u_notes", NO_TYPE),
      ])
    );
    expect(warnings().filter((m) => m.includes("u_label"))).toEqual([]);
  });

  it("E3: the data-field fallback warns for included columns its all-columns read has no row for", async () => {
    process.env.SYNCRONA_DATA_TABLES = "x_demo_cred";
    const files = await builtFiles(
      fakeInstance({
        fileColumns: [],
        columns: COLUMNS.filter((c) => c.element !== "u_token" && c.element !== "u_pw"),
        records: { x_demo_cred: RECORDS },
      })
    );
    expect(files).toEqual(expect.arrayContaining(["u_token", "u_pw", "u_label"]));
    expect(files).not.toContain("u_notes");
    expect(files).not.toContain("u_pic");
    const untyped = warnings().filter((m) => m.includes("could not read the dictionary type"));
    expect(untyped).toHaveLength(1);
    expect(untyped[0]).toContain("u_token, u_pw");
    expect(warnings()).toEqual(
      expect.arrayContaining([unsafeWarning("u_notes", "journal"), unsafeWarning("u_pic", "user_image")])
    );
  });

  it("E4: a lookup that throws keeps every included column and names the error", async () => {
    const tableAPIGet = fakeInstance({ fileColumns: SCRIPT_ONLY, columns: COLUMNS, records: { x_demo_cred: RECORDS } });
    const inner = tableAPIGet.getMockImplementation()!;
    tableAPIGet.mockImplementation(async (table, query, ...rest) => {
      if (table === "sys_dictionary" && String(query).includes("elementIN")) throw forbidden();
      return inner(table, query, ...rest);
    });
    expect(await builtFiles(tableAPIGet)).toEqual(["script", ...INCLUDED].sort());
    expect(warnings().filter((m) => m.includes("included column"))).toEqual([
      untypedWarning(INCLUDED.join(", "), "Request failed with status code 403"),
    ]);
  });

  it("warns once per column per build, and again on the next build", async () => {
    const tableAPIGet = fakeInstance({ fileColumns: SCRIPT_ONLY, columns: COLUMNS, includeLookup: () => [], records: { x_demo_cred: RECORDS } });
    await builtFiles(tableAPIGet);
    await builtFiles(tableAPIGet);
    expect(warnings().filter((m) => m.includes("included column"))).toEqual([
      untypedWarning(INCLUDED.join(", "), NO_TYPE),
      untypedWarning(INCLUDED.join(", "), NO_TYPE),
    ]);
  });
});

describe("applyIncludeTypeRulesToManifest (the scoped endpoint's answer)", () => {
  const scoped = (): SN.AppManifest =>
    ({
      scope: "x_demo",
      tables: {
        x_demo_cred: {
          records: {
            "cred-one": {
              sys_id: "c1",
              name: "cred-one",
              files: [
                { name: "script", type: "js", content: "gs.info(1)" },
                ...INCLUDED.map((name) => ({ name, type: "txt", content: `${name}-VALUE` })),
              ],
            },
            "cred-two": {
              sys_id: "c2",
              name: "cred-two",
              files: [{ name: "u_token", type: "txt", content: "u_token-VALUE-2" }],
            },
          },
        },
      },
    }) as never;
  const config = () => ({ includes: includeAll(), dataModelTables: undefined }) as never;
  const filesOf = (manifest: SN.AppManifest, record: string) =>
    manifest.tables.x_demo_cred.records[record].files.map((f) => f.name);

  it("strips every unsafe include, content and all, from every record — one lookup per table", async () => {
    const tableAPIGet = fakeInstance({
      includeLookup: (q) => COLUMNS.filter((c) => q.includes(String(c.element))),
    });
    const manifest = scoped();
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), config());

    expect(filesOf(manifest, "cred-one")).toEqual(["script", "u_label"]);
    expect(filesOf(manifest, "cred-two")).toEqual([]);
    expect(JSON.stringify(manifest)).not.toMatch(/u_(token|pw|notes|pic)-VALUE/);
    const lookups = tableAPIGet.mock.calls.filter((c) => c[0] === "sys_dictionary");
    expect(lookups).toHaveLength(1);
    expect(String(lookups[0][1])).toContain("elementINu_token,u_pw,u_notes,u_pic,u_label");
    expect(warnings()).toEqual([
      unsafeWarning("u_token", "password2"),
      unsafeWarning("u_pw", "password"),
      unsafeWarning("u_notes", "journal"),
      unsafeWarning("u_pic", "user_image"),
    ]);
  });

  it("keeps an included column with no dictionary row, with the same warning as the Table API build", async () => {
    const tableAPIGet = fakeInstance({
      includeLookup: () => COLUMNS.filter((c) => c.element !== "u_pw" && c.element !== "u_label"),
    });
    const manifest = scoped();
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), config());

    expect(filesOf(manifest, "cred-one")).toEqual(["script", "u_pw", "u_label"]);
    expect(warnings()).toContain(untypedWarning("u_pw, u_label", NO_TYPE));
  });

  it("keeps every include and names the error when the lookup throws", async () => {
    const tableAPIGet: Get = jest.fn(async (table: string) => {
      if (table === "sys_dictionary") throw forbidden();
      return { data: { result: [{ name: "x_demo_cred" }] } };
    });
    const manifest = scoped();
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), config());

    expect(filesOf(manifest, "cred-one")).toEqual(["script", ...INCLUDED]);
    expect(warnings()).toEqual([untypedWarning(INCLUDED.join(", "), "Request failed with status code 403")]);
  });

  it("costs no request when no record lists an included column", async () => {
    const tableAPIGet: Get = jest.fn();
    const manifest = {
      scope: "x_demo",
      tables: { x_demo_cred: { records: { r: { sys_id: "c1", name: "r", files: [{ name: "script", type: "js" }] } } } },
    } as never as SN.AppManifest;
    await applyIncludeTypeRulesToManifest(manifest, createClient(tableAPIGet), config());
    expect(tableAPIGet).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });
});

describe("applyRecordSecretRulesToContent: a re-read that returns fewer rows", () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const manifest = (): SN.AppManifest =>
    ({
      scope: "x_demo",
      tables: {
        sys_properties: {
          records: {
            "x_demo.api_key": { sys_id: A, name: "x_demo.api_key", files: [{ name: "value", type: "txt", content: "S3CR3T" }] },
            "x_demo.endpoint": { sys_id: B, name: "x_demo.endpoint", files: [{ name: "value", type: "txt", content: "https://e" }] },
          },
        },
      },
    }) as never;

  it("C empty: a 200 with no rows writes no value and says how many records it could not re-read", async () => {
    const tableAPIGet: Get = jest.fn(async () => ({ data: { result: [] } }));
    const man = manifest();
    await applyRecordSecretRulesToContent(man, createClient(tableAPIGet), {});

    const records = man.tables.sys_properties.records;
    expect(records["x_demo.api_key"].files).toEqual([{ name: "value", type: "txt" }]);
    expect(records["x_demo.endpoint"].files).toEqual([{ name: "value", type: "txt" }]);
    expect(warnings()).toEqual([
      "Could not re-read the secret-governed value of 2 record(s) (2 in sys_properties) through the " +
        "Table API — no value was written for them; `syncrona refresh` retries them.",
    ]);
  });

  it("counts only the records missing from a partial answer", async () => {
    const tableAPIGet: Get = jest.fn(async () => ({
      data: { result: [{ sys_id: B, name: "x_demo.endpoint", type: "string", value: "https://e" }] },
    }));
    const man = manifest();
    await applyRecordSecretRulesToContent(man, createClient(tableAPIGet), {});

    expect(man.tables.sys_properties.records["x_demo.endpoint"].files[0]).toEqual({
      name: "value",
      type: "txt",
      content: "https://e",
    });
    expect(man.tables.sys_properties.records["x_demo.api_key"].files[0]).not.toHaveProperty("content");
    expect(warnings().filter((m) => m.startsWith("Could not re-read"))).toEqual([
      expect.stringContaining("of 1 record(s) (1 in sys_properties)"),
    ]);
  });

  it("is silent when every requested record comes back", async () => {
    const tableAPIGet: Get = jest.fn(async () => ({
      data: {
        result: [
          { sys_id: A, name: "x_demo.api_key", type: "password2", value: "S3CR3T" },
          { sys_id: B, name: "x_demo.endpoint", type: "string", value: "https://e" },
        ],
      },
    }));
    await applyRecordSecretRulesToContent(manifest(), createClient(tableAPIGet), {});
    expect(warnings().filter((m) => m.startsWith("Could not re-read"))).toEqual([]);
  });
});
