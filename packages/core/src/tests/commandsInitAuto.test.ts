// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "node:path";
export {};

const mockSetLogLevel = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockDefaultConfigFile = jest.fn();
const mockStartWizard = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockListAppsFromTableAPI = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockClient = { name: "default-client" };
const mockPrompt = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../Watcher.js", () => ({
  startWatching: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
  downloadAllFiles: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getDefaultConfigFile: (...args: unknown[]) => mockDefaultConfigFile(...args),
  resetConfigState: jest.fn(),
  loadConfigs: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule("../wizard.js", () => ({
  startWizard: (...args: unknown[]) => mockStartWizard(...args),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  buildBulkDownloadFromTableAPI: jest.fn(),
  listAppsFromTableAPI: (...args: unknown[]) => mockListAppsFromTableAPI(...args),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  defaultClient: () => mockClient,
  resolveCredentials: () => ({ instance: "", user: "", password: "", profile: undefined }),
  setActiveInstanceProfile: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  clearStoredCredentialsCache: jest.fn(),
  unwrapSNResponse: jest.fn(),
}));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

// fs is a CJS core module; spread the real surface and override only the
// promises members the init flow drives, so callers doing `import fs from "fs"`
// (default) or a named import still link while disk writes stay mocked.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    stat: (...args: unknown[]) => mockStat(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: jest.fn(),
    unlink: jest.fn(),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

describe("initCommand auto scope flow", () => {
  const oldCwd = process.cwd;
  const oldChdir = process.chdir;

  beforeEach(() => {
    jest.clearAllMocks();
    process.cwd = jest.fn(() => "/tmp/project");
    process.chdir = jest.fn();

    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {} });
    mockDefaultConfigFile.mockReturnValue("module.exports={sourceDirectory:'src'};\n");

    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    mockStat.mockImplementation(async (targetPath: string) => {
      if (targetPath === path.join("/tmp/project", ".env")) {
        return { isFile: () => true };
      }
      throw enoent;
    });

    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    mockListAppsFromTableAPI.mockResolvedValue([
      { sys_id: "1", scope: "x_alpha", displayName: "Alpha" },
      { sys_id: "2", scope: "x_beta", displayName: "Beta" },
      { sys_id: "3", scope: "global", displayName: "Global" },
    ]);

    mockBuildManifestFromTableAPI.mockImplementation(async (scope: unknown) => ({
      scope,
      tables: {
        sys_script_include: {
          records: {
            [`Rec-${String(scope)}`]: {
              sys_id: `id-${String(scope)}`,
              name: `Rec-${String(scope)}`,
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    }));
  });

  afterEach(() => {
    process.cwd = oldCwd;
    process.chdir = oldChdir;
  });

  it("initializes all x_* scopes when .env exists", async () => {
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info", ci: true });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockStartWizard).not.toHaveBeenCalled();
    expect(mockListAppsFromTableAPI).toHaveBeenCalledWith(mockClient);
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledTimes(2);
    expect(mockBuildManifestFromTableAPI).toHaveBeenNthCalledWith(
      1,
      "x_alpha",
      mockClient,
      { includes: {}, excludes: {}, tableOptions: {} }
    );
    expect(mockBuildManifestFromTableAPI).toHaveBeenNthCalledWith(
      2,
      "x_beta",
      mockClient,
      { includes: {}, excludes: {}, tableOptions: {} }
    );
    expect(mockProcessManifest).toHaveBeenCalledTimes(2);
  });

  it("cancels auto-init when the confirmation prompt is declined (DX4)", async () => {
    mockPrompt.mockResolvedValueOnce({ confirmed: false });
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info" }); // no --ci → prompts

    expect(mockPrompt).toHaveBeenCalled();
    // Declined before the creation/download loop: no scope is downloaded.
    expect(mockBuildManifestFromTableAPI).not.toHaveBeenCalled();
    expect(mockProcessManifest).not.toHaveBeenCalled();
  });

  it("dry-run reports the plan without creating or downloading (DX4)", async () => {
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info", dryRun: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockBuildManifestFromTableAPI).not.toHaveBeenCalled();
  });

  // INJ-1: `scope` comes from the instance's sys_app rows and is joined onto
  // packages/ to create — and download into — a directory. Only the download
  // pipeline validated instance-supplied path components, so a tampered scope
  // with a separator placed the generated workspace outside packages/.
  it("skips an app whose scope cannot be used as a directory name", async () => {
    mockListAppsFromTableAPI.mockResolvedValue([
      { sys_id: "1", scope: "x_evil/../../etc", displayName: "Evil" },
      { sys_id: "2", scope: "x_win\\..\\..\\etc", displayName: "Evil Win" },
      { sys_id: "3", scope: "x_alpha", displayName: "Alpha" },
    ]);
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info", ci: true });

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledTimes(1);
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_alpha",
      mockClient,
      expect.anything()
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping app with unsafe scope name "x_evil/../../etc"')
    );
    for (const call of mockMkdir.mock.calls) {
      expect(String(call[0])).not.toContain("etc");
    }
  });

  // Stripping the "x_<vendor>_" prefix can turn a safe scope into an unsafe
  // component, so the DERIVED directory name needs the same check.
  it("falls back to the full scope when the stripped alias is not a usable directory name", async () => {
    mockListAppsFromTableAPI.mockResolvedValue([{ sys_id: "1", scope: "x_a_..", displayName: "Dots" }]);
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info", ci: true });

    const created = mockMkdir.mock.calls.map((call) => String(call[0]));
    expect(created).toContain(path.join("/tmp/project", "packages", "x_a_..", "src"));
    // A ".." alias would have collapsed to the project's own src directory.
    expect(created).not.toContain(path.join("/tmp/project", "src"));
  });
});
