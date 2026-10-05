// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2, end to end on a temp workspace: a download under dataModelLayout
// "composite" writes one data-model document per table, a refresh sees those
// sidecars as present, and a push expands the document back into exactly the
// per-record metadata updates the records layout would send — table first,
// then columns, then choices. Real FileUtils, PluginManager and pipelines; the
// instance is mocked.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { SN, Sync } from "@syncrona/types";

let root: string;
let src: string;
let config: Record<string, unknown>;
let manifest: SN.AppManifest;

const updateRecord = jest.fn();
const tableAPIGet = jest.fn();
const warn = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: () => config,
  getSourcePath: () => src,
  getBuildPath: () => path.join(root, "build"),
  getRootDir: () => root,
  getManifest: () => manifest,
  getManifestPath: () => path.join(root, "syncrona.manifest.json"),
  updateManifest: (next: SN.AppManifest) => {
    manifest = next;
  },
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: jest.fn(),
    getLogLevel: () => "info",
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({ updateRecord, tableAPIGet }),
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: () => false,
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let processTablesInManifest: typeof import("../downloadPipeline.js").processTablesInManifest;
let findMissingFiles: typeof import("../downloadPipeline.js").findMissingFiles;
let getAppFileListWithCandidates: typeof import("../pushPipeline.js").getAppFileListWithCandidates;
let pushFiles: typeof import("../pushPipeline.js").pushFiles;

const ALL = ["sys_db_object", "sys_dictionary", "sys_choice"];
const TABLE = { label: "Task", name: "x_demo_task", super_class: "task" };
const COLUMN = { column_label: "Foo", element: "u_foo", name: "x_demo_task" };
const CHOICE = { element: "u_foo", label: "One", name: "x_demo_task", value: "1" };
const ROWS: Record<string, Record<string, string>> = {
  t1: TABLE,
  d1: COLUMN,
  c1: CHOICE,
};

const sidecar = (columns: Record<string, string>) =>
  `${JSON.stringify(
    Object.fromEntries(Object.keys(columns).sort().map((k) => [k, columns[k]])),
    null,
    2
  )}\n`;

const record = (name: string, sysId: string, files: SN.File[]) => ({ name, sys_id: sysId, files });
const meta = (columns?: Record<string, string>): SN.File =>
  ({ name: ".meta", type: "json", ...(columns ? { content: sidecar(columns) } : {}) }) as SN.File;

/** The tables a download hands processTablesInManifest (with content). */
const pulled = (): SN.TableMap =>
  ({
    sys_db_object: { records: { x_demo_task: record("x_demo_task", "t1", [meta(TABLE)]) } },
    sys_dictionary: {
      records: {
        "x_demo_task.u_foo": record("x_demo_task.u_foo", "d1", [
          meta(COLUMN),
          { name: "calculation", type: "js", content: "current.u_foo;" } as SN.File,
        ]),
      },
    },
    sys_choice: { records: { "x_demo_task.u_foo.1": record("x_demo_task.u_foo.1", "c1", [meta(CHOICE)]) } },
  }) as unknown as SN.TableMap;

const manifestFor = (tables: SN.TableMap): SN.AppManifest => {
  const copy = JSON.parse(JSON.stringify(tables)) as SN.TableMap;
  for (const table of Object.values(copy)) {
    (table as { metaFields?: string[] }).metaFields = ["column_label", "element", "label", "name", "super_class", "value"];
    for (const rec of Object.values(table.records)) rec.files.forEach((f) => delete f.content);
  }
  return { scope: "x_demo", tables: copy } as SN.AppManifest;
};

const docPath = () => path.join(src, "data-model", "x_demo_task.json");

beforeAll(async () => {
  ({ processTablesInManifest, findMissingFiles } = await import("../downloadPipeline.js"));
  ({ getAppFileListWithCandidates, pushFiles } = await import("../pushPipeline.js"));
});

beforeEach(() => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(os.tmpdir(), "sdk-f2-flow-"));
  src = path.join(root, "src");
  config = { dataModelLayout: "composite", dataModelTables: ALL, pushConcurrency: 4, tableOptions: {} };
  manifest = manifestFor(pulled());
  tableAPIGet.mockImplementation(async (_table: unknown, query: unknown) => ({
    data: { result: [ROWS[String(query).replace("sys_id=", "")]] },
  }));
  updateRecord.mockResolvedValue({ data: { result: {} } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("download under the composite layout", () => {
  it("writes one document per table and no per-record sidecars", async () => {
    const tables = pulled();
    await processTablesInManifest(tables, true);
    expect(JSON.parse(await fsp.readFile(docPath(), "utf8"))).toEqual({
      format: "syncrona.data-model/1",
      table: "x_demo_task",
      sys_db_object: { x_demo_task: TABLE },
      sys_dictionary: { "x_demo_task.u_foo": COLUMN },
      sys_choice: { "x_demo_task.u_foo.1": CHOICE },
    });
    // a field file still lands per record; metadata-only records get no folder
    const columnDir = path.join(src, "sys_dictionary", "x_demo_task.u_foo");
    expect(await fsp.readdir(columnDir)).toEqual(["calculation.js"]);
    expect(existsSync(path.join(src, "sys_choice"))).toBe(false);
    expect(existsSync(path.join(src, "sys_db_object"))).toBe(false);
    // contents are stripped for the manifest write, as before
    expect("content" in tables.sys_choice.records["x_demo_task.u_foo.1"].files[0]).toBe(false);
  });

  it("is byte-stable: an unchanged re-download does not touch the document", async () => {
    await processTablesInManifest(pulled(), true);
    const before = await fsp.readFile(docPath(), "utf8");
    const stamp = new Date("2020-01-01T00:00:00Z");
    await fsp.utimes(docPath(), stamp, stamp);
    await processTablesInManifest(pulled(), true);
    expect(await fsp.readFile(docPath(), "utf8")).toBe(before);
    expect((await fsp.stat(docPath())).mtime.getTime()).toBe(stamp.getTime());
  });

  it("writes flat-layout field files without a document sidecar either", async () => {
    config = { ...config, flat: true };
    await processTablesInManifest(pulled(), true);
    expect(await fsp.readdir(path.join(src, "sys_dictionary"))).toEqual(["x_demo_task.u_foo~calculation.js"]);
    expect(existsSync(path.join(src, "sys_choice"))).toBe(false);
    expect(existsSync(docPath())).toBe(true);
  });

  it("refuses, before writing anything, a record that still has a per-record sidecar", async () => {
    const stale = path.join(src, "sys_choice", "x_demo_task.u_foo.1", ".meta.json");
    await fsp.mkdir(path.dirname(stale), { recursive: true });
    await fsp.writeFile(stale, "{}\n");
    await expect(processTablesInManifest(pulled(), true)).rejects.toThrow(/per-record sidecar/);
    expect(existsSync(docPath())).toBe(false);
    expect(existsSync(path.join(src, "sys_dictionary"))).toBe(false);
  });

  it("refuses a records-layout download while a document holds the record", async () => {
    await processTablesInManifest(pulled(), true);
    config = { dataModelTables: ALL, tableOptions: {} };
    await expect(processTablesInManifest(pulled(), true)).rejects.toThrow(/dataModelLayout is "records"/);
    expect(existsSync(path.join(src, "sys_choice"))).toBe(false);
  });

  it("refresh counts document entries as present, and a removed entry as missing", async () => {
    await processTablesInManifest(pulled(), true);
    expect({ ...(await findMissingFiles(manifest)) }).toEqual({});
    const doc = JSON.parse(await fsp.readFile(docPath(), "utf8"));
    delete doc.sys_choice;
    delete doc.sys_db_object;
    await fsp.writeFile(docPath(), JSON.stringify(doc));
    await fsp.rm(path.join(src, "sys_dictionary", "x_demo_task.u_foo", "calculation.js"));
    const missing = await findMissingFiles(manifest);
    expect(Object.keys(missing).sort()).toEqual(["sys_choice", "sys_db_object", "sys_dictionary"]);
    expect(missing.sys_choice.c1.map((f) => f.name)).toEqual([".meta"]);
    expect(missing.sys_dictionary.d1.map((f) => f.name)).toEqual(["calculation"]);
  });
});

describe("push under the composite layout", () => {
  beforeEach(async () => {
    await processTablesInManifest(pulled(), true);
  });

  const editDoc = async (edit: (doc: Record<string, Record<string, Record<string, string>>>) => void) => {
    const doc = JSON.parse(await fsp.readFile(docPath(), "utf8"));
    edit(doc);
    await fsp.writeFile(docPath(), JSON.stringify(doc));
  };

  it("expands a document into one in-memory sidecar per entry", async () => {
    const { records } = await getAppFileListWithCandidates([docPath()], { create: false });
    expect(records.map((r) => `${r.table}:${r.sysId}`).sort()).toEqual([
      "sys_choice:c1",
      "sys_db_object:t1",
      "sys_dictionary:d1",
    ]);
    const choice = records.find((r) => r.table === "sys_choice") as Sync.BuildableRecord;
    expect(choice.fields[".meta"].fileContents).toBe(sidecar(CHOICE));
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends only the edited columns, table, then column, then choice", async () => {
    await editDoc((doc) => {
      doc.sys_choice["x_demo_task.u_foo.1"].label = "Uno";
      doc.sys_dictionary["x_demo_task.u_foo"].column_label = "Fooed";
      doc.sys_db_object.x_demo_task.label = "Tasks";
    });
    const { records } = await getAppFileListWithCandidates([docPath()], { create: false });
    const results = await pushFiles([...records].reverse());
    expect(results.every((r) => r.success)).toBe(true);
    expect(updateRecord.mock.calls.map((c) => [c[0], { ...(c[2] as object) }])).toEqual([
      ["sys_db_object", { label: "Tasks" }],
      ["sys_dictionary", { column_label: "Fooed" }],
      ["sys_choice", { label: "Uno" }],
    ]);
    // results stay in input order
    expect(results[0].message).toContain("sys_choice");
  });

  it("pushes nothing for an unchanged document", async () => {
    const { records } = await getAppFileListWithCandidates([docPath()], { create: false });
    const results = await pushFiles(records);
    expect(results.map((r) => r.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("nothing to push")])
    );
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it("turns a new entry into a create candidate ordered by tier, carrying its contents", async () => {
    await editDoc((doc) => {
      doc.sys_choice["x_demo_task.u_foo.2"] = { ...CHOICE, label: "Two", value: "2" };
      doc.sys_dictionary["x_demo_task.u_bar"] = { ...COLUMN, element: "u_bar" };
    });
    const { candidates } = await getAppFileListWithCandidates([docPath()], { create: true });
    expect(candidates.map((c) => `${c.table}:${c.recordName}`)).toEqual([
      "sys_dictionary:x_demo_task.u_bar",
      "sys_choice:x_demo_task.u_foo.2",
    ]);
    expect(candidates[1].files[0].contents).toBe(sidecar({ ...CHOICE, label: "Two", value: "2" }));
    // without --create the new entries are named by document and entry
    await getAppFileListWithCandidates([docPath()], { create: false });
    expect(String(warn.mock.calls[0][0])).toContain("x_demo_task.json#sys_choice/x_demo_task.u_foo.2");
  });

  it("refuses a record held by a document and a per-record sidecar", async () => {
    const both = path.join(src, "sys_choice", "x_demo_task.u_foo.1", ".meta.json");
    await fsp.mkdir(path.dirname(both), { recursive: true });
    await fsp.writeFile(both, sidecar(CHOICE));
    const refused = getAppFileListWithCandidates([docPath(), both], { create: false });
    await expect(refused).rejects.toThrow(/^Ambiguous data-model layout/);
    await expect(refused).rejects.toThrow(/is in both[\s\S]*is a per-record sidecar/);
  });

  it("refuses a section for a table outside dataModelTables, and a document under records", async () => {
    config = { ...config, dataModelTables: ["sys_db_object", "sys_dictionary"] };
    await expect(getAppFileListWithCandidates([docPath()], { create: false })).rejects.toThrow(
      /sys_choice section, but sys_choice is not in dataModelTables/
    );
    config = { dataModelTables: ALL };
    await expect(getAppFileListWithCandidates([docPath()], { create: false })).rejects.toThrow(
      /is a data-model document, but dataModelLayout is "records"/
    );
  });

  it.each([false, true])(
    "refuses an entry key that escapes into another table's record (flat=%s)",
    async (flat) => {
      config = { ...config, flat };
      // A record of a table the composite layout does not cover.
      manifest.tables.sys_script = {
        records: { foo: record("foo", "s1", [meta()]) },
      } as unknown as SN.TableConfig;
      await editDoc((doc) => {
        doc.sys_choice["../sys_script/foo"] = { script: "gs.info('pwned');" };
      });
      for (const create of [false, true]) {
        await expect(getAppFileListWithCandidates([docPath()], { create })).rejects.toThrow(
          /sys_choice entry "\.\.\/sys_script\/foo" is not a valid record name/
        );
      }
      expect(updateRecord).not.toHaveBeenCalled();
    }
  );

  it("leaves other paths alone", async () => {
    const calc = path.join(src, "sys_dictionary", "x_demo_task.u_foo", "calculation.js");
    const { records } = await getAppFileListWithCandidates([calc], { create: false });
    expect(Object.keys(records[0].fields)).toEqual(["calculation"]);
    expect(records[0].fields.calculation.fileContents).toBeUndefined();
  });
});
