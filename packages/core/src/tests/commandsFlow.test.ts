import os from "os";
import path from "path";

export {};

const mockStartWatching = jest.fn();
const mockCheckScope = jest.fn();
const mockGetAppFileList = jest.fn();
const mockPushFiles = jest.fn();
const mockSetLogLevel = jest.fn();
const mockLogPushResults = jest.fn();
const mockLogBuildResults = jest.fn();
const mockDevModeLog = jest.fn();
const mockPrompt = jest.fn();
const mockGetSourcePath = jest.fn();
const mockGetRefresh = jest.fn();
const mockGetDiffFile = jest.fn();
const mockGetBuildPath = jest.fn();
const mockBuildFiles = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();
const mockCheckConnection = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockResolveCredentials = jest.fn();
const mockGetScopedEndpointPrefix = jest.fn();
const mockSetActiveInstanceProfile = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockSpawn = jest.fn();
const mockCheckConfigPath = jest.fn();
const mockGetBuildPathConfig = jest.fn();
const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const mockGetRootDir = jest.fn();

jest.mock("../Watcher", () => ({
  startWatching: (...args: unknown[]) => mockStartWatching(...args),
}));

jest.mock("../appUtils", () => ({
  checkScope: (...args: unknown[]) => mockCheckScope(...args),
  getAppFileList: (...args: unknown[]) => mockGetAppFileList(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
  buildFiles: (...args: unknown[]) => mockBuildFiles(...args),
}));

jest.mock("../gitUtils", () => ({
  gitDiffToEncodedPaths: (...args: unknown[]) => mockGitDiffToEncodedPaths(...args),
}));

jest.mock("../Logger", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    silly: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

// statusCommand inspects the credential store (DX20/DX20b); keep it hermetic.
jest.mock("../auth", () => ({
  getActiveInstance: jest.fn().mockResolvedValue(null),
  listInstances: jest.fn().mockResolvedValue([]),
  loadCredentials: jest.fn().mockResolvedValue({}),
}));

jest.mock("../snClient", () => ({
  defaultClient: () => ({
    checkConnection: (...args: unknown[]) => mockCheckConnection(...args),
    getCurrentScope: jest.fn(),
  }),
  unwrapSNResponse: (...args: unknown[]) => mockUnwrapSNResponse(...args),
  resolveCredentials: (...args: unknown[]) => mockResolveCredentials(...args),
  describeCredentialSource: () => "environment (.env / shell SN_* vars)",
  getScopedEndpointPrefix: (...args: unknown[]) => mockGetScopedEndpointPrefix(...args),
  setActiveInstanceProfile: (...args: unknown[]) => mockSetActiveInstanceProfile(...args),
}));

jest.mock("../logMessages", () => ({
  scopeCheckMessage: jest.fn(),
  devModeLog: (...args: unknown[]) => mockDevModeLog(...args),
  logPushResults: (...args: unknown[]) => mockLogPushResults(...args),
  logBuildResults: (...args: unknown[]) => mockLogBuildResults(...args),
}));

jest.mock("../config", () => ({
  getSourcePath: (...args: unknown[]) => mockGetSourcePath(...args),
  getRefresh: (...args: unknown[]) => mockGetRefresh(...args),
  getDiffFile: (...args: unknown[]) => mockGetDiffFile(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  getRootDir: (...args: unknown[]) => mockGetRootDir(...args),
  getBuildPath: (...args: unknown[]) => {
    const override = mockGetBuildPathConfig(...args);
    if (override !== undefined) {
      return override;
    }
    return mockGetBuildPath(...args);
  },
  checkConfigPath: (...args: unknown[]) => mockCheckConfigPath(...args),
}));

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../FileUtils", () => ({
  encodedPathsToFilePaths: (...args: unknown[]) => mockEncodedPathsToFilePaths(...args),
}));

jest.mock("fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
}));

jest.mock("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

describe("command flows", () => {
  const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckScope.mockResolvedValue({ match: true });
    mockGetSourcePath.mockReturnValue("/tmp/src");
    mockGetRefresh.mockReturnValue(0);
    mockGetDiffFile.mockReturnValue({ changed: [] });
    mockGetConfig.mockReturnValue({});
    mockGetRootDir.mockReturnValue("/tmp/project");
    mockGetBuildPath.mockReturnValue("encoded-build-path");
    mockGetBuildPathConfig.mockReturnValue(undefined);
    mockCheckConfigPath.mockReturnValue("/tmp/sync.config.js");
    mockEncodedPathsToFilePaths.mockResolvedValue(["/tmp/a.js", "/tmp/b.js"]);
    mockGitDiffToEncodedPaths.mockResolvedValue([]);
    mockBuildFiles.mockResolvedValue([]);
    mockPrompt.mockResolvedValue({ confirmed: true });
    mockCheckConnection.mockResolvedValue(undefined);
    mockUnwrapSNResponse.mockResolvedValue({ scope: "x_test" });
    mockResolveCredentials.mockImplementation(() => ({
      instance: process.env.SN_INSTANCE || "",
      user: process.env.SN_USER || "",
      password: process.env.SN_PASSWORD || "",
      profile: undefined,
    }));
    mockGetScopedEndpointPrefix.mockReturnValue("x_nuvo_sinc");
    mockLoggerWarn.mockReset();
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(enoent);
    mockStat.mockRejectedValue(enoent);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockSpawn.mockImplementation(() => ({
      once: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => cb(0));
        }
        return undefined;
      },
    }));
  });

  it("devCommand starts watcher when scope matches", async () => {
    const { devCommand } = await import("../devCommands");

    await devCommand({ logLevel: "info" });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockCheckScope).toHaveBeenCalledWith(false);
    expect(mockStartWatching).toHaveBeenCalledWith("/tmp/src");
    expect(mockDevModeLog).toHaveBeenCalledTimes(1);
  });

  it("pushCommand processes target paths and logs push results", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    const pushResults = [{ success: true, message: "ok" }];

    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPushFiles.mockResolvedValue(pushResults);

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockCheckScope).toHaveBeenCalledWith(false);
    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockGetAppFileList).toHaveBeenCalledWith("encoded:/tmp/a.js");
    expect(mockPushFiles).toHaveBeenCalledWith(appFileList);
    expect(mockLogPushResults).toHaveBeenCalledWith(pushResults);
    expect(mockWriteFile).toHaveBeenCalledTimes(3);
    expect(mockUnlink).toHaveBeenCalledTimes(2);

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand aborts when active collaboration lock is detected", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
    const eexist = Object.assign(new Error("exists"), { code: "EEXIST" });
    // 1st read: checkpoint (missing); atomic lock create fails with EEXIST;
    // 2nd read: the active lock owned by another process.
    mockReadFile.mockRejectedValueOnce(enoent);
    mockWriteFile.mockRejectedValueOnce(eexist);
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        command: "push",
        pid: 4242,
        createdAt: new Date().toISOString(),
      })
    );

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand replaces a stale collaboration lock and proceeds", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
    const eexist = Object.assign(new Error("exists"), { code: "EEXIST" });
    // checkpoint missing; first atomic create hits a leftover lock file that
    // is stale (>30min old), which gets removed before the retry succeeds.
    mockReadFile.mockRejectedValueOnce(enoent);
    mockWriteFile.mockRejectedValueOnce(eexist);
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        command: "push",
        pid: 4242,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })
    );

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockPushFiles).toHaveBeenCalledTimes(1);

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand leaves no checkpoint when the confirmation prompt is declined", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPrompt.mockResolvedValueOnce({ confirmed: false });

    await pushCommand({
      logLevel: "info",
      ci: false,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockPushFiles).not.toHaveBeenCalled();
    // Only the lock file is written (and released); no checkpoint state may
    // survive a declined prompt.
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(String(mockWriteFile.mock.calls[0][0])).toContain("sync.collaboration.lock.json");
    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(String(mockUnlink.mock.calls[0][0])).toContain("sync.collaboration.lock.json");

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand releases the collaboration lock when the push fails", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    const oldExitCode = process.exitCode;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPushFiles.mockRejectedValue(new Error("network died"));

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(process.exitCode).toBe(1);
    const unlinkedPaths = mockUnlink.mock.calls.map((call) => String(call[0]));
    expect(
      unlinkedPaths.some((p) => p.includes("sync.collaboration.lock.json"))
    ).toBe(true);

    process.exitCode = oldExitCode;
    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand dry-run skips checkpoint writes and remote push", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
      dryRun: true,
    });

    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand resumes only failed records from checkpoint", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { pushCommand } = await import("../commands");
    const appFileList = [
      { table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } },
      { table: "sys_script", sysId: "2", fields: { script: { filePath: "/tmp/b.js" } } },
    ];
    const pushResults = [{ success: false, message: "failed" }];

    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPushFiles.mockResolvedValue(pushResults);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        attempted: ["sys_script:1", "sys_script:2"],
        succeeded: ["sys_script:1"],
        failed: ["sys_script:2"],
      })
    );

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockPushFiles).toHaveBeenCalledWith([
      { table: "sys_script", sysId: "2", fields: { script: { filePath: "/tmp/b.js" } } },
    ]);

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand exits early with clear message when connection preflight fails", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";
    mockCheckConnection.mockRejectedValue(new Error("offline"));

    const { pushCommand } = await import("../commands");

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Unable to reach ServiceNow instance before push. Check SN_INSTANCE/SN_USER/SN_PASSWORD and network connectivity."
    );
    expect(mockGetAppFileList).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("pushCommand exits early when no target server is configured", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    delete process.env.SN_INSTANCE;

    const { pushCommand } = await import("../commands");

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
    });

    expect(mockLoggerError).toHaveBeenCalledWith("No server configured for push!");
    expect(mockCheckConnection).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("deployCommand confirms and deploys resolved build paths", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { deployCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    const pushResults = [{ success: true, message: "ok" }];

    mockGetAppFileList.mockResolvedValue(appFileList);
    mockPushFiles.mockResolvedValue(pushResults);

    await deployCommand({ logLevel: "info" });
    await flushPromises();
    await flushPromises();

    expect(mockCheckScope).toHaveBeenCalledWith(false);
    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockEncodedPathsToFilePaths).toHaveBeenCalledWith("encoded-build-path");
    expect(mockGetAppFileList).toHaveBeenCalledWith(["/tmp/a.js", "/tmp/b.js"]);
    expect(mockPushFiles).toHaveBeenCalledWith(appFileList);
    expect(mockLogPushResults).toHaveBeenCalledWith(pushResults);

    process.env.SN_INSTANCE = oldInstance;
  });

  it("deployCommand dry-run resolves files but skips remote push", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "instance.service-now.com";

    const { deployCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);

    await deployCommand({ logLevel: "info", dryRun: true });
    await flushPromises();

    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockGetAppFileList).toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("deployCommand exits early when no target server is configured", async () => {
    const oldInstance = process.env.SN_INSTANCE;
    delete process.env.SN_INSTANCE;

    const { deployCommand } = await import("../commands");
    await deployCommand({ logLevel: "info" });

    expect(mockLoggerError).toHaveBeenCalledWith("No server configured for deploy!");
    expect(mockCheckConnection).not.toHaveBeenCalled();

    process.env.SN_INSTANCE = oldInstance;
  });

  it("buildCommand dry-run skips build output generation", async () => {
    const { buildCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];

    mockGitDiffToEncodedPaths.mockResolvedValue(["encoded:/tmp/a.js"]);
    mockGetAppFileList.mockResolvedValue(appFileList);

    await buildCommand({ logLevel: "info", diff: "", dryRun: true });

    expect(mockGetAppFileList).toHaveBeenCalledWith(["encoded:/tmp/a.js"]);
    expect(mockBuildFiles).not.toHaveBeenCalled();
  });

  it("buildCommand executes build pipeline when dry-run is disabled", async () => {
    const { buildCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    const buildResults = [{ success: true, message: "built" }];

    mockGitDiffToEncodedPaths.mockResolvedValue(["encoded:/tmp/a.js"]);
    mockGetAppFileList.mockResolvedValue(appFileList);
    mockBuildFiles.mockResolvedValue(buildResults);

    await buildCommand({ logLevel: "info", diff: "", dryRun: false });

    expect(mockBuildFiles).toHaveBeenCalledWith(appFileList);
    expect(mockLogBuildResults).toHaveBeenCalledWith(buildResults);
  });

  it("doctorCommand reports healthy diagnostics when config, env, and connectivity are valid", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    process.env.SN_INSTANCE = "instance.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "secret";
    mockGetSourcePath.mockReturnValue("/tmp/src");
    mockGetBuildPathConfig.mockReturnValue("/tmp/build");
    mockCheckConnection.mockResolvedValue(undefined);

    const { doctorCommand } = await import("../commands");
    const result = await doctorCommand({ logLevel: "info" });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(mockCheckConnection).toHaveBeenCalledWith(5000);

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });

  it("pluginsCommand returns empty summary when no plugin rules are configured", async () => {
    const { pluginsCommand } = await import("../commands");
    mockGetConfig.mockReturnValue({ rules: [] });

    const result = await pluginsCommand({ logLevel: "info" });

    expect(result).toEqual({
      totalRules: 0,
      totalPlugins: 0,
      plugins: [],
    });
  });

  it("pluginsCommand reports installed and missing plugins", async () => {
    const { pluginsCommand } = await import("../commands");
    mockGetConfig.mockReturnValue({
      rules: [
        {
          match: /\\.ts$/,
          plugins: [
            { name: "@syncrona/typescript-plugin", options: {} },
            { name: "@syncrona/prettier-plugin", options: {} },
          ],
        },
        {
          match: /\\.js$/,
          plugins: [{ name: "@syncrona/typescript-plugin", options: {} }],
        },
      ],
    });
    mockStat.mockImplementation(async (candidatePath: string) => {
      if (candidatePath.includes("@syncrona/typescript-plugin")) {
        return { isDirectory: () => true };
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const result = await pluginsCommand({ logLevel: "info" });

    expect(result.totalRules).toBe(2);
    expect(result.totalPlugins).toBe(2);
    expect(result.plugins).toEqual([
      { name: "@syncrona/prettier-plugin", installed: false, rulesMatched: 1 },
      { name: "@syncrona/typescript-plugin", installed: true, rulesMatched: 2 },
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "plugin:@syncrona/prettier-plugin is configured but not installed in node_modules."
    );
  });

  it("mcpCommand auto-configures mcp client and secrets files", async () => {
    const { mcpCommand } = await import("../commands");
    mockResolveCredentials.mockReturnValue({
      instance: "dev.service-now.com",
      user: "dev-user",
      password: "dev-pass",
      profile: undefined,
    });
    mockStat.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === "/tmp/mcp/dist/index.js") {
        return { isFile: () => true };
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    await mcpCommand({
      logLevel: "info",
      autoConfigure: true,
      start: false,
      mcpServerPath: "/tmp/mcp/dist/index.js",
    });

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.vscode/mcp.json",
      expect.any(String),
      "utf8"
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.syncrona-mcp/secrets.json",
      expect.stringContaining("dev.service-now.com"),
      "utf8"
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.syncrona-mcp/secrets.json",
      expect.not.stringContaining("dev-pass"),
      "utf8"
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/project/.syncrona-mcp/secrets.json",
      expect.not.stringContaining("password"),
      "utf8"
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("mcpCommand updates discovered MCP client configs without removing existing entries", async () => {
    const { mcpCommand } = await import("../commands");
    const homeDir = os.homedir();
    const appData = process.env.APPDATA || "";

    let expectedPaths: string[] = [];
    if (process.platform === "darwin") {
      expectedPaths = [
        path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        path.join(homeDir, ".cursor", "mcp.json"),
      ];
    } else if (process.platform === "win32" && appData) {
      expectedPaths = [
        path.join(appData, "Claude", "claude_desktop_config.json"),
        path.join(appData, "Cursor", "mcp.json"),
      ];
    }

    mockResolveCredentials.mockReturnValue({
      instance: "dev.service-now.com",
      user: "dev-user",
      password: "dev-pass",
      profile: undefined,
    });

    mockStat.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === "/tmp/mcp/dist/index.js") {
        return { isFile: () => true };
      }
      if (expectedPaths.includes(candidatePath)) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    mockReadFile.mockImplementation(async (candidatePath: string) => {
      if (expectedPaths.includes(candidatePath)) {
        return JSON.stringify({
          mcpServers: {
            existing: {
              command: "node",
              args: ["/tmp/existing-server.js"],
            },
          },
        });
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    await mcpCommand({
      logLevel: "info",
      autoConfigure: true,
      start: false,
      mcpServerPath: "/tmp/mcp/dist/index.js",
    });

    for (const clientPath of expectedPaths) {
      const match = mockWriteFile.mock.calls.find((call) => call[0] === clientPath);
      expect(match).toBeDefined();
      const writtenConfig = JSON.parse(String(match?.[1] ?? "{}"));
      expect(writtenConfig.mcpServers?.existing).toBeDefined();
      expect(writtenConfig.mcpServers?.syncrona).toBeDefined();
      expect(writtenConfig.mcpServers?.syncrona?.args).toEqual(["/tmp/mcp/dist/index.js"]);
    }

  });

  it("mcpCommand requires login before start when credentials are missing", async () => {
    const { mcpCommand } = await import("../commands");
    mockResolveCredentials.mockReturnValue({
      instance: "",
      user: "",
      password: "",
      profile: undefined,
    });
    mockStat.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === "/tmp/mcp/dist/index.js") {
        return { isFile: () => true };
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    await mcpCommand({
      logLevel: "info",
      autoConfigure: true,
      start: true,
      mcpServerPath: "/tmp/mcp/dist/index.js",
    });

    expect(mockLoggerError).toHaveBeenCalledWith("Run syncrona login first.");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("doctorCommand reports issues when env vars are missing and connectivity is skipped", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    delete process.env.SN_INSTANCE;
    delete process.env.SN_USER;
    delete process.env.SN_PASSWORD;
    mockCheckConfigPath.mockReturnValue(false);

    const { doctorCommand } = await import("../commands");
    const result = await doctorCommand({ logLevel: "info" });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "env")?.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "connectivity")?.ok).toBe(false);
    expect(mockCheckConnection).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });

  it("statusCommand keeps connectivity healthy when scoped scope lookup returns 400", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    process.env.SN_INSTANCE = "instance.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "secret";
    mockCheckConfigPath.mockReturnValue("/tmp/project/sync.config.js");
    mockGetSourcePath.mockReturnValue("/tmp/src");
    mockGetBuildPathConfig.mockReturnValue("/tmp/build");
    mockGetManifest.mockReturnValue({ scope: "x_demo", tables: {} });
    mockCheckConnection.mockResolvedValue(undefined);
    mockUnwrapSNResponse.mockRejectedValue({ response: { status: 400 } });

    const { statusCommand } = await import("../commands");
    const result = await statusCommand({ logLevel: "info" });

    expect(result.connectivityOk).toBe(true);
    expect(result.scope).toBe("x_demo");
    expect(result.errors).toContain(
      "Scoped Syncrona API is unavailable on this instance. Using Table API compatibility mode; current session scope could not be verified."
    );

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });

  it("pushCommand resolves target server from instance profile credentials", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
      SN_INSTANCE_DEV: process.env.SN_INSTANCE_DEV,
      SN_USER_DEV: process.env.SN_USER_DEV,
      SN_PASSWORD_DEV: process.env.SN_PASSWORD_DEV,
    };

    delete process.env.SN_INSTANCE;
    delete process.env.SN_USER;
    delete process.env.SN_PASSWORD;
    process.env.SN_INSTANCE_DEV = "dev-instance.service-now.com";
    process.env.SN_USER_DEV = "dev-user";
    process.env.SN_PASSWORD_DEV = "dev-pass";

    mockResolveCredentials.mockImplementation((profile?: string) => {
      if (String(profile || "").toLowerCase() === "dev") {
        return {
          instance: process.env.SN_INSTANCE_DEV || "",
          user: process.env.SN_USER_DEV || "",
          password: process.env.SN_PASSWORD_DEV || "",
          profile: "DEV",
        };
      }

      return {
        instance: process.env.SN_INSTANCE || "",
        user: process.env.SN_USER || "",
        password: process.env.SN_PASSWORD || "",
        profile: undefined,
      };
    });

    const { pushCommand } = await import("../commands");
    const appFileList = [{ table: "sys_script", sysId: "1", fields: { script: { filePath: "/tmp/a.js" } } }];
    mockGetAppFileList.mockResolvedValue(appFileList);

    await pushCommand({
      logLevel: "info",
      ci: true,
      target: "encoded:/tmp/a.js",
      diff: "",
      scopeSwap: false,
      updateSet: "",
      instanceProfile: "dev",
    });

    expect(mockSetActiveInstanceProfile).toHaveBeenCalledWith("dev");
    expect(mockCheckConnection).toHaveBeenCalledWith(5000);
    expect(mockPushFiles).toHaveBeenCalled();

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
    process.env.SN_INSTANCE_DEV = oldEnv.SN_INSTANCE_DEV;
    process.env.SN_USER_DEV = oldEnv.SN_USER_DEV;
    process.env.SN_PASSWORD_DEV = oldEnv.SN_PASSWORD_DEV;
  });

  it("statusCommand uses instance profile credentials in summary", async () => {
    mockResolveCredentials.mockImplementation((profile?: string) => {
      if (String(profile || "").toLowerCase() === "qa") {
        return {
          instance: "qa-instance.service-now.com",
          user: "qa-user",
          password: "qa-pass",
          profile: "QA",
        };
      }
      return { instance: "", user: "", password: "", profile: undefined };
    });
    mockCheckConnection.mockResolvedValue(undefined);
    mockUnwrapSNResponse.mockResolvedValue({ scope: "x_qa" });

    const { statusCommand } = await import("../commands");
    const result = await statusCommand({ logLevel: "info", instanceProfile: "qa" });

    expect(result.ok).toBe(true);
    expect(result.instance).toBe("qa-instance.service-now.com");
    expect(result.user).toBe("qa-user");
    expect(result.scope).toBe("x_qa");
  });

  it("downloadCommand dry-run skips prompt and network calls", async () => {
    const { downloadCommand } = await import("../commands");

    await downloadCommand({ logLevel: "info", scope: "x_test", dryRun: true });

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("statusCommand returns extended status summary when env and connectivity are healthy", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    process.env.SN_INSTANCE = "instance.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "secret";
    mockCheckConfigPath.mockReturnValue("/tmp/sync.config.js");
    mockGetSourcePath.mockReturnValue("/tmp/src");
    mockGetBuildPathConfig.mockReturnValue("/tmp/build");
    mockCheckConnection.mockResolvedValue(undefined);
    mockUnwrapSNResponse.mockResolvedValue({ scope: "x_demo" });

    const { statusCommand } = await import("../commands");
    const result = await statusCommand({ logLevel: "info" });

    expect(result.ok).toBe(true);
    expect(result.instance).toBe("instance.service-now.com");
    expect(result.user).toBe("admin");
    expect(result.scope).toBe("x_demo");
    expect(result.envReady).toBe(true);
    expect(result.connectivityOk).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockCheckConnection).toHaveBeenCalledWith(5000);

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });

  it("statusCommand reports degraded summary when env is missing", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    delete process.env.SN_INSTANCE;
    delete process.env.SN_USER;
    delete process.env.SN_PASSWORD;
    mockCheckConfigPath.mockReturnValue(false);

    const { statusCommand } = await import("../commands");
    const result = await statusCommand({ logLevel: "info" });

    expect(result.ok).toBe(false);
    expect(result.scope).toBe("<unknown>");
    expect(result.envReady).toBe(false);
    expect(result.connectivityOk).toBe(false);
    expect(result.errors[0].includes("Missing environment variables")).toBe(true);
    expect(mockCheckConnection).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });

  it("statusCommand reports connectivity error when env exists but connection fails", async () => {
    const oldEnv = {
      SN_INSTANCE: process.env.SN_INSTANCE,
      SN_USER: process.env.SN_USER,
      SN_PASSWORD: process.env.SN_PASSWORD,
    };
    process.env.SN_INSTANCE = "instance.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "secret";
    mockCheckConnection.mockRejectedValue(new Error("offline"));

    const { statusCommand } = await import("../commands");
    const result = await statusCommand({ logLevel: "info" });

    expect(result.ok).toBe(false);
    expect(result.envReady).toBe(true);
    expect(result.connectivityOk).toBe(false);
    expect(result.errors.some((line) => line.includes("offline"))).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalled();

    process.env.SN_INSTANCE = oldEnv.SN_INSTANCE;
    process.env.SN_USER = oldEnv.SN_USER;
    process.env.SN_PASSWORD = oldEnv.SN_PASSWORD;
  });
});
