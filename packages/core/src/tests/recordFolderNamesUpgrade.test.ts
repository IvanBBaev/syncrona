// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// C6 upgrade path. An existing checkout was written under the old naming: the
// scoped endpoint's display names, unmodified, so "Util" and "util" shared one
// folder on APFS/NTFS (two on a case-sensitive volume). A refresh under the new
// rules must:
//   - keep every non-colliding record's folder exactly where it was;
//   - give the colliding records their own `_<sys_id>` folders;
//   - never leave an old folder behind without saying so;
//   - and let push (getFileContextFromPath) resolve each path to its sys_id.
// Real filesystem, real FileUtils/downloadPipeline; only config, the instance
// client and the manifest-builder enrichment are mocked.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-upgrade-"));
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

// The instance: display names as the scoped endpoint reports them.
const TABLE = "sys_script_include";
const instance: Record<string, string> = {
  b1: "Bar", // never collided
  s1: "Util", // collides with s2 by case only
  s2: "util",
  d1: "Dup_d1", // already disambiguated on disk by an earlier Table-API build
};
const scopedManifest = (): SN.AppManifest => ({
  scope: "x_app",
  tables: {
    [TABLE]: {
      records: Object.fromEntries(
        Object.entries(instance).map(([sysId, name]) => [
          name,
          { name, sys_id: sysId, files: [{ name: "script", type: "js" }] },
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

const { syncManifest } = await import("../downloadPipeline.js");
const { getFileContextFromPath } = await import("../FileUtils.js");

const write = (rel: string, content: string) => {
  const target = path.join(src, TABLE, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const read = (rel: string) => fs.readFileSync(path.join(src, TABLE, rel), "utf8");
const listing = () => fs.readdirSync(path.join(src, TABLE)).sort();
const warnings = () => warn.mock.calls.map((c) => String(c[0]));

// The old checkout's manifest: the scoped answer as it was written before.
const oldManifest = (): SN.AppManifest => {
  const m = scopedManifest();
  return JSON.parse(JSON.stringify(m)) as SN.AppManifest;
};

// Whether this volume folds case, which decides what the old "Util"/"util"
// pair looked like on disk — one shared folder or two separate ones.
const caseInsensitive = (() => {
  const probe = path.join(root, "CaseProbe");
  fs.writeFileSync(probe, "");
  const folded = fs.existsSync(path.join(root, "caseprobe"));
  fs.rmSync(probe);
  return folded;
})();

beforeEach(() => {
  fs.rmSync(src, { recursive: true, force: true });
  warn.mockClear();
  config = {};
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const assertPushResolves = (rel: string, sysId: string) => {
  const ctx = getFileContextFromPath(path.join(src, TABLE, rel));
  expect(ctx).toMatchObject({ sys_id: sysId, tableName: TABLE });
};

describe("refresh over a checkout written with the old folder names", () => {
  it("keeps non-colliding folders and gives colliding records their own (folder layout)", async () => {
    loadedManifest = oldManifest();
    write("Bar/script.js", "local Bar edit");
    write("Dup_d1/script.js", "local Dup edit");
    write("Util/script.js", "local Util edit");
    write("util/script.js", "local util edit"); // the same file on APFS/NTFS

    expect(await syncManifest()).toBe(true);

    // Unchanged: same folder, local content untouched, nothing re-downloaded.
    expect(read("Bar/script.js")).toBe("local Bar edit");
    expect(read("Dup_d1/script.js")).toBe("local Dup edit");
    const records = loadedManifest!.tables[TABLE].records;
    expect(Object.keys(records).sort()).toEqual(["Bar", "Dup_d1", "Util_s1", "util_s2"]);

    if (caseInsensitive) {
      // One shared folder: its content cannot be attributed, so both records are
      // downloaded fresh and the old folder stays, named in a warning.
      expect(read("Util_s1/script.js")).toBe("server s1");
      expect(read("util_s2/script.js")).toBe("server s2");
      const left = listing().filter((d) => !(d in records));
      expect(left).toHaveLength(1);
      expect(warnings().some((w) => w.includes(`Left "${path.join(TABLE, left[0])}" in place`))).toBe(true);
    } else {
      // Two folders: each is moved with its local edits; nothing is left over.
      expect(read("Util_s1/script.js")).toBe("local Util edit");
      expect(read("util_s2/script.js")).toBe("local util edit");
      expect(listing()).toEqual(["Bar", "Dup_d1", "Util_s1", "util_s2"]);
    }
    expect(warnings().filter((w) => w.startsWith("Record name collision"))).toHaveLength(1);
    // Only the two fresh records went to the instance, under their sys_ids.
    const requested = getMissingFilesApi.mock.calls.flatMap((c) => Object.keys(c[0][TABLE] ?? {}));
    expect(requested.every((id) => id === "s1" || id === "s2")).toBe(true);

    assertPushResolves("Bar/script.js", "b1");
    assertPushResolves("Dup_d1/script.js", "d1");
    assertPushResolves("Util_s1/script.js", "s1");
    assertPushResolves("util_s2/script.js", "s2");
    expect(getFileContextFromPath(path.join(src, TABLE, "Util", "script.js"))).toBeUndefined();

    // A second refresh is a no-op: same folders, no new warnings about moves.
    warn.mockClear();
    const before = listing();
    expect(await syncManifest()).toBe(true);
    expect(listing()).toEqual(before);
    expect(warnings().filter((w) => w.startsWith("Renamed") || w.startsWith("Left"))).toEqual([]);
  });

  it("moves a separately stored colliding record's flat files with their local edits", async () => {
    config = { flat: true };
    // Only "Util" was ever written (e.g. the "util" record is new on the
    // instance), so its files belong to s1 alone and are moved.
    const previous = oldManifest();
    delete previous.tables[TABLE].records.util;
    loadedManifest = previous;
    write("Bar~script.js", "local Bar edit");
    write("Util~script.js", "local Util edit");

    expect(await syncManifest()).toBe(true);

    expect(listing()).toEqual(["Bar~script.js", "Dup_d1~script.js", "Util_s1~script.js", "util_s2~script.js"]);
    expect(read("Bar~script.js")).toBe("local Bar edit");
    expect(read("Util_s1~script.js")).toBe("local Util edit");
    expect(read("util_s2~script.js")).toBe("server s2");
    expect(warnings().some((w) => w.startsWith(`Renamed "${path.join(TABLE, "Util")}"`))).toBe(true);
    assertPushResolves("Util_s1~script.js", "s1");
    assertPushResolves("util_s2~script.js", "s2");
    assertPushResolves("Bar~script.js", "b1");
  });
});
