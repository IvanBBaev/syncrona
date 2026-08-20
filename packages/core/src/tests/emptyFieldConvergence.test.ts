// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// A tracked field whose value on the instance is legitimately "" never
// converged. The download wrote it as exactly zero bytes, SNFileExists read
// zero bytes as "placeholder, not downloaded yet", so the next refresh reported
// the field missing and fetched it again — forever — while the command printed
// "Download complete ✅". The zero-byte rule was there for the skeleton phase,
// which manufactured zero-byte files out of manifest entries that carry no
// content; the two artifacts were byte-identical, which is why the probe had to
// guess. The fix removes the ambiguity at the write seam rather than at the
// probe: a request with no `content` key writes nothing at all.

const getManifest = jest.fn();
const getConfig = jest.fn();
const getSourcePath = jest.fn();
const getManifestPath = jest.fn();
const getBuildPath = jest.fn(() => "/tmp/build");
const updateManifest = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getConfig,
  getSourcePath,
  getManifestPath,
  getBuildPath,
  updateManifest,
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
    getLogLevel: jest.fn(() => "warn"),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({}),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  // DX22: the scoped-manifest enrichment is a no-op for these suites — they
  // assert on the manifest they hand in, not on the metadata layer.
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  isScopedEndpointUnavailableError: () => false,
  ManifestRecordNames: jest.fn(),
}));

jest.unstable_mockModule("../downloadCheckpoint.js", () => ({
  DownloadCheckpoint: jest.fn(),
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

let TMP_ROOT: string;
let srcPath: string;

beforeEach(() => {
  jest.clearAllMocks();
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-empty-"));
  srcPath = path.join(TMP_ROOT, "src");
  fs.mkdirSync(srcPath, { recursive: true });
  getSourcePath.mockReturnValue(srcPath);
  getManifestPath.mockReturnValue(path.join(TMP_ROOT, "manifest.json"));
  getConfig.mockReturnValue({ writeConcurrency: 1 });
});

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("writeSNFileCurry distinguishes a manifest entry from an empty value", () => {
  it("creates no file for a manifest entry that carries no content", async () => {
    const { writeSNFileCurry, SNFileExists } = await import("../FileUtils.js");
    const dir = path.join(srcPath, "sys_script_include", "Foo");
    fs.mkdirSync(dir, { recursive: true });

    // Exactly the shape a Table-API-built manifest holds: name and type only.
    await writeSNFileCurry(false)({ name: "script", type: "js" } as SN.File, dir);

    expect(fs.existsSync(path.join(dir, "script.js"))).toBe(false);
    // ...and the field is therefore still reported as needing a download.
    expect(
      await SNFileExists(dir)({ name: "script", type: "js" } as SN.File)
    ).toBe(false);
  });

  it("writes a zero-byte file for a fetched empty value and then reports it present", async () => {
    const { writeSNFileCurry, SNFileExists } = await import("../FileUtils.js");
    const dir = path.join(srcPath, "sys_script_include", "Foo");
    fs.mkdirSync(dir, { recursive: true });

    await writeSNFileCurry(false)(
      { name: "script", type: "js", content: "" } as SN.File,
      dir
    );

    const target = path.join(dir, "script.js");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBe(0);
    // The convergence assertion: a second pass must not call it missing again.
    expect(
      await SNFileExists(dir)({ name: "script", type: "js" } as SN.File)
    ).toBe(true);
  });
});

describe("a legitimately empty field converges across the download seam", () => {
  it("stops reporting the field missing once its empty value has been written", async () => {
    const { processTablesInManifest, findMissingFiles } = await import(
      "../downloadPipeline.js"
    );

    const manifest = {
      scope: "x_demo",
      tables: {
        sys_script_include: {
          records: {
            Foo: {
              name: "Foo",
              sys_id: "sysFoo",
              // Manifest entry: no content, exactly as the builder emits it.
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    } as unknown as SN.AppManifest;

    // Skeleton phase: directories only, no file.
    await processTablesInManifest(manifest.tables, false);
    const recordDir = path.join(srcPath, "sys_script_include", "Foo");
    expect(fs.existsSync(recordDir)).toBe(true);
    expect(fs.existsSync(path.join(recordDir, "script.js"))).toBe(false);

    // The field is missing, so the download fetches it — and the instance's
    // value for it is the empty string.
    const beforeDownload = await findMissingFiles(manifest);
    expect(beforeDownload.sys_script_include.sysFoo).toEqual([
      { name: "script", type: "js" },
    ]);

    await processTablesInManifest(
      {
        sys_script_include: {
          records: {
            Foo: {
              name: "Foo",
              sys_id: "sysFoo",
              files: [{ name: "script", type: "js", content: "" }],
            },
          },
        },
      } as unknown as SN.TableMap,
      true
    );
    expect(fs.statSync(path.join(recordDir, "script.js")).size).toBe(0);

    // Before the fix this still reported the field missing, on this run and
    // every run after it.
    const afterDownload = await findMissingFiles(manifest);
    expect(afterDownload.sys_script_include).toBeUndefined();
  });
});
