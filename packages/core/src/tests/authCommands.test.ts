export {};

const mockSaveCredentials = jest.fn();
const mockLoadCredentials = jest.fn();
const mockListInstances = jest.fn();
const mockRemoveCredentials = jest.fn();
const mockRemoveAllCredentials = jest.fn();
const mockSetActiveInstance = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockPreloadStoredCredentials = jest.fn();
const mockClearStoredCredentialsCache = jest.fn();
const mockCheckConnection = jest.fn();
const mockPrompt = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockFsStat = jest.fn();
const mockFsWriteFile = jest.fn();
const mockFsMkdir = jest.fn();

jest.mock("fs", () => ({
  promises: {
    stat: (...args: unknown[]) => mockFsStat(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
  },
}));

jest.mock("../auth", () => ({
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
  loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
  listInstances: (...args: unknown[]) => mockListInstances(...args),
  removeCredentials: (...args: unknown[]) => mockRemoveCredentials(...args),
  removeAllCredentials: (...args: unknown[]) => mockRemoveAllCredentials(...args),
  setActiveInstance: (...args: unknown[]) => mockSetActiveInstance(...args),
  getActiveInstance: (...args: unknown[]) => mockGetActiveInstance(...args),
}));

jest.mock("../snClient", () => ({
  defaultClient: jest.fn(() => ({ checkConnection: mockCheckConnection })),
  resolveCredentials: jest.fn(() => ({ instance: "", user: "", password: "" })),
  setActiveInstanceProfile: jest.fn(),
  unwrapSNResponse: jest.fn(),
  preloadStoredCredentials: (...args: unknown[]) => mockPreloadStoredCredentials(...args),
  clearStoredCredentialsCache: (...args: unknown[]) => mockClearStoredCredentialsCache(...args),
  snClient: jest.fn(() => ({ checkConnection: mockCheckConnection })),
}));

jest.mock("../Logger", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: (...args: unknown[]) => mockLoggerSuccess(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: jest.fn(),
    silly: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.mock("../config", () => ({
  loadConfigs: jest.fn(),
  getConfig: jest.fn(() => ({})),
  getDefaultConfigFile: jest.fn(() => "module.exports = { sourceDirectory: 'src' };"),
  getSourcePath: jest.fn(() => "/src"),
  getBuildPath: jest.fn(() => "/build"),
  getManifestPath: jest.fn(() => "/sync.manifest.json"),
  getEnvPath: jest.fn(() => "/.env"),
  checkConfigPath: jest.fn(() => false),
  getRefresh: jest.fn(() => 0),
  getDiffFile: jest.fn(() => ({ changed: [] })),
  getRootDir: jest.fn(() => "/"),
  updateManifest: jest.fn(),
}));

jest.mock("../Watcher", () => ({ startWatching: jest.fn() }));
jest.mock("../appUtils", () => ({
  checkScope: jest.fn(),
  getAppFileList: jest.fn(),
  pushFiles: jest.fn(),
  buildFiles: jest.fn(),
  syncManifest: jest.fn(),
}));
jest.mock("../gitUtils", () => ({ gitDiffToEncodedPaths: jest.fn() }));
jest.mock("../FileUtils", () => ({ encodedPathsToFilePaths: jest.fn() }));
jest.mock("../wizard", () => ({ startWizard: jest.fn() }));
jest.mock("../logMessages", () => ({
  scopeCheckMessage: jest.fn(),
  devModeLog: jest.fn(),
  logPushResults: jest.fn(),
  logBuildResults: jest.fn(),
}));
jest.mock("inquirer", () => ({ prompt: (...args: unknown[]) => mockPrompt(...args) }));

import {
  loginCommand,
  logoutCommand,
  instancesCommand,
  useCommand,
} from "../authCommands";

const BASE_ARGS = { logLevel: "info", dryRun: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockPreloadStoredCredentials.mockResolvedValue(undefined);
  mockSetActiveInstance.mockResolvedValue(undefined);
  mockGetActiveInstance.mockResolvedValue(null);
  mockSaveCredentials.mockResolvedValue(undefined);
  mockRemoveCredentials.mockResolvedValue(undefined);
  mockRemoveAllCredentials.mockResolvedValue(2);
  mockListInstances.mockResolvedValue([]);
  mockCheckConnection.mockResolvedValue(undefined);
  mockFsStat.mockResolvedValue({});
  mockFsWriteFile.mockResolvedValue(undefined);
  mockFsMkdir.mockResolvedValue(undefined);
});

describe("loginCommand", () => {
  it("saves credentials and sets active instance when no active exists", async () => {
    mockPrompt
      .mockResolvedValueOnce({ user: "admin" })
      .mockResolvedValueOnce({ password: "secret" });

    await loginCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    expect(mockSaveCredentials).toHaveBeenCalledWith(
      "dev123.service-now.com",
      "admin",
      "secret"
    );
    expect(mockSetActiveInstance).toHaveBeenCalledWith("dev123.service-now.com");
    expect(mockPreloadStoredCredentials).toHaveBeenCalled();
    expect(mockFsMkdir).toHaveBeenCalled();
  });

  it("creates default workspace config when sync.config.js is missing", async () => {
    mockFsStat.mockRejectedValue({ code: "ENOENT" });
    mockPrompt
      .mockResolvedValueOnce({ user: "admin" })
      .mockResolvedValueOnce({ password: "secret" });

    await loginCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    expect(mockFsStat).toHaveBeenCalledWith(expect.stringContaining("sync.config.js"));
    expect(mockFsWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("sync.config.js"),
      expect.stringContaining("sourceDirectory"),
      "utf8"
    );
    expect(mockFsMkdir).toHaveBeenCalledWith(expect.stringContaining("/src"), { recursive: true });
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Created default sync.config.js"));
  });

  it("strips https:// prefix from instance URL", async () => {
    mockPrompt
      .mockResolvedValueOnce({ user: "admin" })
      .mockResolvedValueOnce({ password: "pass" });

    await loginCommand({ ...BASE_ARGS, instance: "https://dev999.service-now.com/" });

    expect(mockSaveCredentials).toHaveBeenCalledWith(
      "dev999.service-now.com",
      "admin",
      "pass"
    );
  });

  it("does not prompt for switch when already active instance matches", async () => {
    mockGetActiveInstance.mockResolvedValue("dev123.service-now.com");
    mockPrompt
      .mockResolvedValueOnce({ user: "admin" })
      .mockResolvedValueOnce({ password: "secret" });

    await loginCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    // No switch prompt — prompt only called twice (user + password)
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  it("prompts to switch active instance when different instance is already active", async () => {
    mockGetActiveInstance.mockResolvedValue("prod.service-now.com");
    mockPrompt
      .mockResolvedValueOnce({ user: "admin" })
      .mockResolvedValueOnce({ password: "secret" })
      .mockResolvedValueOnce({ switchActive: true });

    await loginCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    expect(mockSetActiveInstance).toHaveBeenCalledWith("dev123.service-now.com");
  });
});

describe("logoutCommand", () => {
  it("removes credentials for specified instance", async () => {
    await logoutCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    expect(mockRemoveCredentials).toHaveBeenCalledWith("dev123.service-now.com");
    expect(mockClearStoredCredentialsCache).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalled();
  });

  it("removes all credentials when --all flag is set", async () => {
    await logoutCommand({ ...BASE_ARGS, all: true });

    expect(mockRemoveAllCredentials).toHaveBeenCalled();
    expect(mockClearStoredCredentialsCache).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(expect.stringContaining("2 instance(s)"));
  });

  it("exits with error when no instance specified and no --all", async () => {
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(logoutCommand({ ...BASE_ARGS })).rejects.toThrow("process.exit");
    expect(mockLoggerError).toHaveBeenCalled();

    mockExit.mockRestore();
  });

  it("resets active instance when logging out the active one", async () => {
    mockGetActiveInstance.mockResolvedValue("dev123.service-now.com");
    mockListInstances.mockResolvedValue(["staging.service-now.com"]);

    await logoutCommand({ ...BASE_ARGS, instance: "dev123.service-now.com" });

    expect(mockSetActiveInstance).toHaveBeenCalledWith("staging.service-now.com");
  });
});

describe("instancesCommand", () => {
  it("prints message when no instances are saved", async () => {
    mockListInstances.mockResolvedValue([]);

    await instancesCommand(BASE_ARGS);

    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("No saved instances"));
  });

  it("lists all instances and marks the active one", async () => {
    mockListInstances.mockResolvedValue(["dev.service-now.com", "prod.service-now.com"]);
    mockGetActiveInstance.mockResolvedValue("dev.service-now.com");

    await instancesCommand(BASE_ARGS);

    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("dev.service-now.com"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("(active)"));
  });
});

describe("useCommand", () => {
  it("sets active instance when it exists in the store", async () => {
    mockListInstances.mockResolvedValue(["dev.service-now.com"]);

    await useCommand({ ...BASE_ARGS, instance: "dev.service-now.com" });

    expect(mockSetActiveInstance).toHaveBeenCalledWith("dev.service-now.com");
    expect(mockPreloadStoredCredentials).toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalled();
  });

  it("exits with error when instance is not in the store", async () => {
    mockListInstances.mockResolvedValue([]);
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      useCommand({ ...BASE_ARGS, instance: "unknown.service-now.com" })
    ).rejects.toThrow("process.exit");

    expect(mockLoggerError).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("strips https:// prefix before checking the store", async () => {
    mockListInstances.mockResolvedValue(["dev.service-now.com"]);

    await useCommand({ ...BASE_ARGS, instance: "https://dev.service-now.com" });

    expect(mockSetActiveInstance).toHaveBeenCalledWith("dev.service-now.com");
  });
});
