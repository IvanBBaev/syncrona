// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2: the composite data-model document itself — layout config, the strict
// parser, the deterministic serializer, the merge a download performs, and the
// read-only layout inspection `repair` and `status` report from. Real temp
// directories; nothing here talks to an instance.
import { promises as fsp, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { SN } from "@syncrona/types";
import {
  COMPOSITE_FORMAT,
  COMPOSITE_TABLES,
  DATA_MODEL_LAYOUTS,
  assertNoCompositeEntries,
  assertNoPerRecordSidecars,
  compositeDocumentPath,
  compositeGroupFor,
  compositeTier,
  emptyCompositeDocument,
  getCompositeTables,
  getDataModelLayout,
  inspectCompositeLayout,
  isCompositeDocumentPath,
  isValidDataModelLayout,
  listCompositeDocuments,
  loadCompositeIndex,
  mergeCompositeWrites,
  parseCompositeDocument,
  perRecordSidecarPath,
  serializeCompositeDocument,
  serializeCompositeEntry,
} from "../dataModelComposite.js";
import { serializeMetaFields } from "../metaFields.js";

const ALL = ["sys_db_object", "sys_dictionary", "sys_choice"];

let root: string;
let src: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "sdk-f2-"));
  src = path.join(root, "src");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sidecar = (columns: Record<string, string>) =>
  `${JSON.stringify(
    Object.fromEntries(Object.keys(columns).sort().map((k) => [k, columns[k]])),
    null,
    2
  )}\n`;

const TABLE_ENTRY = { label: "Task", name: "x_demo_task", super_class: "task" };
const COLUMN_ENTRY = { column_label: "Foo", element: "u_foo", internal_type: "choice", name: "x_demo_task" };
const CHOICE_ENTRY = { element: "u_foo", label: "One", name: "x_demo_task", value: "1" };

const writes = () => [
  { table: "sys_choice", recordName: "x_demo_task.u_foo.1", content: sidecar(CHOICE_ENTRY) },
  { table: "sys_dictionary", recordName: "x_demo_task.u_foo", content: sidecar(COLUMN_ENTRY) },
  { table: "sys_db_object", recordName: "x_demo_task", content: sidecar(TABLE_ENTRY) },
];

const writeDoc = async (group: string, body: unknown) => {
  const docPath = compositeDocumentPath(src, group);
  await fsp.mkdir(path.dirname(docPath), { recursive: true });
  await fsp.writeFile(docPath, typeof body === "string" ? body : JSON.stringify(body));
  return docPath;
};

describe("dataModelLayout config", () => {
  it("accepts exactly the two layouts, records first", () => {
    expect(DATA_MODEL_LAYOUTS).toEqual(["records", "composite"]);
    expect(isValidDataModelLayout("records")).toBe(true);
    expect(isValidDataModelLayout("composite")).toBe(true);
    expect(isValidDataModelLayout("Composite")).toBe(false);
    expect(isValidDataModelLayout(1)).toBe(false);
  });

  it("is records unless the config says exactly composite", () => {
    expect(getDataModelLayout(undefined)).toBe("records");
    expect(getDataModelLayout({})).toBe("records");
    expect(getDataModelLayout({ dataModelLayout: "composite" })).toBe("composite");
    expect(getDataModelLayout({ dataModelLayout: "bogus" as never })).toBe("records");
  });

  it("covers only the opted-in composite tables, and none in the records layout", () => {
    expect(getCompositeTables({ dataModelTables: ALL })).toEqual([]);
    expect(
      getCompositeTables({ dataModelLayout: "composite", dataModelTables: ["sys_choice", "sys_db_object"] })
    ).toEqual(["sys_db_object", "sys_choice"]);
    expect(
      getCompositeTables({ dataModelLayout: "composite", dataModelTables: ["sys_ui_policy"] })
    ).toEqual([]);
  });

  it("orders table, then column, then choice, then everything else", () => {
    expect(COMPOSITE_TABLES.map(compositeTier)).toEqual([0, 1, 2]);
    expect(compositeTier("sys_script_include")).toBe(3);
  });
});

describe("paths", () => {
  it("recognises only <src>/data-model/<name>.json", () => {
    expect(isCompositeDocumentPath(path.join(src, "data-model", "x_demo_task.json"), src)).toBe(true);
    expect(isCompositeDocumentPath(path.join(src, "data-model", ".json"), src)).toBe(false);
    expect(isCompositeDocumentPath(path.join(src, "data-model", "a", "b.json"), src)).toBe(false);
    expect(isCompositeDocumentPath(path.join(src, "data-model", "x.txt"), src)).toBe(false);
    expect(isCompositeDocumentPath(path.join(src, "sys_dictionary", "x.json"), src)).toBe(false);
    expect(isCompositeDocumentPath(path.join(root, "data-model", "x.json"), src)).toBe(false);
    expect(isCompositeDocumentPath(src, src)).toBe(false);
  });

  it("names the per-record sidecar of either layout", () => {
    expect(perRecordSidecarPath(src, "sys_choice", "a.b.c", false)).toBe(
      path.join(src, "sys_choice", "a.b.c", ".meta.json")
    );
    expect(perRecordSidecarPath(src, "sys_choice", "a.b.c", true)).toBe(
      path.join(src, "sys_choice", "a.b.c~.meta.json")
    );
  });

  it("groups a record by its name column, then by its record name", () => {
    expect(compositeGroupFor("whatever", { name: "x_demo_task" })).toBe("x_demo_task");
    expect(compositeGroupFor("x_demo_task.u_foo", {})).toBe("x_demo_task");
    expect(compositeGroupFor("Bad Name", { name: "Also Bad" })).toBeUndefined();
  });
});

describe("parseCompositeDocument", () => {
  const P = "/w/src/data-model/x_demo_task.json";
  const valid = {
    format: COMPOSITE_FORMAT,
    table: "x_demo_task",
    sys_db_object: { x_demo_task: TABLE_ENTRY },
  };

  it("parses a valid document, BOM and all", () => {
    // A leading U+FEFF byte-order mark, as some editors save it.
    const doc = parseCompositeDocument(`\ufeff${JSON.stringify(valid)}`, P);
    expect(doc.table).toBe("x_demo_task");
    expect({ ...doc.sections.sys_db_object.x_demo_task }).toEqual(TABLE_ENTRY);
  });

  it.each([
    ["{", /is not valid JSON/],
    ["[]", /must be a JSON object/],
    [JSON.stringify({ ...valid, format: "other/1" }), /"format" must be/],
    [JSON.stringify({ ...valid, table: "other" }), /must have "table": "x_demo_task"/],
    [JSON.stringify({ ...valid, extra: 1 }), /unknown key\(s\) extra/],
    [JSON.stringify({ ...valid, sys_choice: [] }), /section "sys_choice" must be an object/],
    [JSON.stringify({ ...valid, sys_choice: { a: "b" } }), /sys_choice entry "a" must be a JSON object/],
  ])("refuses %s", (text, message) => {
    expect(() => parseCompositeDocument(text, P)).toThrow(message);
    expect(() => parseCompositeDocument(text, P)).toThrow(P);
  });

  it.each([
    ["../sys_script/foo", /is not a valid record name: it contains a path separator/],
    ["a/b", /it contains a path separator/],
    ["a\\b", /it contains a path separator/],
    ["..", /it is a relative directory name/],
    [".", /it is a relative directory name/],
    ["", /it is empty/],
    ["a\u0000b", /it contains a NUL character/],
  ])("refuses the record-name key %j, naming the file", (key, message) => {
    const text = JSON.stringify({ ...valid, sys_choice: { [key]: { a: "1" } } });
    expect(() => parseCompositeDocument(text, P)).toThrow(message);
    expect(() => parseCompositeDocument(text, P)).toThrow(P);
  });

  it("accepts dotted record names and names that merely contain two dots", () => {
    const text = JSON.stringify({ ...valid, sys_choice: { "x.u_foo.1": {}, "a..b": {} } });
    expect(Object.keys(parseCompositeDocument(text, P).sections.sys_choice).sort()).toEqual([
      "a..b",
      "x.u_foo.1",
    ]);
  });

  it("keeps a record named __proto__ as an own key", () => {
    const doc = parseCompositeDocument(
      `{"format":"${COMPOSITE_FORMAT}","table":"x_demo_task","sys_choice":{"__proto__":{"a":"1"}}}`,
      P
    );
    expect(Object.keys(doc.sections.sys_choice)).toEqual(["__proto__"]);
  });
});

describe("serializeCompositeDocument", () => {
  it("is a function of the records only: fixed key order, sorted entries and columns", () => {
    const a = emptyCompositeDocument("t");
    a.sections.sys_choice = { "t.b.2": { value: "2", label: "Two" }, "t.b.1": { value: "1" } };
    a.sections.sys_db_object = { t: { super_class: "", label: "T" } };
    a.sections.sys_dictionary = {};
    const b = emptyCompositeDocument("t");
    b.sections.sys_db_object = { t: { label: "T", super_class: "" } };
    b.sections.sys_choice = { "t.b.1": { value: "1" }, "t.b.2": { label: "Two", value: "2" } };
    const text = serializeCompositeDocument(a);
    expect(serializeCompositeDocument(b)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["format", "table", "sys_db_object", "sys_choice"]);
    expect(Object.keys(JSON.parse(text).sys_choice)).toEqual(["t.b.1", "t.b.2"]);
    expect(Object.keys(JSON.parse(text).sys_choice["t.b.2"])).toEqual(["label", "value"]);
  });

  it("round-trips byte for byte through the parser", () => {
    const doc = emptyCompositeDocument("x_demo_task");
    doc.sections.sys_dictionary = { "x_demo_task.u_foo": COLUMN_ENTRY };
    const text = serializeCompositeDocument(doc);
    const docPath = compositeDocumentPath(src, "x_demo_task");
    expect(serializeCompositeDocument(parseCompositeDocument(text, docPath))).toBe(text);
  });

  it("expands an entry to exactly the sidecar a records-layout download writes", () => {
    const columns = { name: "x_demo_task", element: "u_foo", column_label: "Foo" };
    expect(serializeCompositeEntry(columns)).toBe(sidecar(columns));
    const fromMeta = serializeMetaFields(
      { sys_id: "d1", ...columns },
      ["name", "element", "column_label"]
    );
    expect(serializeCompositeEntry(JSON.parse(fromMeta))).toBe(fromMeta);
  });
});

describe("mergeCompositeWrites", () => {
  it("writes one document per table holding the table, its columns and their choices", async () => {
    const written = await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const docPath = compositeDocumentPath(src, "x_demo_task");
    expect(written).toEqual([docPath]);
    const doc = JSON.parse(await fsp.readFile(docPath, "utf8"));
    expect(doc).toEqual({
      format: COMPOSITE_FORMAT,
      table: "x_demo_task",
      sys_db_object: { x_demo_task: TABLE_ENTRY },
      sys_dictionary: { "x_demo_task.u_foo": COLUMN_ENTRY },
      sys_choice: { "x_demo_task.u_foo.1": CHOICE_ENTRY },
    });
    expect(await fsp.readdir(path.dirname(docPath))).toEqual(["x_demo_task.json"]);
  });

  it("does not rewrite an unchanged document, and writes the same bytes in any order", async () => {
    await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const docPath = compositeDocumentPath(src, "x_demo_task");
    const before = await fsp.readFile(docPath, "utf8");
    const stamp = new Date("2020-01-01T00:00:00Z");
    await fsp.utimes(docPath, stamp, stamp);
    const again = await mergeCompositeWrites(src, writes().reverse(), { force: true, flat: false });
    expect(again).toEqual([]);
    expect(await fsp.readFile(docPath, "utf8")).toBe(before);
    expect((await fsp.stat(docPath)).mtime.getTime()).toBe(stamp.getTime());
  });

  it("without force keeps a local edit and only adds what the document lacks", async () => {
    await mergeCompositeWrites(src, writes().slice(1), { force: true, flat: false });
    const docPath = compositeDocumentPath(src, "x_demo_task");
    const doc = JSON.parse(await fsp.readFile(docPath, "utf8"));
    doc.sys_dictionary["x_demo_task.u_foo"].column_label = "Edited";
    await fsp.writeFile(docPath, JSON.stringify(doc));
    await mergeCompositeWrites(src, writes(), { force: false, flat: false });
    const merged = JSON.parse(await fsp.readFile(docPath, "utf8"));
    expect(merged.sys_dictionary["x_demo_task.u_foo"].column_label).toBe("Edited");
    expect(merged.sys_choice["x_demo_task.u_foo.1"]).toEqual(CHOICE_ENTRY);
    // force (download) puts the instance's value back
    await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const forced = JSON.parse(await fsp.readFile(docPath, "utf8"));
    expect(forced.sys_dictionary["x_demo_task.u_foo"].column_label).toBe("Foo");
  });

  it("keeps a record in the document that already holds it", async () => {
    const docPath = await writeDoc("legacy", {
      format: COMPOSITE_FORMAT,
      table: "legacy",
      sys_dictionary: { "x_demo_task.u_foo": { element: "u_foo" } },
    });
    await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const legacy = JSON.parse(await fsp.readFile(docPath, "utf8"));
    expect(legacy.sys_dictionary["x_demo_task.u_foo"]).toEqual(COLUMN_ENTRY);
    const main = JSON.parse(await fsp.readFile(compositeDocumentPath(src, "x_demo_task"), "utf8"));
    expect(main.sys_dictionary).toBeUndefined();
  });

  it("does not rewrite a hand-formatted document whose entries are unchanged", async () => {
    await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const docPath = compositeDocumentPath(src, "x_demo_task");
    const canonical = await fsp.readFile(docPath, "utf8");
    // Same records, different bytes: CRLF line ends and no indentation.
    const handFormatted = `${JSON.stringify(JSON.parse(canonical))}\r\n`;
    await fsp.writeFile(docPath, handFormatted);
    for (const force of [true, false]) {
      expect(await mergeCompositeWrites(src, writes(), { force, flat: false })).toEqual([]);
      expect(await fsp.readFile(docPath, "utf8")).toBe(handFormatted);
    }
    // A real change still rewrites it, canonically.
    const changed = writes().map((w) =>
      w.table === "sys_choice" ? { ...w, content: sidecar({ ...CHOICE_ENTRY, label: "Uno" }) } : w
    );
    expect(await mergeCompositeWrites(src, changed, { force: true, flat: false })).toEqual([docPath]);
    expect(JSON.parse(await fsp.readFile(docPath, "utf8")).sys_choice["x_demo_task.u_foo.1"].label).toBe("Uno");
  });

  it("refuses a downloaded record name that is not one path segment", async () => {
    await expect(
      mergeCompositeWrites(
        src,
        [{ table: "sys_choice", recordName: "../sys_script/foo", content: sidecar(CHOICE_ENTRY) }],
        { force: true, flat: false }
      )
    ).rejects.toThrow(/cannot be placed in a data-model document: it contains a path separator/);
    expect(await listCompositeDocuments(src)).toEqual([]);
  });

  it("is a no-op for an empty batch", async () => {
    expect(await mergeCompositeWrites(src, [], { force: true, flat: false })).toEqual([]);
    expect(await listCompositeDocuments(src)).toEqual([]);
  });

  it.each([false, true])("refuses a record that still has a per-record sidecar (flat=%s)", async (flat) => {
    const stale = perRecordSidecarPath(src, "sys_dictionary", "x_demo_task.u_foo", flat);
    await fsp.mkdir(path.dirname(stale), { recursive: true });
    await fsp.writeFile(stale, "{}\n");
    await expect(mergeCompositeWrites(src, writes(), { force: true, flat })).rejects.toThrow(
      /still have a per-record sidecar[\s\S]*Keep one layout per record/
    );
    expect(await listCompositeDocuments(src)).toEqual([]);
    await expect(
      assertNoPerRecordSidecars(src, [{ table: "sys_choice", recordName: "x" }], flat)
    ).resolves.toBeUndefined();
  });

  it("refuses downloaded metadata that is not a JSON object, or names no table", async () => {
    await expect(
      mergeCompositeWrites(src, [{ table: "sys_choice", recordName: "a", content: "{" }], {
        force: true,
        flat: false,
      })
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      mergeCompositeWrites(src, [{ table: "sys_choice", recordName: "a", content: "[]" }], {
        force: true,
        flat: false,
      })
    ).rejects.toThrow(/not a JSON object/);
    await expect(
      mergeCompositeWrites(src, [{ table: "sys_choice", recordName: "Bad Name", content: "{}" }], {
        force: true,
        flat: false,
      })
    ).rejects.toThrow(/names no table/);
  });

  it("refuses to merge into a malformed document", async () => {
    await writeDoc("x_demo_task", "{ not json");
    await expect(mergeCompositeWrites(src, writes(), { force: true, flat: false })).rejects.toThrow(
      /x_demo_task\.json is not valid JSON/
    );
  });
});

describe("loadCompositeIndex / assertNoCompositeEntries", () => {
  it("refuses a record held by two documents", async () => {
    await writeDoc("a", { format: COMPOSITE_FORMAT, table: "a", sys_choice: { r: {} } });
    await writeDoc("b", { format: COMPOSITE_FORMAT, table: "b", sys_choice: { r: {} } });
    await expect(loadCompositeIndex(src)).rejects.toThrow(/held by two data-model documents/);
  });

  it("ignores non-JSON files and directories in data-model/", async () => {
    await writeDoc("a", { format: COMPOSITE_FORMAT, table: "a" });
    await fsp.writeFile(path.join(src, "data-model", "README.md"), "x");
    await fsp.mkdir(path.join(src, "data-model", "dir.json"));
    expect(await listCompositeDocuments(src)).toEqual([compositeDocumentPath(src, "a")]);
  });

  it("refuses a records-layout sidecar for a record a document holds", async () => {
    await expect(assertNoCompositeEntries(src, [])).resolves.toBeUndefined();
    await expect(
      assertNoCompositeEntries(src, [{ table: "sys_choice", recordName: "r" }])
    ).resolves.toBeUndefined();
    await writeDoc("a", { format: COMPOSITE_FORMAT, table: "a", sys_choice: { r: {} } });
    await expect(
      assertNoCompositeEntries(src, [{ table: "sys_choice", recordName: "other" }])
    ).resolves.toBeUndefined();
    await expect(
      assertNoCompositeEntries(src, [{ table: "sys_choice", recordName: "r" }])
    ).rejects.toThrow(/dataModelLayout is "records"[\s\S]*sys_choice "r"/);
  });
});

describe("inspectCompositeLayout", () => {
  const manifest = (records: Record<string, string[]>): SN.AppManifest =>
    ({
      scope: "x_demo",
      tables: Object.fromEntries(
        Object.entries(records).map(([table, names]) => [
          table,
          {
            records: Object.fromEntries(
              names.map((name, i) => [
                name,
                { name, sys_id: `${table}-${i}`, files: [{ name: ".meta", type: "json" }] },
              ])
            ),
          },
        ])
      ),
    }) as unknown as SN.AppManifest;
  const composite = { dataModelLayout: "composite" as const, dataModelTables: ALL };

  it("is clean for a records workspace without documents", async () => {
    const report = await inspectCompositeLayout(undefined, {}, src);
    expect(report).toEqual({ layout: "records", documents: [], conflicts: [], untracked: [] });
  });

  it("reports documents under the records layout", async () => {
    await writeDoc("a", { format: COMPOSITE_FORMAT, table: "a" });
    const report = await inspectCompositeLayout(undefined, { dataModelTables: ALL }, src);
    expect(report.conflicts).toEqual([expect.stringContaining('dataModelLayout is "records"')]);
  });

  it("reports both layouts, a stray sidecar, a foreign section and untracked entries", async () => {
    await mergeCompositeWrites(src, writes(), { force: true, flat: false });
    const both = perRecordSidecarPath(src, "sys_dictionary", "x_demo_task.u_foo", false);
    const stray = perRecordSidecarPath(src, "sys_dictionary", "x_demo_task.u_bar", false);
    for (const p of [both, stray]) {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, "{}\n");
    }
    const report = await inspectCompositeLayout(
      manifest({
        sys_dictionary: ["x_demo_task.u_foo", "x_demo_task.u_bar"],
        sys_db_object: ["x_demo_task"],
      }),
      { ...composite, dataModelTables: ["sys_dictionary", "sys_db_object"] },
      src
    );
    expect(report.layout).toBe("composite");
    expect(report.documents).toEqual([compositeDocumentPath(src, "x_demo_task")]);
    expect(report.conflicts).toEqual([
      expect.stringContaining('"x_demo_task.u_foo" is in both layouts'),
      expect.stringContaining('"x_demo_task.u_bar" has a per-record sidecar'),
      expect.stringContaining("holds a sys_choice section, but sys_choice is not in dataModelTables"),
    ]);
    expect(report.untracked).toEqual([]);
  });

  it("lists entries no manifest record claims, and reports a malformed document", async () => {
    await mergeCompositeWrites(src, writes(), { force: true, flat: true });
    const report = await inspectCompositeLayout(manifest({ sys_db_object: ["x_demo_task"] }), composite, src);
    expect(report.conflicts).toEqual([]);
    expect(report.untracked).toEqual([
      expect.stringContaining('sys_dictionary "x_demo_task.u_foo"'),
      expect.stringContaining('sys_choice "x_demo_task.u_foo.1"'),
    ]);
    await writeDoc("broken", "[]");
    const broken = await inspectCompositeLayout(undefined, composite, src);
    expect(broken.conflicts).toEqual([expect.stringContaining("broken.json must be a JSON object")]);
  });
});
