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

// `repair` is a report-first command: what it PRINTS is its product (which
// records to look at, which flag to pass next), so several invariants below can
// only be asserted through the logger.
let infoSpy: jest.SpiedFunction<typeof logger.info>;
let successSpy: jest.SpiedFunction<typeof logger.success>;
let errorSpy: jest.SpiedFunction<typeof logger.error>;

const captureLogs = () => {
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  successSpy = jest.spyOn(logger, "success").mockImplementation(() => {});
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
};
const releaseLogs = () => {
  infoSpy.mockRestore();
  successSpy.mockRestore();
  errorSpy.mockRestore();
};
const messages = (spy: jest.SpiedFunction<typeof logger.info>): string[] =>
  spy.mock.calls.map((call) => String(call[0]));
const messageWith = (
  spy: jest.SpiedFunction<typeof logger.info>,
  needle: string
): string | undefined => messages(spy).find((m) => m.includes(needle));

const missingOneRecord = (): SN.MissingFileTableMap =>
  ({
    sys_script: { sysA: [{ name: "script", type: "js" }] },
  }) as unknown as SN.MissingFileTableMap;

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

// The report IS the deliverable of a report-only command: the user picks their
// next flag from it and pastes the listed paths into an editor. These assertions
// therefore cover what the command says, not only what it refrains from doing.
describe("report output", () => {
  beforeEach(() => {
    getManifest.mockReturnValue(MANIFEST as never);
    captureLogs();
  });
  afterEach(releaseLogs);

  it("names the scope and both counts in the report line", async () => {
    findMissingFiles.mockResolvedValue({
      sys_script: {
        sysA: [{ name: "script", type: "js" }],
        sysB: [{ name: "script", type: "js" }],
      },
    } as unknown as SN.MissingFileTableMap);
    getPathsInPath.mockResolvedValue(["/src/sys_script/X/script.js"]);

    await repairCommand({ logLevel: "info" } as never);

    const report = messageWith(infoSpy, "Repair report");
    expect(report).toContain('"x_app"');
    expect(report).toContain("2 missing file(s)");
    expect(report).toContain("1 orphan file(s)");
  });

  it("lists every orphan on its own line", async () => {
    getPathsInPath.mockResolvedValue([
      "/src/sys_script/X/script.js",
      "/src/sys_ui_action/Y/script.js",
    ]);

    await repairCommand({ logLevel: "info" } as never);

    // One indented path per line so the block can be read (and copied) as a
    // list rather than a run-together string.
    expect(messageWith(infoSpy, "Orphans")?.split("\n").slice(1)).toEqual([
      "  /src/sys_script/X/script.js",
      "  /src/sys_ui_action/Y/script.js",
    ]);
    // Orphans alone still mean the workspace is NOT consistent.
    expect(successSpy).not.toHaveBeenCalled();
  });

  // DX22: `<record>~.meta.json` is a perfectly ordinary file name in the flat
  // layout, and the push-side lookup deliberately disowns the sidecar — which is
  // precisely the signature of an orphan. Without the sidecar filter,
  // `repair --apply --prune` would delete a tracked file on every run.
  it("does not report a metadata sidecar as an orphan", async () => {
    getPathsInPath.mockResolvedValue([
      "/src/sys_script_include/MyUtil/.meta.json",
      "/src/sys_script_include/MyUtil~.meta.json",
    ]);
    getFileContextFromPath.mockReturnValue(undefined);

    await repairCommand({ logLevel: "info" } as never);

    expect(messageWith(infoSpy, "Repair report")).toContain("0 orphan file(s)");
    expect(messageWith(infoSpy, "Orphans")).toBeUndefined();
  });

  it("tables each missing record with the number of files it is short of", async () => {
    findMissingFiles.mockResolvedValue({
      sys_script: { sysA: [{ name: "script", type: "js" }] },
      sys_ui_action: {
        sysB: [
          { name: "script", type: "js" },
          { name: "condition", type: "js" },
        ],
      },
    } as unknown as SN.MissingFileTableMap);

    await repairCommand({ logLevel: "info" } as never);

    const rows = messageWith(infoSpy, "Missing (")?.split("\n").slice(-2);
    // Table, sys_id and the per-record file count — the three things needed to
    // find the record in the instance.
    expect(rows?.[0]).toContain("sys_script");
    expect(rows?.[0]).toContain("sysA");
    expect(rows?.[0]?.trimEnd().endsWith("1")).toBe(true);
    expect(rows?.[1]).toContain("sys_ui_action");
    expect(rows?.[1]).toContain("sysB");
    expect(rows?.[1]?.trimEnd().endsWith("2")).toBe(true);
  });

  it("says nothing about missing files or orphans when the workspace is consistent", async () => {
    await repairCommand({ logLevel: "info" } as never);

    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to repair"));
    // An empty "Missing"/"Orphans" heading (or a hint to pass --apply) over a
    // clean workspace is noise that makes the real reports harder to spot.
    expect(messageWith(infoSpy, "Missing (")).toBeUndefined();
    expect(messageWith(infoSpy, "Orphans")).toBeUndefined();
    expect(messageWith(infoSpy, "Report only")).toBeUndefined();
  });

  // The hint has to match what was actually found: offering `--prune` when
  // nothing is orphaned invites a destructive flag for no reason, and offering
  // nothing at all leaves a report-only command with no way forward.
  it("hints only at --apply when nothing is orphaned", async () => {
    findMissingFiles.mockResolvedValue(missingOneRecord());

    await repairCommand({ logLevel: "info" } as never);

    expect(messageWith(infoSpy, "Report only")).toBe(
      "Report only (default). `--apply` re-downloads missing files."
    );
  });

  it("hints only at --apply --prune when nothing is missing", async () => {
    getPathsInPath.mockResolvedValue(["/src/sys_script/X/script.js"]);

    await repairCommand({ logLevel: "info" } as never);

    expect(messageWith(infoSpy, "Report only")).toBe(
      "Report only (default). `--apply --prune` also deletes orphans."
    );
  });

  it("hints at both flags when both problems are present", async () => {
    findMissingFiles.mockResolvedValue(missingOneRecord());
    getPathsInPath.mockResolvedValue(["/src/sys_script/X/script.js"]);

    await repairCommand({ logLevel: "info" } as never);

    expect(messageWith(infoSpy, "Report only")).toBe(
      "Report only (default). `--apply` re-downloads missing files; `--apply --prune` also deletes orphans."
    );
  });

  // An `--apply` run whose only finding is orphans has nothing to download: a
  // round trip to the instance there is pure latency, and "Re-downloading
  // missing files..." over zero files is a false statement.
  it("--apply skips the re-download when nothing is missing and reports the orphans it left", async () => {
    getPathsInPath.mockResolvedValue(["/src/sys_script/X/script.js"]);

    await repairCommand({ logLevel: "info", apply: true } as never);

    expect(processMissingFiles).not.toHaveBeenCalled();
    expect(messageWith(infoSpy, "Re-downloading")).toBeUndefined();
    // Without --prune the orphans survive, and the report must say so — the
    // user has just been shown a list of files that still exist.
    expect(messageWith(infoSpy, "Left orphans in place")).toContain("`--prune`");
    expect(process.exitCode).toBeUndefined();
  });

  it("--apply reports completion when every missing file came back", async () => {
    findMissingFiles.mockResolvedValue(missingOneRecord());
    processMissingFiles.mockResolvedValue(undefined);

    await repairCommand({ logLevel: "info", apply: true } as never);

    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Repair complete"));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  // A re-download that could not fetch every field leaves those files exactly
  // as they were, so the next `repair` finds the same records missing.
  // Reporting "complete ✅" over that made the loop invisible.
  it("--apply names every table that could not be fully fetched and fails", async () => {
    findMissingFiles.mockResolvedValue(missingOneRecord());
    processMissingFiles.mockResolvedValue(["sys_script", "sys_ui_action"] as never);

    await repairCommand({ logLevel: "info", apply: true } as never);

    const failure = messageWith(errorSpy, "Repair incomplete");
    expect(failure).toContain("2 table(s)");
    expect(failure).toContain("sys_script, sys_ui_action");
    expect(successSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // An unexpected failure (network, permissions, a broken manifest) must come
  // out as a diagnostic line plus exit 1 — not as an unhandled rejection with a
  // stack trace and no hint.
  it("reports an unexpected failure instead of throwing", async () => {
    findMissingFiles.mockRejectedValue(new Error("ECONNRESET while listing"));

    await expect(repairCommand({ logLevel: "info" } as never)).resolves.toBeUndefined();

    expect(messageWith(errorSpy, "ECONNRESET while listing")).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it("still says something when the failure carries no message", async () => {
    findMissingFiles.mockRejectedValue(new Error(""));

    await repairCommand({ logLevel: "info" } as never);

    // A blank error line tells the user nothing at all.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/\S/));
    expect(process.exitCode).toBe(1);
  });
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
    captureLogs();
  });

  afterEach(() => {
    releaseLogs();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--apply --prune --ci deletes the orphan", async () => {
    await repairCommand({ logLevel: "info", apply: true, prune: true, ci: true } as never);
    expect(existsSync(orphan)).toBe(false);
    // The reported count is the audit trail of an irreversible operation, so it
    // has to be the number of files actually unlinked.
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  // The one file --prune must never touch: a manifest-shaped path that the
  // manifest actually claims. getFileContextFromPath resolving to a context is
  // the whole definition of "tracked", and deleting a tracked file throws away
  // local edits that were never pushed.
  test("never prunes a file the manifest claims", async () => {
    const tracked = path.join(sourceDir, "sys_script", "Tracked", "script.js");
    mkdirSync(path.dirname(tracked), { recursive: true });
    writeFileSync(tracked, "real work");
    getPathsInPath.mockResolvedValue([tracked, orphan]);
    getFileContextFromPath.mockImplementation((file: string) =>
      file === tracked ? ({ tableName: "sys_script" } as never) : undefined
    );

    await repairCommand({ logLevel: "info", apply: true, prune: true, ci: true } as never);

    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
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
    // A download always produces `<field>.<ext>`, so an extension-less file at
    // the manifest's depth (a LICENSE or Dockerfile someone dropped in) is not
    // one of its files either.
    const extensionless = path.join(sourceDir, "sys_script", "X", "LICENSE");
    // Deletion has to stay inside the source directory: `../build/bundle.js`
    // has the three-segment shape once it is relativized, so without the escape
    // guard a sibling build tree would be inside prune range.
    const outside = path.join(tmp, "build", "bundle.js");
    const files = [handwritten, nested, dotted, extensionless, outside];
    for (const file of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "keep me");
    }
    getPathsInPath.mockResolvedValue(files);

    await repairCommand({
      logLevel: "info",
      apply: true,
      prune: true,
      ci: true,
    } as never);

    for (const file of files) {
      expect(existsSync(file)).toBe(true);
    }
    // None of them is an orphan, so a source tree of hand-written files is a
    // consistent workspace — not a report of five deletable files.
    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to repair"));
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
  });
});
