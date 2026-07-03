// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockSetLogLevel = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockDefaultConfigFile = jest.fn();
const mockStartWizard = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockGetAppListApi = jest.fn();
const mockGetManifestApi = jest.fn();
const mockPrompt = jest.fn();

jest.unstable_mockModule("../Watcher.js", () => ({
  startWatching: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
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
  isScopedEndpointUnavailableError: () => false,
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  listAppsFromTableAPI: jest.fn(),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  defaultClient: () => ({
    getAppList: (...args: unknown[]) => mockGetAppListApi(...args),
    getManifest: (...args: unknown[]) => mockGetManifestApi(...args),
  }),
  getScopedEndpointPrefix: jest.fn(),
  resolveCredentials: () => ({ instance: "", user: "", password: "", profile: undefined }),
  setActiveInstanceProfile: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  clearStoredCredentialsCache: jest.fn(),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
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
      if (targetPath === "/tmp/project/.env") {
        return { isFile: () => true };
      }
      throw enoent;
    });

    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    mockGetAppListApi.mockResolvedValue({
      data: {
        result: [
          { sys_id: "1", scope: "x_alpha", displayName: "Alpha" },
          { sys_id: "2", scope: "x_beta", displayName: "Beta" },
          { sys_id: "3", scope: "global", displayName: "Global" },
        ],
      },
    });

    mockGetManifestApi.mockImplementation(async (scope: string) => ({
      data: {
        result: {
          scope,
          tables: {
            sys_script_include: {
              records: {
                [`Rec-${scope}`]: {
                  sys_id: `id-${scope}`,
                  name: `Rec-${scope}`,
                  files: [{ name: "script", type: "js", content: "gs.info('ok');" }],
                },
              },
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
    expect(mockGetManifestApi).toHaveBeenCalledTimes(2);
    expect(mockGetManifestApi).toHaveBeenNthCalledWith(
      1,
      "x_alpha",
      { includes: {}, excludes: {}, tableOptions: {} }
    );
    expect(mockGetManifestApi).toHaveBeenNthCalledWith(
      2,
      "x_beta",
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
    expect(mockGetManifestApi).not.toHaveBeenCalled();
    expect(mockProcessManifest).not.toHaveBeenCalled();
  });

  it("dry-run reports the plan without creating or downloading (DX4)", async () => {
    const { initCommand } = await import("../commands.js");

    await initCommand({ logLevel: "info", dryRun: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockGetManifestApi).not.toHaveBeenCalled();
  });
});
