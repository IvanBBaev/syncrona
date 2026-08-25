// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { PATH_DELIMITER } from "../constants.js";
export {};

// Targets the command branches commandsFlow.test.ts does not exercise:
// docsCommand, buildCommand --check-config, the buildCommand catch path,
// getDeployPaths diff-file prompt, deployment preflight failure, the deploy
// confirmation decline, and downloadCommand cancel / Table-API fallback.

const mockSetLogLevel = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerSuccess = jest.fn();

const mockGetManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockCheckRuleOrder = jest.fn();
const mockGetDiffFile = jest.fn();
const mockIsDiffFileCorrupt = jest.fn();
const mockGetBuildPath = jest.fn();
const mockLogErrorHint = jest.fn();

const mockProcessManifest = jest.fn();
const mockDownloadAllFiles = jest.fn();
const mockGetAppFileList = jest.fn();
const mockBuildFiles = jest.fn();
const mockPushFiles = jest.fn();

const mockGenerateScopeDocs = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockWriteDiff = jest.fn();
const mockClearDiff = jest.fn();
const mockBuildFilePaths = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();

const mockCheckConnection = jest.fn();
const mockGetManifestApi = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockResolveCredentials = jest.fn();
const mockIsScopedUnavailable = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();

const mockPrompt = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  getActiveStoreDecryptWarning: jest.fn(),
  activeStoreHealth: jest.fn(),
  LOGIN_DEFAULT_SOURCE_DIRECTORY: "src",
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  scopeCheck: (fn: () => Promise<void>) => fn(),
  logScopedEndpointCapability: jest.fn(),
  logErrorHint: (...a: unknown[]) => mockLogErrorHint(...a),
}));

jest.unstable_mockModule("../config.js", () => ({
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  checkRuleOrder: (...a: unknown[]) => mockCheckRuleOrder(...a),
  getDiffFile: (...a: unknown[]) => mockGetDiffFile(...a),
  isDiffFileCorrupt: (...a: unknown[]) => mockIsDiffFileCorrupt(...a),
  getBuildPath: (...a: unknown[]) => mockGetBuildPath(...a),
  getDefaultConfigFile: () => "module.exports = {};",
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
  downloadAllFiles: (...a: unknown[]) => mockDownloadAllFiles(...a),
  getAppFileList: (...a: unknown[]) => mockGetAppFileList(...a),
  buildFiles: (...a: unknown[]) => mockBuildFiles(...a),
  buildFilePaths: (...a: unknown[]) => mockBuildFilePaths(...a),
  pushFiles: (...a: unknown[]) => mockPushFiles(...a),
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...a: unknown[]) => mockGitDiffToEncodedPaths(...a),
  writeDiff: (...a: unknown[]) => mockWriteDiff(...a),
  clearDiff: (...a: unknown[]) => mockClearDiff(...a),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  encodedPathsToFilePaths: (...a: unknown[]) => mockEncodedPathsToFilePaths(...a),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  snClient: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  defaultClient: () => ({
    checkConnection: (...a: unknown[]) => mockCheckConnection(...a),
    getManifest: (...a: unknown[]) => mockGetManifestApi(...a),
    getAppList: jest.fn(),
  }),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  isScopedEndpointUnavailableError: (...a: unknown[]) => mockIsScopedUnavailable(...a),
  // DX22: the scoped-manifest enrichment is a no-op for these suites — they
  // assert on the manifest they hand in, not on the metadata layer.
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: jest.fn(),
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  logPushResults: jest.fn(),
  logBuildResults: jest.fn(),
}));

jest.unstable_mockModule("../wizard.js", () => ({ startWizard: jest.fn() }));
jest.unstable_mockModule("../mcpCommand.js", () => ({ mcpCommand: jest.fn() }));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...a: unknown[]) => mockPrompt(...a) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue({});
  // The ordinary case is no sync.diff.manifest.json at all, and the real
  // ConfigManager reports that by THROWING — not by handing back an empty
  // `changed` list, which is a different situation with a different outcome.
  mockGetDiffFile.mockImplementation(() => {
    throw new Error("Error getting diff file");
  });
  mockIsDiffFileCorrupt.mockReturnValue(false);
  mockGetBuildPath.mockReturnValue("encoded-build-path");
  mockProcessManifest.mockResolvedValue(undefined);
  mockDownloadAllFiles.mockResolvedValue(undefined);
  mockGetAppFileList.mockResolvedValue([]);
  mockBuildFiles.mockResolvedValue([]);
  mockBuildFilePaths.mockReturnValue([]);
  mockWriteDiff.mockResolvedValue(undefined);
  mockClearDiff.mockResolvedValue(undefined);
  mockPushFiles.mockResolvedValue([]);
  mockGenerateScopeDocs.mockResolvedValue("/docs/scope.md");
  mockGitDiffToEncodedPaths.mockResolvedValue([]);
  mockEncodedPathsToFilePaths.mockResolvedValue(["/build/a.js"]);
  mockResolveCredentials.mockReturnValue({ instance: "dev.service-now.com" });
  mockCheckConnection.mockResolvedValue(undefined);
  mockBuildManifestFromTableAPI.mockResolvedValue({ scope: "x_test", tables: {} });
  mockPrompt.mockResolvedValue({ confirmed: true });
  mockIsScopedUnavailable.mockReturnValue(false);
});

describe("docsCommand", () => {
  it("errors and sets a failing exit code when no manifest is available", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetManifest.mockReturnValue(undefined);
    const { docsCommand } = await import("../commands.js");
    await docsCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("No manifest found")
    );
    expect(mockGenerateScopeDocs).not.toHaveBeenCalled();
    // A "docs" run that produced nothing must not report success to the shell.
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("writes scope docs when a manifest exists", async () => {
    mockGetManifest.mockReturnValue({ scope: "x_test", tables: {} });
    const { docsCommand } = await import("../commands.js");
    await docsCommand({ logLevel: "info" });
    expect(mockGenerateScopeDocs).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      expect.stringContaining("/docs/scope.md")
    );
  });

  it("logs an error and sets a failing exit code when doc generation fails", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetManifest.mockReturnValue({ scope: "x_test", tables: {} });
    mockGenerateScopeDocs.mockRejectedValueOnce(new Error("render failed"));
    const { docsCommand } = await import("../commands.js");
    await docsCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("render failed")
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

describe("buildCommand --check-config", () => {
  it("reports a clean rule order when nothing is shadowed", async () => {
    mockGetConfig.mockReturnValue({ rules: [{ match: "*.ts" }] });
    mockCheckRuleOrder.mockReturnValue([]);
    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "", checkConfig: true });
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Config rule order OK")
    );
    expect(mockGitDiffToEncodedPaths).not.toHaveBeenCalled();
  });

  it("warns and sets a failing exit code when a rule is shadowed", async () => {
    const oldExit = process.exitCode;
    mockGetConfig.mockReturnValue({
      rules: [{ match: "**/*" }, { match: "*.ts" }],
    });
    mockCheckRuleOrder.mockReturnValue([
      { laterIndex: 1, earlierIndex: 0, sample: "x.ts" },
    ]);
    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "", checkConfig: true });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

// `build --diff <target>` is documented — in the CLI help, in README and in
// CLAUDE.md — to RECORD what it built, and getDeployPaths reads exactly that
// file back. Nothing ever wrote it: writeDiff existed, was exported and was
// unit-tested, but no command called it. So sync.diff.manifest.json never
// appeared, every deploy after a diff build fell through to the full build
// scope, and `deploy --ci` did it without a prompt — the precise escalation the
// comment in getDeployPaths warns about, overwriting instance records the diff
// never touched. Its mirror image is just as bad: a diff manifest left behind by
// an earlier run silently narrows the next FULL build's deploy to a stale
// subset, so a build without --diff has to clear it.
describe("buildCommand diff manifest", () => {
  it("records the artifacts it built when --diff is given", async () => {
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "s1", fields: {} }]);
    mockBuildFiles.mockResolvedValue([{ success: true, message: "built" }]);
    mockBuildFilePaths.mockReturnValue(["/build/sys_script/rec/script.js"]);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "main" });

    expect(mockWriteDiff).toHaveBeenCalledWith("/build/sys_script/rec/script.js");
    expect(mockClearDiff).not.toHaveBeenCalled();
  });

  it("leaves a failed record out of the diff manifest", async () => {
    const oldExit = process.exitCode;
    const ok = { table: "sys_script", sysId: "s1", fields: {} };
    const bad = { table: "sys_script", sysId: "s2", fields: {} };
    mockGetAppFileList.mockResolvedValue([ok, bad]);
    // buildFiles returns results in fileList order, which is what lets the
    // successes be selected positionally.
    mockBuildFiles.mockResolvedValue([
      { success: true, message: "built" },
      { success: false, message: "plugin blew up" },
    ]);
    mockBuildFilePaths.mockReturnValue(["/build/a.js"]);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "main" });

    // A record whose artifact was never written must not be deployed: the file
    // at that path is either absent or stale from an earlier build.
    expect(mockBuildFilePaths).toHaveBeenCalledWith([ok]);
    expect(mockWriteDiff).toHaveBeenCalledWith("/build/a.js");
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("joins several artifacts with the shared path delimiter", async () => {
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "s1", fields: {} }]);
    mockBuildFiles.mockResolvedValue([{ success: true, message: "built" }]);
    mockBuildFilePaths.mockReturnValue(["/build/a.js", "/build/b.js"]);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "main" });

    expect(mockWriteDiff).toHaveBeenCalledWith(
      ["/build/a.js", "/build/b.js"].join(PATH_DELIMITER)
    );
  });

  it("clears a stale diff manifest on a full build", async () => {
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "s1", fields: {} }]);
    mockBuildFiles.mockResolvedValue([{ success: true, message: "built" }]);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "" });

    expect(mockClearDiff).toHaveBeenCalled();
    expect(mockWriteDiff).not.toHaveBeenCalled();
  });

  it("touches neither file on a dry run", async () => {
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "s1", fields: {} }]);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "main", dryRun: true });

    expect(mockBuildFiles).not.toHaveBeenCalled();
    expect(mockWriteDiff).not.toHaveBeenCalled();
    expect(mockClearDiff).not.toHaveBeenCalled();
  });
});

describe("buildCommand failure handling", () => {
  it("logs the error and sets a failing exit code when the pipeline throws", async () => {
    const oldExit = process.exitCode;
    mockGitDiffToEncodedPaths.mockRejectedValueOnce(new Error("git exploded"));
    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("git exploded")
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

describe("deployCommand", () => {
  it("aborts, hints and sets a failing exit code when the connection preflight fails", async () => {
    const oldExit = process.exitCode;
    mockCheckConnection.mockRejectedValueOnce(new Error("offline"));
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    // #3/#49: the message now names the target instance and the failure is
    // routed through logErrorHint (credential-source-aware advice) instead of
    // hardcoded SN_* text; the deploy exits non-zero so CI sees the failure.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unable to reach ServiceNow instance dev.service-now.com before deploy")
    );
    expect(mockLogErrorHint).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockPushFiles).not.toHaveBeenCalled();
    process.exitCode = oldExit;
  });

  it("returns without pushing when the deploy confirmation is declined", async () => {
    mockPrompt.mockResolvedValueOnce({ confirmed: false }); // deploy confirm
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockGetAppFileList).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("deploys only diff-file paths when the user opts in", async () => {
    mockGetDiffFile.mockReturnValue({ changed: ["/build/changed.js"] });
    mockPrompt
      .mockResolvedValueOnce({ confirmed: true }) // deploy confirm
      .mockResolvedValueOnce({ confirmed: true }); // diff-only confirm
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "1", fields: {} }]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockGetAppFileList).toHaveBeenCalledWith(["/build/changed.js"]);
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("#3: sets a failing exit code when any record fails to push", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetAppFileList.mockResolvedValue([
      { table: "sys_script", sysId: "1", fields: {} },
    ]);
    // One record failed — deploy folds per-record failures into { success:false }
    // results, so before the fix this exited 0. It must now fail the shell.
    mockPushFiles.mockResolvedValue([
      { success: true, message: "ok" },
      { success: false, message: "boom" },
    ]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockPushFiles).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("#3: leaves the exit code clean when every record pushes successfully", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetAppFileList.mockResolvedValue([
      { table: "sys_script", sysId: "1", fields: {} },
    ]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockPushFiles).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = oldExit;
  });

  it("#3/#49: hints and fails the shell when no instance is configured", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockResolveCredentials.mockReturnValueOnce({ instance: undefined });
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("No server configured for deploy")
    );
    expect(mockLogErrorHint).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockCheckConnection).not.toHaveBeenCalled();
    process.exitCode = oldExit;
  });

  it("--ci deploys the diff manifest instead of escalating to a full scope", async () => {
    // Without a TTY the diff-only prompt resolves to its `false` default, so a
    // `build --diff <branch> && deploy --ci` pipeline used to overwrite every
    // record in the scope and still exit 0. --ci must never prompt: the diff
    // manifest exists only because someone asked for a diff build.
    mockGetDiffFile.mockReturnValue({ changed: ["/build/changed.js"] });
    mockGetAppFileList.mockResolvedValue([{ table: "sys_script", sysId: "1", fields: {} }]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockGetAppFileList).toHaveBeenCalledWith(["/build/changed.js"]);
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    // The narrowed scope is recorded so a CI log shows what was deployed.
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("1 file(s) from the diff manifest")
    );
  });

  it("--ci still deploys the full build scope when no diff manifest exists", async () => {
    // Absence is what the default mock models: getDiffFile() throws. Nobody
    // asked for a subset, so the whole build scope is the right answer.
    mockGetAppFileList.mockResolvedValue([
      { table: "sys_script", sysId: "1", fields: {} },
    ]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockEncodedPathsToFilePaths).toHaveBeenCalledWith("encoded-build-path");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("full build scope")
    );
  });

  it("deploys nothing - not everything - when the diff manifest is empty", async () => {
    // `build --diff main` with no changes on the branch still writes the
    // manifest, with `{"changed": []}` inside it. Read as "no manifest", that
    // empty list escalates the next `deploy --ci` to the entire build scope -
    // the loudest possible outcome from the quietest possible build, with no
    // prompt in the way. An empty diff means there is nothing to deploy.
    mockGetDiffFile.mockReturnValue({ changed: [] });
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(mockGetAppFileList).toHaveBeenCalledWith([]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("no changed files")
    );
  });

  it("does not offer the diff-only prompt for an empty diff manifest", async () => {
    // Interactively the escalation hid behind a question with no content:
    // "deploy only files changed in your diff file?" was never asked for an
    // empty list, so the run fell through to the full scope on a default the
    // user never saw. There is nothing to narrow and nothing to ask.
    mockGetDiffFile.mockReturnValue({ changed: [] });
    mockPrompt.mockResolvedValueOnce({ confirmed: true }); // deploy confirm
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info" });
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(mockGetAppFileList).toHaveBeenCalledWith([]);
  });

  it("fails the shell when there is nothing built to deploy", async () => {
    // `deploy` before `build` (or after a `clean`) resolved the build directory
    // to zero files and then pushed zero records - no output, exit 0. In CI that
    // is a green deploy stage that deployed nothing, which is the one outcome a
    // deploy must never report.
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockEncodedPathsToFilePaths.mockResolvedValue([]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to deploy")
    );
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("fails the shell when none of the selected files map to a record", async () => {
    // The diff manifest stores absolute paths, so a manifest carried into a
    // different checkout root - or written before a `refresh` dropped the
    // records - names files no manifest record claims. getAppFileList warns and
    // drops them, and the deploy used to push the empty remainder and exit 0.
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetDiffFile.mockReturnValue({ changed: ["/elsewhere/build/gone.js"] });
    mockGetAppFileList.mockResolvedValue([]);
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to deploy")
    );
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("keeps the shell clean for a diff manifest that deliberately lists nothing", async () => {
    // The one legitimate zero-record deploy: a diff build that found no
    // changes. Nothing is wrong, so nothing may fail.
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockGetDiffFile.mockReturnValue({ changed: [] });
    const { deployCommand } = await import("../commands.js");
    await deployCommand({ logLevel: "info", ci: true });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = oldExit;
  });

  it("#46: aborts a scoped deploy when the diff manifest is present-but-corrupt", async () => {
    // A corrupt sync.diff.manifest.json must abort (getDiffFile throws), never
    // silently degrade a scoped deploy into a full-scope deploy.
    mockIsDiffFileCorrupt.mockReturnValue(true);
    mockGetDiffFile.mockImplementation(() => {
      throw new Error("sync.diff.manifest.json is present but unreadable");
    });
    mockPrompt.mockResolvedValueOnce({ confirmed: true }); // deploy confirm
    const { deployCommand } = await import("../commands.js");
    await expect(deployCommand({ logLevel: "info" })).rejects.toThrow(
      /present but unreadable/
    );
    // It aborted before falling back to a full-scope build path.
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });
});

describe("downloadCommand", () => {
  it("returns early when the overwrite prompt is declined", async () => {
    mockPrompt.mockResolvedValueOnce({ confirmed: false });
    const { downloadCommand } = await import("../commands.js");
    await downloadCommand({ logLevel: "info", scope: "x_test" });
    expect(mockProcessManifest).not.toHaveBeenCalled();
  });

  it("falls back to the Table API when the scoped manifest endpoint is missing", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } });
    mockIsScopedUnavailable.mockReturnValue(true);
    const { downloadCommand } = await import("../commands.js");
    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalled();
    expect(mockDownloadAllFiles).toHaveBeenCalled();
  });

  it("rethrows a non-scoped manifest error", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 500 } });
    mockIsScopedUnavailable.mockReturnValue(false);
    const { downloadCommand } = await import("../commands.js");
    await expect(
      downloadCommand({ logLevel: "info", scope: "x_test", ci: true })
    ).rejects.toEqual({ response: { status: 500 } });
  });
});
