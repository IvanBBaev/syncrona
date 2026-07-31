// SPDX-License-Identifier: GPL-3.0-or-later
// REV-140: `repair --apply --prune` must not delete a live, manifest-tracked
// file just because the filesystem hands its name back in a different byte
// sequence than the manifest key (NFD vs NFC on a normalizing volume, a
// Windows-stripped trailing dot/space). The strict `records[recordName]` lookup
// behind getFileContextFromPath misses such a name, and the old orphan filter
// went straight to unlink.
import { jest } from "@jest/globals";

jest.unstable_mockModule("../config.js", () => ({
  getManifest: jest.fn(),
  getSourcePath: jest.fn(),
  getRootDir: jest.fn(),
}));
jest.unstable_mockModule("../appUtils.js", () => ({
  findMissingFiles: jest.fn(),
  processMissingFiles: jest.fn(),
}));
jest.unstable_mockModule("../FileUtils.js", () => ({
  getPathsInPath: jest.fn(),
  getFileContextFromPath: jest.fn(),
}));

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

let ConfigManager: typeof import("../config.js");
let AppUtils: typeof import("../appUtils.js");
let FileUtils: typeof import("../FileUtils.js");
let repairCommand: typeof import("../repairCommand.js").repairCommand;

let getManifest: jest.MockedFunction<typeof ConfigManager.getManifest>;
let getSourcePath: jest.MockedFunction<typeof ConfigManager.getSourcePath>;
let getRootDir: jest.MockedFunction<typeof ConfigManager.getRootDir>;
let findMissingFiles: jest.MockedFunction<typeof AppUtils.findMissingFiles>;
let processMissingFiles: jest.MockedFunction<typeof AppUtils.processMissingFiles>;
let getPathsInPath: jest.MockedFunction<typeof FileUtils.getPathsInPath>;
let getFileContextFromPath: jest.MockedFunction<
  typeof FileUtils.getFileContextFromPath
>;

beforeAll(async () => {
  ConfigManager = await import("../config.js");
  AppUtils = await import("../appUtils.js");
  FileUtils = await import("../FileUtils.js");
  ({ repairCommand } = await import("../repairCommand.js"));

  getManifest = ConfigManager.getManifest as jest.MockedFunction<
    typeof ConfigManager.getManifest
  >;
  getSourcePath = ConfigManager.getSourcePath as jest.MockedFunction<
    typeof ConfigManager.getSourcePath
  >;
  getRootDir = ConfigManager.getRootDir as jest.MockedFunction<
    typeof ConfigManager.getRootDir
  >;
  findMissingFiles = AppUtils.findMissingFiles as jest.MockedFunction<
    typeof AppUtils.findMissingFiles
  >;
  processMissingFiles = AppUtils.processMissingFiles as jest.MockedFunction<
    typeof AppUtils.processMissingFiles
  >;
  getPathsInPath = FileUtils.getPathsInPath as jest.MockedFunction<
    typeof FileUtils.getPathsInPath
  >;
  getFileContextFromPath = FileUtils.getFileContextFromPath as jest.MockedFunction<
    typeof FileUtils.getFileContextFromPath
  >;
});

// "café" with a precomposed é (NFC) — the shape a manifest built from the API
// holds — and the same name decomposed (NFD), the shape a normalizing volume
// hands back from readdir.
const NFC_RECORD = "caf\u00E9Script"; // precomposed e-acute
const NFD_RECORD = "cafe\u0301Script"; // e + combining acute

const manifestWith = (records: Record<string, SN.MetaRecord>): SN.AppManifest =>
  ({
    scope: "x_app",
    tables: { sys_script: { records } },
  }) as unknown as SN.AppManifest;

const recordEntry = (name: string): SN.MetaRecord =>
  ({
    name,
    sys_id: "sysA",
    files: [{ name: "script", type: "js" }],
  }) as unknown as SN.MetaRecord;

describe("REV-140: prune keeps tracked files whose on-disk name is encoded differently", () => {
  let tmp: string;
  let sourceDir: string;

  const pruneArgs = {
    logLevel: "info",
    apply: true,
    prune: true,
    ci: true,
  } as never;

  const seed = (relSegments: string[]): string => {
    const file = path.join(sourceDir, ...relSegments);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "live content");
    getPathsInPath.mockResolvedValue([file]);
    return file;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-rev140-"));
    sourceDir = path.join(tmp, "src");
    mkdirSync(sourceDir, { recursive: true });
    getSourcePath.mockReturnValue(sourceDir);
    getRootDir.mockReturnValue(tmp);
    findMissingFiles.mockResolvedValue({} as SN.MissingFileTableMap);
    processMissingFiles.mockResolvedValue(undefined);
    getPathsInPath.mockResolvedValue([]);
    // The exact-string lookup misses every name below — that is the bug being
    // guarded against, not something the fix may rely on.
    getFileContextFromPath.mockReturnValue(undefined);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("does not delete a folder-layout file whose name differs only by Unicode normalization", async () => {
    getManifest.mockReturnValue(
      manifestWith({ [NFC_RECORD]: recordEntry(NFC_RECORD) }) as never
    );
    const file = seed(["sys_script", NFD_RECORD, "script.js"]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(true);
  });

  test("does not delete a flat-layout file whose name differs only by Unicode normalization", async () => {
    getManifest.mockReturnValue(
      manifestWith({ [NFC_RECORD]: recordEntry(NFC_RECORD) }) as never
    );
    const file = seed(["sys_script", `${NFD_RECORD}~script.js`]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(true);
  });

  test("does not delete a file whose trailing dot the filesystem stripped at creation", async () => {
    getManifest.mockReturnValue(
      manifestWith({ "Nightly Report.": recordEntry("Nightly Report.") }) as never
    );
    const file = seed(["sys_script", "Nightly Report", "script.js"]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(true);
  });

  // A real table holds hundreds of records, and only ONE of them is the
  // differently-encoded match. The encoding check therefore has to be an
  // existence question over the record names ("does any name canonicalize to
  // this?"), not a property of all of them — a table with a single record is the
  // only fixture where those two readings agree.
  test("finds the differently-encoded record among many records of the same table", async () => {
    getManifest.mockReturnValue(
      manifestWith({
        Alpha: recordEntry("Alpha"),
        [NFC_RECORD]: recordEntry(NFC_RECORD),
        Zeta: recordEntry("Zeta"),
      }) as never
    );
    const file = seed(["sys_script", NFD_RECORD, "script.js"]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(true);
  });

  test("still deletes a file no manifest record claims under any encoding", async () => {
    getManifest.mockReturnValue(
      manifestWith({ [NFC_RECORD]: recordEntry(NFC_RECORD) }) as never
    );
    const file = seed(["sys_script", "DeletedRecord", "script.js"]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(false);
  });

  test("still deletes a field file of a byte-exact record the manifest no longer lists", async () => {
    getManifest.mockReturnValue(
      manifestWith({ Keeper: recordEntry("Keeper") }) as never
    );
    const file = seed(["sys_script", "Keeper", "dropped_field.js"]);

    await repairCommand(pruneArgs);

    expect(existsSync(file)).toBe(false);
  });
});
