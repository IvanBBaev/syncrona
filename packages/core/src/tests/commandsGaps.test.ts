// SPDX-License-Identifier: GPL-3.0-or-later
export {};

// Targets the command branches commandsFlow.test.ts does not exercise:
// docsCommand, buildCommand --check-config, the buildCommand catch path,
// getDeployPaths diff-file prompt, deployment preflight failure, the deploy
// confirmation decline, and downloadCommand cancel / Table-API fallback.

const mockSetLogLevel = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerSuccess = jest.fn();

const mockGetManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockCheckRuleOrder = jest.fn();
const mockGetDiffFile = jest.fn();
const mockGetBuildPath = jest.fn();

const mockProcessManifest = jest.fn();
const mockDownloadAllFiles = jest.fn();
const mockGetAppFileList = jest.fn();
const mockBuildFiles = jest.fn();
const mockPushFiles = jest.fn();

const mockGenerateScopeDocs = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();

const mockCheckConnection = jest.fn();
const mockGetManifestApi = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockResolveCredentials = jest.fn();
const mockIsScopedUnavailable = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();

const mockPrompt = jest.fn();

jest.mock("../Logger", () => ({
  logger: {
    info: jest.fn(),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    silly: jest.fn(),
  },
}));

jest.mock("../commandHelpers", () => ({
  LOGIN_DEFAULT_SOURCE_DIRECTORY: "src",
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  scopeCheck: (fn: () => Promise<void>) => fn(),
  logScopedEndpointCapability: jest.fn(),
}));

jest.mock("../config", () => ({
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  checkRuleOrder: (...a: unknown[]) => mockCheckRuleOrder(...a),
  getDiffFile: (...a: unknown[]) => mockGetDiffFile(...a),
  getBuildPath: (...a: unknown[]) => mockGetBuildPath(...a),
  getDefaultConfigFile: () => "module.exports = {};",
}));

jest.mock("../appUtils", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
  downloadAllFiles: (...a: unknown[]) => mockDownloadAllFiles(...a),
  getAppFileList: (...a: unknown[]) => mockGetAppFileList(...a),
  buildFiles: (...a: unknown[]) => mockBuildFiles(...a),
  pushFiles: (...a: unknown[]) => mockPushFiles(...a),
}));

jest.mock("../scopeDocs", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.mock("../gitUtils", () => ({
  gitDiffToEncodedPaths: (...a: unknown[]) => mockGitDiffToEncodedPaths(...a),
}));

jest.mock("../FileUtils", () => ({
  encodedPathsToFilePaths: (...a: unknown[]) => mockEncodedPathsToFilePaths(...a),
}));

jest.mock("../snClient", () => ({
  defaultClient: () => ({
    checkConnection: (...a: unknown[]) => mockCheckConnection(...a),
    getManifest: (...a: unknown[]) => mockGetManifestApi(...a),
    getAppList: jest.fn(),
  }),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
}));

jest.mock("../manifestBuilder", () => ({
  isScopedEndpointUnavailableError: (...a: unknown[]) => mockIsScopedUnavailable(...a),
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: jest.fn(),
}));

jest.mock("../logMessages", () => ({
  logPushResults: jest.fn(),
  logBuildResults: jest.fn(),
}));

jest.mock("../wizard", () => ({ startWizard: jest.fn() }));
jest.mock("../mcpCommand", () => ({ mcpCommand: jest.fn() }));

jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...a: unknown[]) => mockPrompt(...a) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue({});
  mockGetDiffFile.mockReturnValue({ changed: [] });
  mockGetBuildPath.mockReturnValue("encoded-build-path");
  mockProcessManifest.mockResolvedValue(undefined);
  mockDownloadAllFiles.mockResolvedValue(undefined);
  mockGetAppFileList.mockResolvedValue([]);
  mockBuildFiles.mockResolvedValue([]);
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
  it("errors when no manifest is available", async () => {
    mockGetManifest.mockReturnValue(undefined);
    const { docsCommand } = await import("../commands");
    await docsCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("No manifest found")
    );
    expect(mockGenerateScopeDocs).not.toHaveBeenCalled();
  });

  it("writes scope docs when a manifest exists", async () => {
    mockGetManifest.mockReturnValue({ scope: "x_test", tables: {} });
    const { docsCommand } = await import("../commands");
    await docsCommand({ logLevel: "info" });
    expect(mockGenerateScopeDocs).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      expect.stringContaining("/docs/scope.md")
    );
  });

  it("logs an error when doc generation fails", async () => {
    mockGetManifest.mockReturnValue({ scope: "x_test", tables: {} });
    mockGenerateScopeDocs.mockRejectedValueOnce(new Error("render failed"));
    const { docsCommand } = await import("../commands");
    await docsCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("render failed")
    );
  });
});

describe("buildCommand --check-config", () => {
  it("reports a clean rule order when nothing is shadowed", async () => {
    mockGetConfig.mockReturnValue({ rules: [{ match: "*.ts" }] });
    mockCheckRuleOrder.mockReturnValue([]);
    const { buildCommand } = await import("../commands");
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
    const { buildCommand } = await import("../commands");
    await buildCommand({ logLevel: "info", diff: "", checkConfig: true });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

describe("buildCommand failure handling", () => {
  it("logs the error and sets a failing exit code when the pipeline throws", async () => {
    const oldExit = process.exitCode;
    mockGitDiffToEncodedPaths.mockRejectedValueOnce(new Error("git exploded"));
    const { buildCommand } = await import("../commands");
    await buildCommand({ logLevel: "info", diff: "" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("git exploded")
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

describe("deployCommand", () => {
  it("aborts when the connection preflight fails", async () => {
    mockCheckConnection.mockRejectedValueOnce(new Error("offline"));
    const { deployCommand } = await import("../commands");
    await deployCommand({ logLevel: "info" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unable to reach ServiceNow instance before deploy")
    );
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("returns without pushing when the deploy confirmation is declined", async () => {
    mockPrompt.mockResolvedValueOnce({ confirmed: false }); // deploy confirm
    const { deployCommand } = await import("../commands");
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
    const { deployCommand } = await import("../commands");
    await deployCommand({ logLevel: "info" });
    expect(mockGetAppFileList).toHaveBeenCalledWith(["/build/changed.js"]);
    expect(mockEncodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(mockPushFiles).toHaveBeenCalled();
  });
});

describe("downloadCommand", () => {
  it("returns early when the overwrite prompt is declined", async () => {
    mockPrompt.mockResolvedValueOnce({ confirmed: false });
    const { downloadCommand } = await import("../commands");
    await downloadCommand({ logLevel: "info", scope: "x_test" });
    expect(mockProcessManifest).not.toHaveBeenCalled();
  });

  it("falls back to the Table API when the scoped manifest endpoint is missing", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } });
    mockIsScopedUnavailable.mockReturnValue(true);
    const { downloadCommand } = await import("../commands");
    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalled();
    expect(mockDownloadAllFiles).toHaveBeenCalled();
  });

  it("rethrows a non-scoped manifest error", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 500 } });
    mockIsScopedUnavailable.mockReturnValue(false);
    const { downloadCommand } = await import("../commands");
    await expect(
      downloadCommand({ logLevel: "info", scope: "x_test", ci: true })
    ).rejects.toEqual({ response: { status: 500 } });
  });
});
