// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockPrompt = jest.fn();
const mockBuildClientAuth = jest.fn((creds: { clientId?: string }) =>
  creds.clientId ? { oauth: { clientId: creds.clientId } } : {}
);
const mockCredentialsFromStore = jest.fn((stored: unknown) => ({ mapped: stored }));
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
const mockLoggerWarn = jest.fn();

const mockGetSessionScope = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

// fs is a CJS core module; spread the real surface and override only the
// promises members the wizard drives, so callers doing `import fs from "fs"`
// (default) or a named import still link while disk writes stay mocked.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("../config.js", () => ({
  getEnvPath: (...args: unknown[]) => mockGetEnvPath(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getDefaultConfigFile: (...args: unknown[]) => mockGetDefaultConfigFile(...args),
  checkConfigPath: (...args: unknown[]) => mockCheckConfigPath(...args),
  getConfigPath: (...args: unknown[]) => mockGetConfigPath(...args),
  loadConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
  applyRecordSecretRulesToContent: async () => undefined,
}));

jest.unstable_mockModule("../auth.js", () => ({
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
  setActiveInstance: (...args: unknown[]) => mockSetActiveInstance(...args),
  getActiveInstance: (...args: unknown[]) => mockGetActiveInstance(...args),
  resolveCredentialsFromStore: (...args: unknown[]) => mockResolveCredentialsFromStore(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: (...args: unknown[]) => mockLoggerSuccess(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: jest.fn(),
    silly: jest.fn(),
    setLogLevel: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  // #48: the wizard lists apps, downloads and reads the session scope through
  // the store-backed snClient() instance it built, not defaultClient().
  snClient: jest.fn(() => ({
    getSessionScope: (...args: unknown[]) => mockGetSessionScope(...args),
  })),
  defaultClient: jest.fn(() => ({})),
  preloadStoredCredentials: jest.fn(async () => undefined),
  buildClientAuth: (creds: { mapped: { clientId?: string } }) => mockBuildClientAuth(creds.mapped),
  credentialsFromStore: (stored: unknown) => mockCredentialsFromStore(stored),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  listAppsFromTableAPI: (...args: unknown[]) => mockListAppsFromTableAPI(...args),
}));

describe("wizard", () => {
  const oldEnv = { ...process.env };
  const oldExitCode = process.exitCode;

  afterEach(() => {
    // startWizard now sets process.exitCode=1 on failure; don't let that leak
    // into the jest runner's own exit status.
    process.exitCode = oldExitCode;
  });

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
    mockGetSessionScope.mockResolvedValue({ scope: "x_demo", sys_id: "scope-1" });
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

  // Re-saving the profile with only instance/user/password used to drop every
  // other field `syncrona login` stored (OAuth client, API key, JWT), and the
  // app listing used Basic auth whatever method the profile selected.
  it("keeps the stored profile's auth fields and lists apps with its auth method", async () => {
    const stored = {
      instance: "https://dev123.service-now.com/",
      user: "stored.user",
      password: "stored.pass",
      authMethod: "oauth-password",
      clientId: "cid",
      clientSecret: "SECRET",
    };
    mockResolveCredentialsFromStore.mockResolvedValue(stored);
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_app", displayName: "App" }]);
    mockGetSessionScope.mockResolvedValueOnce({ scope: "x_app", sys_id: "scope-1" });

    const { startWizard } = await import("../wizard.js");
    const { snClient } = await import("../snClient.js");
    await startWizard();

    expect(mockSaveCredentials).toHaveBeenCalledWith(
      "dev123.service-now.com",
      "stored.user",
      "stored.pass",
      stored
    );
    expect(mockCredentialsFromStore).toHaveBeenCalledWith(stored);
    expect(snClient).toHaveBeenCalledWith(
      "https://dev123.service-now.com/",
      "stored.user",
      "stored.pass",
      { clientId: "cid" },
      undefined
    );
  });

  it("uses active CredentialStore credentials and prepares source directory", async () => {
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_app", displayName: "App" }]);
    mockGetSessionScope.mockResolvedValueOnce({ scope: "x_app", sys_id: "scope-1" });

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockGetActiveInstance).toHaveBeenCalled();
    expect(mockSaveCredentials).toHaveBeenCalledWith(
      "dev123.service-now.com",
      "stored.user",
      "stored.pass",
      expect.objectContaining({ user: "stored.user" })
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

  it("reloads the configs after generating sync.config.js, before downloading into the chosen source directory", async () => {
    mockGetManifest.mockReturnValue(undefined);
    mockCheckConfigPath.mockReturnValue(false);
    mockResolveCredentialsFromStore.mockResolvedValue({
      instance: "dev123.service-now.com",
      user: "stored.user",
      password: "stored.pass",
    });
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "custom-src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo App" }]);

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockGetDefaultConfigFile).toHaveBeenCalledWith("custom-src");
    const configWrite = mockWriteFile.mock.calls.findIndex(([p]) =>
      String(p).endsWith("sync.config.js")
    );
    expect(configWrite).toBeGreaterThanOrEqual(0);
    const writeOrder = mockWriteFile.mock.invocationCallOrder[configWrite];
    expect(mockLoadConfigs).toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalled();
    const reloadOrder = mockLoadConfigs.mock.invocationCallOrder[0];
    expect(reloadOrder).toBeGreaterThan(writeOrder);
    expect(reloadOrder).toBeLessThan(mockProcessManifest.mock.invocationCallOrder[0]);
  });

  it("fails fast and asks for login when no active CredentialStore instance exists", async () => {
    mockGetActiveInstance.mockResolvedValue(null);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "No active credentials profile found. Run 'syncrona login' first."
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
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

    mockListAppsFromTableAPI.mockResolvedValueOnce([
      { scope: "x_demo", displayName: "Demo App", tableCount: 47 },
      { scope: "x_tools", displayName: "Tools" },
    ]);
    mockBuildManifestFromTableAPI.mockResolvedValueOnce({
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
      });

    const { startWizard } = await import("../wizard.js");
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

  it("builds the manifest from the Table API with the empty-manifest refusal kept on", async () => {
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
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo App" }]);

    const { startWizard } = await import("../wizard.js");
    const { snClient } = await import("../snClient.js");
    await startWizard();

    // The interactive wizard binds an EXISTING scope, so the empty-manifest
    // refusal stays on: only `init --new` (justCreated) may lift it.
    const listingClient = (snClient as jest.Mock).mock.results[0]?.value;
    expect(mockListAppsFromTableAPI).toHaveBeenCalledWith(listingClient);
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_demo",
      listingClient,
      expect.anything(),
      { allowEmpty: false }
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("warns but completes when the session scope cannot be read", async () => {
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
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo App" }]);
    mockGetSessionScope.mockRejectedValueOnce(new Error("preference read refused"));

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Wizard doctor: could not read the session scope (preference read refused)."
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });
});
