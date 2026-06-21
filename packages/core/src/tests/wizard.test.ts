export {};

const mockPrompt = jest.fn();
const mockWriteFile = jest.fn();
const mockAccess = jest.fn();
const mockMkdir = jest.fn();
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

const mockGetAppList = jest.fn();
const mockGetCurrentScope = jest.fn();
const mockGetManifestRemote = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();

jest.mock("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

jest.mock("fs", () => ({
  constants: { F_OK: 0 },
  promises: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
}));

jest.mock("../config", () => ({
  getEnvPath: (...args: unknown[]) => mockGetEnvPath(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getDefaultConfigFile: (...args: unknown[]) => mockGetDefaultConfigFile(...args),
  checkConfigPath: (...args: unknown[]) => mockCheckConfigPath(...args),
  getConfigPath: (...args: unknown[]) => mockGetConfigPath(...args),
  loadConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
}));

jest.mock("../appUtils", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
}));

jest.mock("../auth", () => ({
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
  setActiveInstance: (...args: unknown[]) => mockSetActiveInstance(...args),
  getActiveInstance: (...args: unknown[]) => mockGetActiveInstance(...args),
  resolveCredentialsFromStore: (...args: unknown[]) => mockResolveCredentialsFromStore(...args),
}));

jest.mock("../Logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: (...args: unknown[]) => mockLoggerSuccess(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
    setLogLevel: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.mock("../snClient", () => ({
  snClient: jest.fn(() => ({
    getAppList: (...args: unknown[]) => mockGetAppList(...args),
    getCurrentScope: (...args: unknown[]) => mockGetCurrentScope(...args),
  })),
  defaultClient: jest.fn(() => ({
    getManifest: (...args: unknown[]) => mockGetManifestRemote(...args),
  })),
  unwrapSNResponse: (...args: unknown[]) => mockUnwrapSNResponse(...args),
  preloadStoredCredentials: jest.fn(async () => undefined),
}));

jest.mock("../manifestBuilder", () => ({
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  listAppsFromTableAPI: (...args: unknown[]) => mockListAppsFromTableAPI(...args),
  isScopedEndpointUnavailableError: jest.fn((e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    "response" in e &&
    typeof (e as { response?: { status?: number } }).response?.status === "number" &&
    [400, 403, 404].includes((e as { response?: { status?: number } }).response?.status as number)
  ),
  isNotFoundError: jest.fn((e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    "response" in e &&
    typeof (e as { response?: { status?: number } }).response?.status === "number" &&
    (e as { response?: { status?: number } }).response?.status === 404
  ),
}));

describe("wizard", () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv };

    mockGetEnvPath.mockReturnValue("/tmp/project/.env");
    mockGetManifest.mockReturnValue({ scope: "x_existing" });
    mockGetConfig.mockReturnValue({});
    mockGetDefaultConfigFile.mockReturnValue("module.exports = {};");
    mockCheckConfigPath.mockReturnValue("/tmp/project/sync.config.js");
    mockGetConfigPath.mockReturnValue("/tmp/project/sync.config.js");
    mockLoadConfigs.mockResolvedValue(undefined);
    mockProcessManifest.mockResolvedValue(undefined);
    mockSaveCredentials.mockResolvedValue(undefined);
    mockSetActiveInstance.mockResolvedValue(undefined);
    mockGetActiveInstance.mockResolvedValue("dev123.service-now.com");
    mockResolveCredentialsFromStore.mockResolvedValue(null);
    mockWriteFile.mockResolvedValue(undefined);
    mockAccess.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockPrompt.mockResolvedValue({});
    mockUnwrapSNResponse.mockResolvedValue({});
    mockBuildManifestFromTableAPI.mockResolvedValue({
      scope: "x_demo",
      tables: {
        sys_script_include: {
          records: {
            "Include A": {
              sys_id: "1",
              name: "Include A",
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    });
    mockListAppsFromTableAPI.mockResolvedValue([]);
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  it("uses active CredentialStore credentials and prepares source directory", async () => {
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_app", displayName: "App" }])
      .mockResolvedValueOnce({ scope: "x_app" });

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockGetActiveInstance).toHaveBeenCalled();
    expect(mockSaveCredentials).toHaveBeenCalledWith(
      "dev123.service-now.com",
      "stored.user",
      "stored.pass"
    );
    expect(mockSetActiveInstance).toHaveBeenCalledWith("dev123.service-now.com");
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.env",
      expect.stringContaining("SN_INSTANCE=dev123.service-now.com"),
      expect.anything()
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.env",
      expect.stringContaining("SN_USER=stored.user"),
      expect.anything()
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Wizard doctor: connection OK")
    );
  });

  it("fails fast and asks for login when no active CredentialStore instance exists", async () => {
    mockGetActiveInstance.mockResolvedValue(null);

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "No active credentials profile found. Run 'syncro-now-ai login' first."
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
  });

  it("shows app choices with scope-first labels and optional table counts", async () => {
    mockGetManifest.mockReturnValue(undefined);
    mockCheckConfigPath.mockReturnValue(true);
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });

    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "custom-src" })
      .mockResolvedValueOnce({ app: "x_demo" });

    mockUnwrapSNResponse
      .mockResolvedValueOnce([
        { scope: "x_demo", displayName: "Demo App", tableCount: 47 },
        { scope: "x_tools", displayName: "Tools" },
      ])
      .mockResolvedValueOnce({
        scope: "x_demo",
        tables: {
          sys_script_include: {
            records: {
              "Demo Script": {
                sys_id: "1",
                name: "Demo Script",
                files: [
                  { name: "script", type: "js" },
                  { name: "meta", type: "xml" },
                ],
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({ scope: "x_demo" });

    const { startWizard } = await import("../wizard");
    await startWizard();

    const appPrompt = mockPrompt.mock.calls[1]?.[0]?.[0];
    expect(appPrompt?.type).toBe("list");
    expect(appPrompt?.choices?.[0]?.name).toBe("x_demo - Demo App, 47 tables");
    expect(appPrompt?.choices?.[1]?.name).toBe("x_tools - Tools");
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("custom-src"), { recursive: true });
    expect(mockLoggerInfo).toHaveBeenCalledWith("Downloading scope x_demo... 2 files");
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("100% (2/2)"));
    expect(mockLoggerSuccess).toHaveBeenCalledWith("2 files ready. Open Claude and start coding.");
  });

  it("falls back to Table API when custom manifest is empty", async () => {
    mockGetManifest.mockReturnValue(undefined);
    mockCheckConfigPath.mockReturnValue(true);
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });

    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });

    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo App" }])
      .mockResolvedValueOnce({ scope: "x_demo", tables: {} })
      .mockResolvedValueOnce({ scope: "x_demo" });

    mockBuildManifestFromTableAPI.mockResolvedValueOnce({
      scope: "x_demo",
      tables: {
        sys_script_include: {
          records: {
            "Demo Script": {
              sys_id: "1",
              name: "Demo Script",
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    });

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Custom endpoint returned empty manifest — building from Table API..."
    );
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_demo",
      expect.anything(),
      expect.anything()
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("continues wizard when scoped current-scope endpoint returns 400", async () => {
    mockGetManifest.mockReturnValue(undefined);
    mockCheckConfigPath.mockReturnValue(true);
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });

    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });

    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo App" }])
      .mockResolvedValueOnce({
        scope: "x_demo",
        tables: {
          sys_script_include: {
            records: {
              "Demo Script": {
                sys_id: "1",
                name: "Demo Script",
                files: [{ name: "script", type: "js" }],
              },
            },
          },
        },
      })
      .mockRejectedValueOnce({ response: { status: 400 } });

    const { startWizard } = await import("../wizard");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Wizard doctor: SyncroNow AI scoped API is unavailable on this instance. Continuing in Table API compatibility mode."
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });
});
