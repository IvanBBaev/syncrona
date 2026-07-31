// SPDX-License-Identifier: GPL-3.0-or-later
// `repair --apply --prune` is the only command in the CLI that deletes a user's
// files, and every other prune test runs it with `--ci`, which skips the
// confirmation outright. This file drives the interactive path: the shape of the
// question, the fact that "no" really means nothing is touched, and that --ci is
// the only way to bypass it.
import { jest } from "@jest/globals";

const mockPrompt = jest.fn();

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
jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

let ConfigManager: typeof import("../config.js");
let AppUtils: typeof import("../appUtils.js");
let FileUtils: typeof import("../FileUtils.js");
let logger: typeof import("../Logger.js").logger;
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
let infoSpy: jest.SpiedFunction<typeof logger.info>;

beforeAll(async () => {
  ConfigManager = await import("../config.js");
  AppUtils = await import("../appUtils.js");
  FileUtils = await import("../FileUtils.js");
  ({ logger } = await import("../Logger.js"));
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

describe("repair --prune confirmation", () => {
  let tmp: string;
  let sourceDir: string;
  let orphans: string[];

  const seed = (count: number): string[] => {
    const files: string[] = [];
    for (let i = 0; i < count; i++) {
      const file = path.join(sourceDir, "sys_script", `Rec${i}`, "script.js");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "stray");
      files.push(file);
    }
    getPathsInPath.mockResolvedValue(files);
    return files;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-confirm-"));
    sourceDir = path.join(tmp, "src");
    mkdirSync(sourceDir, { recursive: true });
    getManifest.mockReturnValue(MANIFEST as never);
    getSourcePath.mockReturnValue(sourceDir);
    getRootDir.mockReturnValue(tmp);
    findMissingFiles.mockResolvedValue({} as SN.MissingFileTableMap);
    processMissingFiles.mockResolvedValue(undefined);
    getFileContextFromPath.mockReturnValue(undefined); // every seeded file is an orphan
    orphans = seed(1);
    infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps every orphan when the confirmation is declined", async () => {
    mockPrompt.mockResolvedValue({ confirmed: false } as never);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
    } as never);

    expect(existsSync(orphans[0])).toBe(true);
    // Declining is a normal outcome, not a failure: the command must say what it
    // did (nothing) and still exit 0.
    expect(infoSpy).toHaveBeenCalledWith("Skipped pruning orphans.");
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes the orphans when the confirmation is accepted", async () => {
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
    } as never);

    expect(existsSync(orphans[0])).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
  });

  // The prompt itself is the safety mechanism: it has to state how many files
  // are about to go and that the deletion is final, and it must default to NO —
  // a bare Enter on a `confirm` that defaults to yes deletes the files.
  it("asks a no-by-default confirm that states the number of files at stake", async () => {
    orphans = seed(3);
    mockPrompt.mockResolvedValue({ confirmed: false } as never);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
    } as never);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledWith([
      {
        type: "confirm",
        name: "confirmed",
        message: "Delete 3 orphan file(s)? This cannot be undone.",
        default: false,
      },
    ]);
  });

  it("never prompts under --ci", async () => {
    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    // Automation has no stdin to answer with: a prompt there would hang the job.
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(existsSync(orphans[0])).toBe(false);
  });
});
