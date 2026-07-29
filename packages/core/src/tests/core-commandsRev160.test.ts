// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// REV-160: `syncrona build` swallowed per-record build failures — buildFiles
// resolves with `{ success: false }` results instead of throwing, so the catch
// block never ran and the command exited 0 while "Failed Builds: n" was printed.
// REV-161: initCommand ignored the wizard's outcome and auto-configured MCP even
// when setup was cancelled or failed.

const mockSetLogLevel = jest.fn();
const mockLoggerError = jest.fn();

const mockGetAppFileList = jest.fn();
const mockBuildFiles = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockLogBuildResults = jest.fn();

const mockStartWizard = jest.fn<() => Promise<boolean>>();
const mockMcpCommand = jest.fn();
const mockStat = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: jest.fn(),
    silly: jest.fn(),
    debug: jest.fn(),
    setLogLevel: jest.fn(),
  },
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  getActiveStoreDecryptWarning: jest.fn(),
  activeStoreHealth: jest.fn(),
  LOGIN_DEFAULT_SOURCE_DIRECTORY: "src",
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  scopeCheck: (fn: () => Promise<void>) => fn(),
  logScopedEndpointCapability: jest.fn(),
  logErrorHint: jest.fn(),
}));

jest.unstable_mockModule("../config.js", () => ({
  getManifest: jest.fn(),
  getConfig: jest.fn(() => ({})),
  checkRuleOrder: jest.fn(() => []),
  getDiffFile: jest.fn(() => ({ changed: [] })),
  isDiffFileCorrupt: jest.fn(() => false),
  getBuildPath: jest.fn(() => "encoded-build-path"),
  getDefaultConfigFile: () => "module.exports = {};",
  loadConfigs: jest.fn(),
  resetConfigState: jest.fn(),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: jest.fn(),
  downloadAllFiles: jest.fn(),
  getAppFileList: (...a: unknown[]) => mockGetAppFileList(...a),
  buildFiles: (...a: unknown[]) => mockBuildFiles(...a),
  pushFiles: jest.fn(),
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: jest.fn(),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...a: unknown[]) => mockGitDiffToEncodedPaths(...a),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  encodedPathsToFilePaths: jest.fn(() => []),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  snClient: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  defaultClient: () => ({
    checkConnection: jest.fn(),
    getManifest: jest.fn(),
    getAppList: jest.fn(),
  }),
  unwrapSNResponse: jest.fn(),
  resolveCredentials: () => ({ instance: "dev.service-now.com", user: "u", password: "p" }),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  isScopedEndpointUnavailableError: jest.fn(() => false),
  buildManifestFromTableAPI: jest.fn(),
  listAppsFromTableAPI: jest.fn(),
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  logPushResults: jest.fn(),
  logBuildResults: (...a: unknown[]) => mockLogBuildResults(...a),
}));

jest.unstable_mockModule("../wizard.js", () => ({
  startWizard: (...a: unknown[]) => mockStartWizard(...(a as [])),
}));

jest.unstable_mockModule("../mcpCommand.js", () => ({
  mcpCommand: (...a: unknown[]) => mockMcpCommand(...a),
}));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

// fs is a CJS core module; spread the real surface and override only the
// promises members the init flow drives, so default and named imports still
// link while the ".env detection" stat stays under test control.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    stat: (...args: unknown[]) => mockStat(...args),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

const oldExitCode = process.exitCode;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  mockGitDiffToEncodedPaths.mockResolvedValue([] as never);
  mockGetAppFileList.mockResolvedValue(["src/a.js", "src/b.js"] as never);
});

afterEach(() => {
  // Never let a deliberately failing exit code leak into the jest runner.
  process.exitCode = oldExitCode;
});

describe("REV-160 buildCommand exit code", () => {
  it("sets a failing exit code when at least one record fails to build", async () => {
    mockBuildFiles.mockResolvedValue([
      { success: true, message: "built src/a.js" },
      { success: false, message: "transform error in src/b.js" },
    ] as never);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "" });

    // Old behaviour: results were only printed, so the process exited 0 and a
    // chained `syncrona build && syncrona deploy` deployed stale artifacts.
    expect(mockLogBuildResults).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code untouched when every record builds", async () => {
    mockBuildFiles.mockResolvedValue([
      { success: true, message: "built src/a.js" },
      { success: true, message: "built src/b.js" },
    ] as never);

    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "" });

    expect(process.exitCode).toBeUndefined();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("does not inspect results on a dry run", async () => {
    const { buildCommand } = await import("../commands.js");
    await buildCommand({ logLevel: "info", diff: "", dryRun: true });

    expect(mockBuildFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("REV-161 initCommand honours the wizard outcome", () => {
  beforeEach(() => {
    // No .env in the project directory, so init takes the interactive path.
    mockStat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }) as never);
  });

  it("skips MCP auto-configuration when the wizard did not complete", async () => {
    mockStartWizard.mockResolvedValue(false);

    const { initCommand } = await import("../commands.js");
    await initCommand({ logLevel: "info" });

    // Old behaviour: the wizard returned void, so a cancelled setup was
    // indistinguishable from success and MCP was configured for a workspace
    // with no config, no manifest and no credentials.
    expect(mockStartWizard).toHaveBeenCalled();
    expect(mockMcpCommand).not.toHaveBeenCalled();
  });

  it("auto-configures MCP when the wizard completed", async () => {
    mockStartWizard.mockResolvedValue(true);

    const { initCommand } = await import("../commands.js");
    await initCommand({ logLevel: "info" });

    expect(mockMcpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ autoConfigure: true, start: false })
    );
  });
});
