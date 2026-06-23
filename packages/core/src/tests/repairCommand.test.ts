// SPDX-License-Identifier: GPL-3.0-or-later
jest.mock("../config");
jest.mock("../appUtils");
jest.mock("../FileUtils");

import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import os from "os";
import path from "path";
import * as ConfigManager from "../config";
import * as AppUtils from "../appUtils";
import * as FileUtils from "../FileUtils";
import { repairCommand } from "../repairCommand";
import type { SN } from "@syncro-now-ai/types";

const getManifest = ConfigManager.getManifest as jest.MockedFunction<
  typeof ConfigManager.getManifest
>;
const getSourcePath = ConfigManager.getSourcePath as jest.MockedFunction<
  typeof ConfigManager.getSourcePath
>;
const findMissingFiles = AppUtils.findMissingFiles as jest.MockedFunction<
  typeof AppUtils.findMissingFiles
>;
const processMissingFiles = AppUtils.processMissingFiles as jest.MockedFunction<
  typeof AppUtils.processMissingFiles
>;
const getPathsInPath = FileUtils.getPathsInPath as jest.MockedFunction<
  typeof FileUtils.getPathsInPath
>;
const getFileContextFromPath = FileUtils.getFileContextFromPath as jest.MockedFunction<
  typeof FileUtils.getFileContextFromPath
>;

const MANIFEST = { scope: "x_app", tables: {} } as unknown as SN.AppManifest;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  getSourcePath.mockReturnValue("/src");
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
  let orphan: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-"));
    orphan = path.join(tmp, "orphan.js");
    writeFileSync(orphan, "stray");
    getManifest.mockReturnValue(MANIFEST as never);
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
});
