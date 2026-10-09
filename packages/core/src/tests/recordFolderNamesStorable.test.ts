// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// C7: a record name that no filesystem can store as written — over the 255-byte
// segment limit, or carrying NUL / control characters — is made storable by
// the one naming function: cut on a code point boundary with a hash of the
// whole name, control characters replaced. Every other path segment (table,
// field, type, scope) is refused by isSafePathComponent instead. Proven on a
// real filesystem through refresh (syncManifest) and push (getFileContextFromPath),
// including the upgrade of a checkout that stored an overlong or tab-carrying name.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-storable-"));
const src = path.join(root, "src");
let loadedManifest: SN.AppManifest | undefined;
let config: Record<string, unknown> = {};

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: () => src,
  getManifestPath: () => path.join(root, "syncrona.manifest.json"),
  getBuildPath: () => path.join(root, "build"),
  getConfig: () => config,
  getManifest: () => loadedManifest,
  updateManifest: (m: SN.AppManifest) => {
    loadedManifest = m;
  },
}));

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn,
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
    getLogLevel: jest.fn(() => "warn"),
  },
}));

const TABLE = "sys_ui_message";
let instance: Record<string, string> = {};
const scopedManifest = (): SN.AppManifest => ({
  scope: "x_app",
  tables: {
    [TABLE]: {
      records: Object.fromEntries(
        Object.entries(instance).map(([sysId, name]) => [
          name,
          { name, sys_id: sysId, files: [{ name: "message", type: "txt" }] },
        ])
      ),
    },
  },
});
const getManifestApi = jest.fn(async () => ({ data: { result: scopedManifest() } }));
const getMissingFilesApi = jest.fn(async (missing: SN.MissingFileTableMap) => {
  const tables: SN.TableMap = {};
  for (const [table, records] of Object.entries(missing)) {
    tables[table] = { records: {} };
    for (const [sysId, files] of Object.entries(records)) {
      const name = instance[sysId];
      tables[table].records[name] = {
        name,
        sys_id: sysId,
        files: files.map((f) => ({ ...f, content: `server ${sysId}` })),
      };
    }
  }
  return { data: { result: tables } };
});

jest.unstable_mockModule("../snClient.js", () => ({
  getErrorResponseStatus: jest.fn(),
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  defaultClient: () => ({ getManifest: getManifestApi, getMissingFiles: getMissingFilesApi }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  applyIncludeTypeRulesToManifest: async (m: unknown) => m,
  attachMetaFieldsToManifest: async (m: unknown) => m,
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(async () => ({})),
  isScopedEndpointUnavailableError: () => false,
}));

const { MAX_RECORD_NAME_BYTES, assignRecordFolderNames, isRuleDrivenRename, sanitizeRecordFolderName } =
  await import("../recordFolderNames.js");
const { isSafePathComponent, MAX_PATH_SEGMENT_BYTES } = await import("../genericUtils.js");
const { syncManifest } = await import("../downloadPipeline.js");
const { getFileContextFromPath } = await import("../FileUtils.js");

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
// Re-encoding a string with a split code point would produce U+FFFD.
const isWholeUtf8 = (s: string) => Buffer.from(s, "utf8").toString("utf8") === s && !s.includes("�");

describe("sanitizeRecordFolderName", () => {
  it("returns a storable name unchanged", () => {
    for (const name of ["Util", "Café", "日本語の名前", "a".repeat(MAX_RECORD_NAME_BYTES), "😀 ok"]) {
      expect(sanitizeRecordFolderName(name)).toBe(name);
    }
  });

  it("replaces NUL, C0/C1 controls and DEL, and repairs lone surrogates", () => {
    expect(sanitizeRecordFolderName("a\u0000b")).toBe("a_b");
    expect(sanitizeRecordFolderName("line1\nline2\ttab\r")).toBe("line1_line2_tab_");
    expect(sanitizeRecordFolderName("del\u007f c1\u0085")).toBe("del_ c1_");
    expect(sanitizeRecordFolderName("half \ud83d")).toBe("half �");
  });

  it.each([
    ["2-byte", "é", 2],
    ["3-byte", "語", 3],
    ["4-byte", "😀", 4],
  ])("cuts an overlong %s name on a code point boundary and adds a hash", (_label, unit, size) => {
    const name = `x${unit.repeat(Math.ceil(300 / size))}`;
    const folder = sanitizeRecordFolderName(name);
    expect(bytes(folder)).toBeLessThanOrEqual(MAX_RECORD_NAME_BYTES);
    expect(isWholeUtf8(folder)).toBe(true);
    const match = /^(.*)_([0-9a-f]{8})$/su.exec(folder);
    expect(match).not.toBeNull();
    expect(name.startsWith(match![1])).toBe(true);
    // As much of the name as fits is kept: one more code point would not fit.
    expect(bytes(match![1]) + size).toBeGreaterThan(MAX_RECORD_NAME_BYTES - 9);
    expect(sanitizeRecordFolderName(name)).toBe(folder);
    expect(isSafePathComponent(folder)).toBe(true);
  });

  it("gives long names that share a prefix different folders", () => {
    const prefix = "p".repeat(400);
    const a = sanitizeRecordFolderName(`${prefix}A`);
    const b = sanitizeRecordFolderName(`${prefix}B`);
    expect(a).not.toBe(b);
    expect(a.slice(0, -8)).toBe(b.slice(0, -8));
  });

  it("hashes the whole name, so long names differing only by case do not collide", () => {
    const long = "Ü".repeat(200);
    const names = assignRecordFolderNames("t", [
      { sysId: "a1", name: long },
      { sysId: "b1", name: long.toLowerCase() },
    ]);
    expect(names.get("a1")).toBe(sanitizeRecordFolderName(long));
    expect(names.get("b1")).toBe(sanitizeRecordFolderName(long.toLowerCase()));
  });

  it("keeps the collision suffix after the hash, inside the segment limit", () => {
    const long = "Ü".repeat(200);
    const names = assignRecordFolderNames("t", [
      { sysId: "a".repeat(32), name: long },
      { sysId: "b".repeat(32), name: long },
    ]);
    const folder = names.get("a".repeat(32)) as string;
    expect(folder).toMatch(/_[0-9a-f]{8}_a{32}$/u);
    expect(names.get("b".repeat(32))).toMatch(/_[0-9a-f]{8}_b{32}$/u);
    // The suffix is budgeted inside the record name, not on top of it.
    expect(bytes(folder)).toBeLessThanOrEqual(MAX_RECORD_NAME_BYTES);
    expect(bytes(`${folder}~message.txt`)).toBeLessThanOrEqual(MAX_PATH_SEGMENT_BYTES);
  });

  it("treats the storable form of an old name as a rule-driven rename", () => {
    const old = "x".repeat(220);
    expect(isRuleDrivenRename(old, sanitizeRecordFolderName(old), "s1")).toBe(true);
    expect(isRuleDrivenRename("a\tb", "a_b_s1", "s1")).toBe(true);
    expect(isRuleDrivenRename("a\tb", "a b", "s1")).toBe(false);
  });
});

describe("isSafePathComponent refuses what no filesystem stores as written", () => {
  it.each([
    ["NUL", "sys_\u0000script"],
    ["newline", "script\n"],
    ["DEL", "a\u007f"],
    ["C1 control", "a\u0085"],
    ["lone surrogate", "a\udc00"],
    ["over 255 bytes", "é".repeat(128)],
  ])("refuses a segment with %s", (_label, segment) => {
    expect(isSafePathComponent(segment)).toBe(false);
  });

  it("accepts a 255-byte segment and paired surrogates", () => {
    expect(isSafePathComponent("a".repeat(255))).toBe(true);
    expect(isSafePathComponent("😀".repeat(63))).toBe(true);
  });
});

describe("refresh and push with unstorable record names", () => {
  const tableDir = path.join(src, TABLE);
  const long = `Message ${"長".repeat(100)}`; // 307 bytes
  beforeEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
    warn.mockClear();
    getMissingFilesApi.mockClear();
    config = {};
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    ["folder", false],
    ["flat", true],
  ])("writes fitting names and resolves them back to their records (%s layout)", async (_l, flat) => {
    config = { flat };
    instance = { l1: long, n1: "null\u0000byte", c1: "tab\there", ok: "Plain" };
    loadedManifest = { scope: "x_app", tables: {} };

    expect(await syncManifest()).toBe(true);

    const records = loadedManifest!.tables[TABLE].records;
    const folderOf = (sysId: string) =>
      Object.values(records).find((r) => r.sys_id === sysId)!.name;
    expect(folderOf("n1")).toBe("null_byte");
    expect(folderOf("c1")).toBe("tab_here");
    expect(folderOf("ok")).toBe("Plain");
    expect(folderOf("l1")).toBe(sanitizeRecordFolderName(long));

    for (const sysId of ["l1", "n1", "c1", "ok"]) {
      const rel = flat ? `${folderOf(sysId)}~message.txt` : path.join(folderOf(sysId), "message.txt");
      const file = path.join(tableDir, rel);
      expect(fs.readFileSync(file, "utf8")).toBe(`server ${sysId}`);
      expect(getFileContextFromPath(file)).toMatchObject({ sys_id: sysId, targetField: "message" });
    }
  });

  it("moves an old checkout's overlong and tab-named folders to their storable names", async () => {
    const old = `Old ${"x".repeat(210)}`; // 214 bytes: stored before, over the budget now
    instance = { l1: old, c1: "tab\there", ok: "Plain" };
    loadedManifest = scopedManifest(); // the old manifest named them verbatim
    for (const name of [old, "tab\there", "Plain"]) {
      fs.mkdirSync(path.join(tableDir, name), { recursive: true });
      fs.writeFileSync(path.join(tableDir, name, "message.txt"), `local ${name.slice(0, 5)}`);
    }

    expect(await syncManifest()).toBe(true);

    expect(fs.readdirSync(tableDir).sort()).toEqual(
      ["Plain", "tab_here", sanitizeRecordFolderName(old)].sort()
    );
    expect(fs.readFileSync(path.join(tableDir, "tab_here", "message.txt"), "utf8")).toBe("local tab\th");
    expect(fs.readFileSync(path.join(tableDir, "Plain", "message.txt"), "utf8")).toBe("local Plain");
    // Every record's files were moved with their local edits: nothing to re-download.
    expect(getMissingFilesApi).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("Renamed"))).toHaveLength(2);
    expect(
      getFileContextFromPath(path.join(tableDir, sanitizeRecordFolderName(old), "message.txt"))
    ).toMatchObject({ sys_id: "l1" });
    expect(getFileContextFromPath(path.join(tableDir, old, "message.txt"))).toBeUndefined();
  });
});
