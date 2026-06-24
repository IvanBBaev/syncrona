// SPDX-License-Identifier: GPL-3.0-or-later
export {};

// Covers the startWizard branches wizard.test.ts does not reach: the getAppList
// scoped fallback, the empty-app manual-scope entry path, downloadApp Table-API
// fallback and failure, the non-scoped wizard-doctor rethrow, the existing-
// manifest path, and the best-effort scope-docs catch.

const mockPrompt = jest.fn();
const mockGetEnvPath = jest.fn();
const mockGetManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockGetDefaultConfigFile = jest.fn();
const mockCheckConfigPath = jest.fn();
const mockGetConfigPath = jest.fn();
const mockLoadConfigs = jest.fn();
const mockProcessManifest = jest.fn();
const mockSaveCredentials = jest.fn();
const mockSetActiveInstance = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockResolveCredentialsFromStore = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

const mockGetAppList = jest.fn();
const mockGetCurrentScope = jest.fn();
const mockGetManifestRemote = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();

const mockWriteDotEnv = jest.fn();
const mockEnsureGitignored = jest.fn();
const mockGenerateScopeDocs = jest.fn();

const mockFsAccess = jest.fn();

jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...a: unknown[]) => mockPrompt(...a) },
}));

jest.mock("fs", () => ({
  constants: { F_OK: 0 },
  promises: {
    writeFile: jest.fn(async () => undefined),
    access: (...a: unknown[]) => mockFsAccess(...a),
    mkdir: jest.fn(async () => undefined),
  },
}));

jest.mock("../config", () => ({
  getEnvPath: (...a: unknown[]) => mockGetEnvPath(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  getDefaultConfigFile: (...a: unknown[]) => mockGetDefaultConfigFile(...a),
  checkConfigPath: (...a: unknown[]) => mockCheckConfigPath(...a),
  getConfigPath: (...a: unknown[]) => mockGetConfigPath(...a),
  loadConfigs: (...a: unknown[]) => mockLoadConfigs(...a),
}));

jest.mock("../appUtils", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
}));

jest.mock("../auth", () => ({
  saveCredentials: (...a: unknown[]) => mockSaveCredentials(...a),
  setActiveInstance: (...a: unknown[]) => mockSetActiveInstance(...a),
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
  resolveCredentialsFromStore: (...a: unknown[]) => mockResolveCredentialsFromStore(...a),
}));

jest.mock("../envFile", () => ({
  writeDotEnv: (...a: unknown[]) => mockWriteDotEnv(...a),
  ensureGitignored: (...a: unknown[]) => mockEnsureGitignored(...a),
}));

jest.mock("../scopeDocs", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.mock("../Logger", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    debug: jest.fn(),
    silly: jest.fn(),
    setLogLevel: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.mock("../snClient", () => ({
  snClient: jest.fn(() => ({
    getAppList: (...a: unknown[]) => mockGetAppList(...a),
    getCurrentScope: (...a: unknown[]) => mockGetCurrentScope(...a),
  })),
  defaultClient: jest.fn(() => ({
    getManifest: (...a: unknown[]) => mockGetManifestRemote(...a),
  })),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
  preloadStoredCredentials: jest.fn(async () => undefined),
}));

jest.mock("../manifestBuilder", () => ({
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: (...a: unknown[]) => mockListAppsFromTableAPI(...a),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
  isNotFoundError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return (err?.response?.status as number) === 404;
  },
}));

const oneFileManifest = (scope: string) => ({
  scope,
  tables: {
    sys_script_include: {
      records: {
        "Include A": { sys_id: "1", name: "Include A", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

describe("startWizard branches", () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv };
    mockGetEnvPath.mockReturnValue("/tmp/project/.env");
    mockGetManifest.mockReturnValue(undefined);
    mockGetConfig.mockReturnValue({});
    mockGetDefaultConfigFile.mockReturnValue("module.exports = {};");
    mockCheckConfigPath.mockReturnValue("/tmp/project/sync.config.js");
    mockGetConfigPath.mockReturnValue("/tmp/project/sync.config.js");
    mockLoadConfigs.mockResolvedValue(undefined);
    mockProcessManifest.mockResolvedValue(undefined);
    mockSaveCredentials.mockResolvedValue(undefined);
    mockSetActiveInstance.mockResolvedValue(undefined);
    mockGetActiveInstance.mockResolvedValue("dev123.service-now.com");
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });
    mockWriteDotEnv.mockResolvedValue(undefined);
    mockEnsureGitignored.mockResolvedValue(undefined);
    mockGenerateScopeDocs.mockResolvedValue("/docs/scope.md");
    mockBuildManifestFromTableAPI.mockResolvedValue(oneFileManifest("x_demo"));
    mockListAppsFromTableAPI.mockResolvedValue([]);
    mockFsAccess.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  it("lists apps from the Table API when the scoped app list is unavailable", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } }); // getAppList
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]);
    mockUnwrapSNResponse
      .mockResolvedValueOnce(oneFileManifest("x_demo")) // downloadApp getManifest
      .mockResolvedValueOnce({ scope: "x_demo" }); // doctor getCurrentScope

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockListAppsFromTableAPI).toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalled();
  });

  it("returns early when no apps are found and the user declines manual entry", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ tryManual: false });
    mockUnwrapSNResponse.mockResolvedValueOnce([]); // getAppList -> empty
    mockListAppsFromTableAPI.mockResolvedValue([]); // still empty

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockWriteDotEnv).not.toHaveBeenCalled();
  });

  it("accepts a manually entered scope when no apps are discoverable", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ tryManual: true })
      .mockResolvedValueOnce({ manualScope: "x_manual_app" })
      .mockResolvedValueOnce({ app: "x_manual_app" });
    mockUnwrapSNResponse.mockResolvedValueOnce([]); // getAppList -> empty
    mockListAppsFromTableAPI.mockResolvedValue([]); // still empty
    mockUnwrapSNResponse
      .mockResolvedValueOnce(oneFileManifest("x_manual_app")) // downloadApp
      .mockResolvedValueOnce({ scope: "x_manual_app" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "No scoped apps were found on this instance."
    );
    expect(mockProcessManifest).toHaveBeenCalled();
  });

  it("reuses an existing local manifest instead of downloading", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockResolvedValueOnce({ scope: "x_existing" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockGenerateScopeDocs).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("builds the manifest from the Table API when the scoped manifest endpoint is missing", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockUnwrapSNResponse.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]); // getAppList
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } }); // downloadApp getManifest
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(oneFileManifest("x_demo"));
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "x_demo" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Custom scope not found — building manifest from Table API..."
    );
    expect(mockProcessManifest).toHaveBeenCalled();
  });

  it("fails the workspace setup when downloading the app throws", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockUnwrapSNResponse.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]); // getAppList
    mockUnwrapSNResponse.mockResolvedValueOnce(oneFileManifest("x_demo")); // downloadApp getManifest
    mockProcessManifest.mockRejectedValueOnce(new Error("write to disk failed"));

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerError).toHaveBeenCalledWith("write to disk failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });

  it("rethrows a non-scoped wizard-doctor error into the setup failure path", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockRejectedValueOnce({ response: { status: 500 } }); // doctor getCurrentScope

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });

  it("warns but continues when scope-doc generation fails", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockGenerateScopeDocs.mockRejectedValueOnce(new Error("doc render failed"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockResolvedValueOnce({ scope: "x_existing" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Could not generate scope documentation")
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("writes a default config when no config file is present", async () => {
    mockCheckConfigPath.mockReturnValue(false); // checkConfig -> false
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockResolvedValueOnce({ scope: "x_existing" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith("Generating config...");
    expect(mockGetDefaultConfigFile).toHaveBeenCalled();
  });

  it("rethrows a non-scoped failure while listing apps", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 500 } }); // getAppList

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockListAppsFromTableAPI).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });

  it("returns when the app selection prompt yields no app", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "" }); // showAppList -> no selection
    mockUnwrapSNResponse.mockResolvedValueOnce([
      { scope: "x_demo", displayName: "Demo" },
    ]); // getAppList

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockGenerateScopeDocs).not.toHaveBeenCalled();
  });

  it("fails when the active profile is missing required credential fields", async () => {
    mockResolveCredentialsFromStore.mockResolvedValue({ instance: "dev123.service-now.com" });

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });

  it("treats config as absent when the config path is not accessible", async () => {
    mockFsAccess.mockRejectedValueOnce(new Error("ENOENT")); // checkConfig access fails
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockResolvedValueOnce({ scope: "x_existing" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith("Generating config...");
  });

  it("falls back to a cwd .env path when getEnvPath is unavailable", async () => {
    mockGetEnvPath.mockImplementationOnce(() => {
      throw new Error("no project root");
    });
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]) // getAppList
      .mockResolvedValueOnce({ scope: "x_existing" }); // doctor

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockWriteDotEnv).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("fails the download when the manifest endpoint returns a non-scoped error", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockUnwrapSNResponse.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]); // getAppList
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 500 } }); // downloadApp getManifest (non-scoped)

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockBuildManifestFromTableAPI).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith("[object Object]");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });
});
