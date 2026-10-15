// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "node:path";
export {};

// Branch edges of commands.ts the other command suites leave untaken:
// the all-scope init fallbacks (Table-API app list, rethrow, empty list,
// existing sync.config.js, accepted confirmation, SN_INSTANCE banner), a scoped
// manifest without a `tables` key, non-Error throwables in the three catch
// blocks, `build --check-config` with no rules, and declining the diff-only
// deploy prompt.

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerSuccess = jest.fn();

const mockGetManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockCheckRuleOrder = jest.fn();
const mockGetDiffFile = jest.fn();
const mockGetBuildPath = jest.fn();
const mockLoadConfigs = jest.fn();

const mockProcessManifest = jest.fn();
const mockDownloadAllFiles = jest.fn();
const mockGetAppFileList = jest.fn();
const mockPushFiles = jest.fn();
const mockGenerateScopeDocs = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();

const mockGetAppList = jest.fn();
const mockGetManifestApi = jest.fn();
const mockResolveCredentials = jest.fn();
const mockIsScopedUnavailable = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();

const mockPrompt = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
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
  setLogLevel: jest.fn(),
  scopeCheck: (fn: () => Promise<void>) => fn(),
  logScopedEndpointCapability: jest.fn(),
  logErrorHint: jest.fn(),
}));

jest.unstable_mockModule("../config.js", () => ({
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  checkRuleOrder: (...a: unknown[]) => mockCheckRuleOrder(...a),
  getDiffFile: (...a: unknown[]) => mockGetDiffFile(...a),
  isDiffFileCorrupt: () => false,
  getBuildPath: (...a: unknown[]) => mockGetBuildPath(...a),
  getSourcePath: () => "/tmp/project/src",
  getDefaultConfigFile: () => "module.exports = {};",
  resetConfigState: jest.fn(),
  loadConfigs: (...a: unknown[]) => mockLoadConfigs(...a),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
  downloadAllFiles: (...a: unknown[]) => mockDownloadAllFiles(...a),
  getAppFileList: (...a: unknown[]) => mockGetAppFileList(...a),
  buildFiles: jest.fn(),
  buildFilePaths: jest.fn(),
  pushFiles: (...a: unknown[]) => mockPushFiles(...a),
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.unstable_mockModule("../withdrawnFieldFiles.js", () => ({
  warnWithdrawnFieldFiles: jest.fn(async () => undefined),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...a: unknown[]) => mockGitDiffToEncodedPaths(...a),
  gitDiffToChanges: jest.fn(),
  gitWorkingTreeDeletions: jest.fn(async () => []),
  writeDiff: jest.fn(),
  clearDiff: jest.fn(),
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
    checkConnection: jest.fn(async () => undefined),
    getManifest: (...a: unknown[]) => mockGetManifestApi(...a),
    getAppList: (...a: unknown[]) => mockGetAppList(...a),
  }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  isScopedEndpointUnavailableError: (...a: unknown[]) => mockIsScopedUnavailable(...a),
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
  attachMetaFieldsToManifest: async (manifest: unknown) => manifest,
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: (...a: unknown[]) => mockListAppsFromTableAPI(...a),
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

jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    stat: (...a: unknown[]) => mockStat(...a),
    mkdir: (...a: unknown[]) => mockMkdir(...a),
    writeFile: (...a: unknown[]) => mockWriteFile(...a),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

const { initCommand, downloadCommand, docsCommand, buildCommand, deployCommand } =
  await import("../commands.js");

const ROOT = "/tmp/project";
const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const scopedManifest = (scope: string) => ({
  data: {
    result: {
      scope,
      tables: { sys_script_include: { records: { R: { sys_id: "1", name: "R", files: [] } } } },
    },
  },
});

const oldCwd = process.cwd;
const oldChdir = process.chdir;
let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  jest.clearAllMocks();
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  process.cwd = jest.fn(() => ROOT);
  process.chdir = jest.fn() as unknown as typeof process.chdir;

  mockGetConfig.mockReturnValue({});
  mockGetManifest.mockImplementation(() => {
    throw new Error("no manifest");
  });
  mockGetDiffFile.mockImplementation(() => {
    throw new Error("Error getting diff file");
  });
  mockGetBuildPath.mockReturnValue("encoded-build-path");
  mockLoadConfigs.mockResolvedValue(undefined);
  mockProcessManifest.mockResolvedValue(undefined);
  mockDownloadAllFiles.mockResolvedValue(undefined);
  mockGetAppFileList.mockImplementation(async (paths: unknown) => paths);
  mockPushFiles.mockResolvedValue([{ success: true }]);
  mockGenerateScopeDocs.mockResolvedValue("/docs/scope.md");
  mockGitDiffToEncodedPaths.mockResolvedValue([]);
  mockEncodedPathsToFilePaths.mockResolvedValue(["/build/full.js"]);
  mockResolveCredentials.mockReturnValue({ instance: "" });
  mockIsScopedUnavailable.mockReturnValue(false);
  mockBuildManifestFromTableAPI.mockImplementation(async (scope: unknown) => ({
    scope,
    scopeId: "tbl",
    tables: { t: { records: {} } },
  }));
  mockGetAppList.mockResolvedValue({ data: { result: [{ scope: "x_v_alpha" }] } });
  mockGetManifestApi.mockImplementation(async (scope: unknown) => scopedManifest(String(scope)));
  mockPrompt.mockResolvedValue({ confirmed: true });

  mockStat.mockImplementation(async (p: unknown) => {
    if (p === path.join(ROOT, ".env")) return { isFile: () => true };
    throw enoent();
  });
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

afterEach(() => {
  process.cwd = oldCwd;
  process.chdir = oldChdir;
  process.exitCode = savedExitCode;
});

describe("initCommand all-scope flow edges", () => {
  it("falls back to the Table API app list when the scoped endpoint is unavailable", async () => {
    const unavailable = new Error("404 scoped endpoint");
    mockGetAppList.mockRejectedValue(unavailable);
    mockIsScopedUnavailable.mockImplementation((e: unknown) => e === unavailable);
    mockListAppsFromTableAPI.mockResolvedValue([{ scope: "x_v_beta" }]);

    await initCommand({ logLevel: "info", ci: true });

    expect(mockGetManifestApi).toHaveBeenCalledTimes(1);
    expect(mockGetManifestApi.mock.calls[0][0]).toBe("x_v_beta");
    expect(process.chdir).toHaveBeenCalledWith(path.join(ROOT, "packages/beta"));
  });

  it("rethrows an app-list failure that is not a missing scoped endpoint", async () => {
    mockGetAppList.mockRejectedValue(new Error("401 Unauthorized"));

    await expect(initCommand({ logLevel: "info", ci: true })).rejects.toThrow(
      "401 Unauthorized"
    );
    expect(mockListAppsFromTableAPI).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalledWith(
      expect.stringContaining("packages/"),
      expect.anything()
    );
  });

  it("warns and creates nothing when the instance has no x_* scoped apps", async () => {
    mockGetAppList.mockResolvedValue({ data: { result: [{ scope: "global" }, { scope: "" }] } });

    await initCommand({ logLevel: "info", ci: true });

    expect(mockLoggerWarn).toHaveBeenCalledWith("No active scoped apps found for initialization.");
    expect(mockGetManifestApi).not.toHaveBeenCalled();
    expect(process.chdir).not.toHaveBeenCalled();
  });

  it("proceeds after an accepted confirmation and keeps an existing sync.config.js", async () => {
    mockStat.mockImplementation(async (p: unknown) => {
      if (p === path.join(ROOT, ".env")) return { isFile: () => true };
      if (p === path.join(ROOT, "packages/alpha/sync.config.js")) return { isFile: () => true };
      throw enoent();
    });

    await initCommand({ logLevel: "info" }); // no --ci: prompts

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockGetManifestApi.mock.calls[0][0]).toBe("x_v_alpha");
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      "Init complete: all discoverable scopes initialized. ✅"
    );
  });

  it("names the instance the .env resolves to in the banner", async () => {
    mockResolveCredentials.mockReturnValue({ instance: "dev123.service-now.com" });

    await initCommand({ logLevel: "info", dryRun: true });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("(SN_INSTANCE=dev123.service-now.com)")
    );
  });
});

describe("downloadCommand edges", () => {
  it("rebuilds from the Table API when the scoped manifest has no tables key", async () => {
    mockGetManifestApi.mockResolvedValue({ data: { result: { scope: "x_v_alpha" } } });

    await downloadCommand({ logLevel: "info", scope: "x_v_alpha", ci: true });

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledTimes(1);
    expect(mockProcessManifest).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "tbl" }),
      false
    );
  });

  it("reports a non-Error doc-generation failure as a warning", async () => {
    mockGenerateScopeDocs.mockRejectedValue("disk full");

    await downloadCommand({ logLevel: "info", scope: "x_v_alpha", ci: true });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Could not generate scope documentation: disk full"
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("Download complete ✅");
  });
});

describe("non-Error throwables", () => {
  it("docsCommand stringifies a non-Error failure and fails the shell", async () => {
    mockGetManifest.mockReturnValue({ scope: "x_v_alpha", tables: {} });
    mockGenerateScopeDocs.mockRejectedValue(42);

    await docsCommand({ logLevel: "info" });

    expect(mockLoggerError).toHaveBeenCalledWith("Failed to generate scope documentation: 42");
    expect(process.exitCode).toBe(1);
  });

  it("buildCommand stringifies a non-Error failure and fails the shell", async () => {
    mockGitDiffToEncodedPaths.mockRejectedValue("git missing");

    await buildCommand({ logLevel: "info", diff: "" });

    expect(mockLoggerError).toHaveBeenCalledWith("Build failed: git missing");
    expect(process.exitCode).toBe(1);
  });
});

describe("buildCommand --check-config without rules", () => {
  it("treats a config with no rules as an empty, clean rule list", async () => {
    mockGetConfig.mockReturnValue({});
    mockCheckRuleOrder.mockReturnValue([]);

    await buildCommand({ logLevel: "info", diff: "", checkConfig: true });

    expect(mockCheckRuleOrder).toHaveBeenCalledWith([]);
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      "Config rule order OK (0 rule(s); no shadowing detected)."
    );
    expect(process.exitCode).toBeUndefined();
  });
});

describe("deployCommand diff-only prompt declined", () => {
  it("deploys the full build scope when the user declines the diff-only option", async () => {
    mockResolveCredentials.mockReturnValue({ instance: "dev.service-now.com" });
    mockGetDiffFile.mockReturnValue({ changed: ["/src/diff-only.js"] });
    mockPrompt
      .mockResolvedValueOnce({ confirmed: true }) // overwrite confirmation
      .mockResolvedValueOnce({ confirmed: false }); // diff-only offer

    await deployCommand({ logLevel: "info" });

    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockEncodedPathsToFilePaths).toHaveBeenCalledWith("encoded-build-path");
    expect(mockPushFiles).toHaveBeenCalledWith(["/build/full.js"]);
    expect(process.exitCode).toBeUndefined();
  });
});
