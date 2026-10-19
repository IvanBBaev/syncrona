// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// Covers the startWizard branches wizard.test.ts does not reach: the empty-app
// manual-scope entry path, app-listing and download failures, the best-effort
// wizard doctor, the existing-manifest path, and the best-effort scope-docs
// catch.

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

const mockGetSessionScope = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();

const mockWriteDotEnv = jest.fn();
const mockEnsureGitignored = jest.fn();
const mockGenerateScopeDocs = jest.fn();

const mockFsAccess = jest.fn();

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...a: unknown[]) => mockPrompt(...a) },
}));

// fs is a CJS core module; spread the real surface and override only the
// promises members these branch tests drive, so callers doing `import fs from
// "fs"` (default) or a named import still link while disk writes stay mocked.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    writeFile: jest.fn(async () => undefined),
    access: (...a: unknown[]) => mockFsAccess(...a),
    mkdir: jest.fn(async () => undefined),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("../config.js", () => ({
  getEnvPath: (...a: unknown[]) => mockGetEnvPath(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  getDefaultConfigFile: (...a: unknown[]) => mockGetDefaultConfigFile(...a),
  checkConfigPath: (...a: unknown[]) => mockCheckConfigPath(...a),
  getConfigPath: (...a: unknown[]) => mockGetConfigPath(...a),
  loadConfigs: (...a: unknown[]) => mockLoadConfigs(...a),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
  applyRecordSecretRulesToContent: async () => undefined,
}));

jest.unstable_mockModule("../auth.js", () => ({
  saveCredentials: (...a: unknown[]) => mockSaveCredentials(...a),
  setActiveInstance: (...a: unknown[]) => mockSetActiveInstance(...a),
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
  resolveCredentialsFromStore: (...a: unknown[]) => mockResolveCredentialsFromStore(...a),
}));

jest.unstable_mockModule("../envFile.js", () => ({
  writeDotEnv: (...a: unknown[]) => mockWriteDotEnv(...a),
  ensureGitignored: (...a: unknown[]) => mockEnsureGitignored(...a),
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
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

jest.unstable_mockModule("../snClient.js", () => ({
  buildClientAuth: () => ({}),
  credentialsFromStore: (stored: unknown) => stored,
  // #48: the wizard must download the scope with the SAME store-backed client it
  // used to LIST the apps (built from the just-saved credentials), not a fresh
  // defaultClient() that prefers ambient SN_* env vars.
  snClient: jest.fn(() => ({
    getSessionScope: (...a: unknown[]) => mockGetSessionScope(...a),
  })),
  defaultClient: jest.fn(() => ({})),
  preloadStoredCredentials: jest.fn(async () => undefined),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: (...a: unknown[]) => mockListAppsFromTableAPI(...a),
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
    mockGetSessionScope.mockResolvedValue({ scope: "x_demo", sys_id: "scope-1" });
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  it("returns early when no apps are found and the user declines manual entry", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ tryManual: false });
    mockListAppsFromTableAPI.mockResolvedValueOnce([]);

    const { startWizard } = await import("../wizard.js");
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
    mockListAppsFromTableAPI.mockResolvedValueOnce([]);
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(oneFileManifest("x_manual_app"));

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "No scoped apps were found on this instance."
    );
    expect(mockProcessManifest).toHaveBeenCalled();
  });

  it("reuses an existing local manifest instead of downloading", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockGenerateScopeDocs).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("fails the workspace setup when downloading the app throws", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]);
    mockProcessManifest.mockRejectedValueOnce(new Error("write to disk failed"));

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockLoggerError).toHaveBeenCalledWith("write to disk failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
    );
  });

  it("reports a non-Error wizard-doctor failure as a warning and still completes", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);
    mockGetSessionScope.mockRejectedValueOnce("preference unreadable");

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Wizard doctor: could not read the session scope (preference unreadable)."
    );
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("warns but continues when scope-doc generation fails", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockGenerateScopeDocs.mockRejectedValueOnce(new Error("doc render failed"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);

    const { startWizard } = await import("../wizard.js");
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
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith("Generating config...");
    expect(mockGetDefaultConfigFile).toHaveBeenCalled();
  });

  it("fails the setup when listing apps throws", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockRejectedValueOnce(new Error("sys_app read refused"));

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(false);

    expect(mockWriteDotEnv).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith("sys_app read refused");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
    );
  });

  it("returns when the app selection prompt yields no app", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "" }); // showAppList -> no selection
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockGenerateScopeDocs).not.toHaveBeenCalled();
  });

  it("fails when the active profile is missing required credential fields", async () => {
    mockResolveCredentialsFromStore.mockResolvedValue({ instance: "dev123.service-now.com" });

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
    );
  });

  it("treats config as absent when the config path is not accessible", async () => {
    mockFsAccess.mockRejectedValueOnce(new Error("ENOENT")); // checkConfig access fails
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockLoggerInfo).toHaveBeenCalledWith("Generating config...");
  });

  it("falls back to a cwd .env path when getEnvPath is unavailable", async () => {
    mockGetEnvPath.mockImplementationOnce(() => {
      throw new Error("no project root");
    });
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }]);

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockWriteDotEnv).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith("1 files ready. Open Claude and start coding.");
  });

  it("fails the download when the Table API manifest build throws", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ app: "x_demo" });
    mockListAppsFromTableAPI.mockResolvedValueOnce([{ scope: "x_demo", displayName: "Demo" }]);
    mockBuildManifestFromTableAPI.mockRejectedValueOnce({ response: { status: 500 } });

    const { startWizard } = await import("../wizard.js");
    await startWizard();

    expect(mockProcessManifest).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith("[object Object]");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
    );
  });
});

describe("downloadApp (init --new binding)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({});
    mockProcessManifest.mockResolvedValue(undefined);
  });

  it("stamps the new application's sys_id into the manifest it writes", async () => {
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(oneFileManifest("x_acme_app"));
    const client = {};
    const { downloadApp } = await import("../wizard.js");
    const man = await downloadApp("x_acme_app", client as never, { scopeId: "app-sys-id-1" });
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith("x_acme_app", client, {}, {
      allowEmpty: false,
    });
    expect(man).toMatchObject({ scope: "x_acme_app", scopeId: "app-sys-id-1" });
    expect(mockProcessManifest).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "x_acme_app", scopeId: "app-sys-id-1" })
    );
  });

  it("leaves scopeId off when none is given", async () => {
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(oneFileManifest("x_acme_app"));
    const { downloadApp } = await import("../wizard.js");
    const man = await downloadApp("x_acme_app", {} as never);
    expect(man).not.toHaveProperty("scopeId");
  });
});
