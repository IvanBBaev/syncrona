// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";

// R5: the three bare automocks need factories under ESM. Each lists the named
// exports the test drives directly; graph-complete fills in any other name the
// repairCommand graph hard-links from these relative modules.
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

// R1: the mocks do not hoist, so the mocked namespaces and the SUT are imported
// dynamically after the mocks register.
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

const MANIFEST = { scope: "x_app", tables: {} } as unknown as SN.AppManifest;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  getSourcePath.mockReturnValue("/src");
  getRootDir.mockReturnValue("/");
  getPathsInPath.mockResolvedValue([]);
  getFileContextFromPath.mockReturnValue(undefined);
  findMissingFiles.mockResolvedValue({} as SN.MissingFileTableMap);
  processMissingFiles.mockResolvedValue(undefined);
});

test("errors when there is no manifest", async () => {
  getManifest.mockReturnValue(undefined as never);
  await repairCommand({ logLevel: "info" } as never);
  expect(process.exitCode).toBe(1);
  expect(processMissingFiles).not.toHaveBeenCalled();
});

test("reports a consistent workspace and applies nothing", async () => {
  getManifest.mockReturnValue(MANIFEST as never);
  // no missing, no orphans (defaults)
  await repairCommand({ logLevel: "info" } as never);
  expect(processMissingFiles).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

test("reports missing files but does not re-download in the default (dry-run) mode", async () => {
  getManifest.mockReturnValue(MANIFEST as never);
  findMissingFiles.mockResolvedValue({
    sys_script: { sysA: [{ name: "script", type: "js" }] },
  } as unknown as SN.MissingFileTableMap);
  await repairCommand({ logLevel: "info" } as never);
  expect(processMissingFiles).not.toHaveBeenCalled();
});

test("--apply re-downloads missing files", async () => {
  getManifest.mockReturnValue(MANIFEST as never);
  findMissingFiles.mockResolvedValue({
    sys_script: { sysA: [{ name: "script", type: "js" }] },
  } as unknown as SN.MissingFileTableMap);
  await repairCommand({ logLevel: "info", apply: true } as never);
  expect(processMissingFiles).toHaveBeenCalledTimes(1);
});

test("--dry-run overrides --apply (report only)", async () => {
  getManifest.mockReturnValue(MANIFEST as never);
  findMissingFiles.mockResolvedValue({
    sys_script: { sysA: [{ name: "script", type: "js" }] },
  } as unknown as SN.MissingFileTableMap);
  await repairCommand({ logLevel: "info", apply: true, dryRun: true } as never);
  expect(processMissingFiles).not.toHaveBeenCalled();
});

test("detects orphan files (on disk, not in manifest)", async () => {
  getManifest.mockReturnValue(MANIFEST as never);
  getPathsInPath.mockResolvedValue(["/src/sys_script/X/script.js"]);
  getFileContextFromPath.mockReturnValue(undefined); // not claimed by manifest -> orphan
  await repairCommand({ logLevel: "info" } as never);
  // report-only by default: nothing deleted, nothing downloaded
  expect(processMissingFiles).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

// QA: the --prune path actually deletes files (data-loss risk) — exercise it
// against a real temp file so a regression that prunes the wrong thing (or fails
// to honor the flag) is caught. fsp.unlink is real here (fs is not mocked).
describe("--prune deletion (real fs)", () => {
  let tmp: string;
  let sourceDir: string;
  let orphan: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-"));
    sourceDir = path.join(tmp, "src");
    // The orphan must carry the manifest's own on-disk shape
    // (<table>/<record>/<field>.<ext>) — prune ignores anything else.
    orphan = path.join(sourceDir, "sys_script", "X", "script.js");
    mkdirSync(path.dirname(orphan), { recursive: true });
    writeFileSync(orphan, "stray");
    getManifest.mockReturnValue(MANIFEST as never);
    getSourcePath.mockReturnValue(sourceDir);
    getRootDir.mockReturnValue(tmp);
    findMissingFiles.mockResolvedValue({} as SN.MissingFileTableMap);
    getPathsInPath.mockResolvedValue([orphan]);
    getFileContextFromPath.mockReturnValue(undefined); // orphan
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("--apply --prune --ci deletes the orphan", async () => {
    await repairCommand({ logLevel: "info", apply: true, prune: true, ci: true } as never);
    expect(existsSync(orphan)).toBe(false);
  });

  test("--apply without --prune leaves the orphan in place", async () => {
    await repairCommand({ logLevel: "info", apply: true } as never);
    expect(existsSync(orphan)).toBe(true);
  });

  test("report-only (default) never deletes", async () => {
    await repairCommand({ logLevel: "info" } as never);
    expect(existsSync(orphan)).toBe(true);
  });

  // getFileContextFromPath returns undefined for ANY path the manifest does not
  // claim — including hand-written sources, docs, config and node_modules — so
  // every such file used to be listed as an orphan and DELETED by --prune. Only
  // paths with the manifest's own on-disk shape can be download orphans.
  test("never prunes files that do not have the manifest's on-disk shape", async () => {
    const handwritten = path.join(sourceDir, "helpers", "util.ts");
    const nested = path.join(sourceDir, "sys_script", "X", "deep", "extra", "note.md");
    const dotted = path.join(sourceDir, ".git", "config", "keep.js");
    for (const file of [handwritten, nested, dotted]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "keep me");
    }
    getPathsInPath.mockResolvedValue([handwritten, nested, dotted]);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    for (const file of [handwritten, nested, dotted]) {
      expect(existsSync(file)).toBe(true);
    }
  });

  test("still prunes a flat-layout orphan (<table>/<record>~<field>.<ext>)", async () => {
    const flatOrphan = path.join(sourceDir, "sys_script", "Rec~script.js");
    mkdirSync(path.dirname(flatOrphan), { recursive: true });
    writeFileSync(flatOrphan, "stray");
    getPathsInPath.mockResolvedValue([flatOrphan]);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    expect(existsSync(flatOrphan)).toBe(false);
  });

  // A `sourceDirectory` of "." puts the whole repository inside prune range,
  // where the shape filter alone still matches <dir>/<dir>/<file.ext> paths.
  test("refuses to prune when the source directory is the project root", async () => {
    getSourcePath.mockReturnValue(tmp);
    getRootDir.mockReturnValue(tmp);
    const rootOrphan = path.join(tmp, "sys_script", "X", "script.js");
    mkdirSync(path.dirname(rootOrphan), { recursive: true });
    writeFileSync(rootOrphan, "stray");
    getPathsInPath.mockResolvedValue([rootOrphan]);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    expect(existsSync(rootOrphan)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  // Deletions are irreversible: a swallowed unlink error used to report
  // "Pruned N orphan file(s)" while nothing was actually removed, so a repair
  // that changed nothing looked like a success and exited 0.
  test("reports a failed deletion instead of claiming success", async () => {
    const { logger } = await import("../Logger.js");
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
    const missingOrphan = path.join(sourceDir, "sys_script", "Gone", "script.js");
    getPathsInPath.mockResolvedValue([missingOrphan]); // never created on disk

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    expect(process.exitCode).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Pruned 0 orphan file(s)"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete 1 orphan file(s)")
    );
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
