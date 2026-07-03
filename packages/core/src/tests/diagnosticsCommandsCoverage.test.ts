// SPDX-License-Identifier: GPL-3.0-or-later
export {};

// Covers the diagnostics command branches the other suites miss: the
// countConfigRules/getConfig catch fallbacks, status credential diagnostics
// (`status --debug-credentials`) and the DX20b decrypt-warning path, the
// doctor source/build/connectivity failure branches, pluginsCommand's
// empty-name + getRootDir fallbacks, configCommand show-defaults / add-plugin,
// detectWsl, and the whole checkEnvCommand matrix (node/platform/git).
//
// Dependencies are mocked at module boundaries (config, Logger, snClient, auth,
// commandHelpers, child_process, fs) so the commands run offline and
// deterministically; pluginCatalog + manifestBuilder are left real (pure).

const mockSetLogLevel = jest.fn();
const mockLogScopedEndpointCapability = jest.fn();
const mockActiveStoreHealth = jest.fn();
const mockGetActiveStoreDecryptWarning = jest.fn();

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerSuccess = jest.fn();

const mockGetConfig = jest.fn();
const mockCheckConfigPath = jest.fn();
const mockGetSourcePath = jest.fn();
const mockGetBuildPath = jest.fn();
const mockGetManifestPath = jest.fn();
const mockGetManifest = jest.fn();
const mockGetRootDir = jest.fn();
const mockGetDefaultConfig = jest.fn();

const mockCheckConnection = jest.fn();
const mockGetCurrentScope = jest.fn();
const mockResolveCredentials = jest.fn();
const mockDescribeCredentialSource = jest.fn();
const mockDiagnoseCredentials = jest.fn();
const mockUnwrapSNResponse = jest.fn();

const mockListInstances = jest.fn();
const mockIsScopedUnavailable = jest.fn();

const mockExecFileSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock("../Logger", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    silly: jest.fn(),
  },
}));

jest.mock("../config", () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  checkConfigPath: (...a: unknown[]) => mockCheckConfigPath(...a),
  getSourcePath: (...a: unknown[]) => mockGetSourcePath(...a),
  getBuildPath: (...a: unknown[]) => mockGetBuildPath(...a),
  getManifestPath: (...a: unknown[]) => mockGetManifestPath(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getRootDir: (...a: unknown[]) => mockGetRootDir(...a),
  getDefaultConfig: (...a: unknown[]) => mockGetDefaultConfig(...a),
}));

jest.mock("../snClient", () => ({
  defaultClient: () => ({
    checkConnection: (...a: unknown[]) => mockCheckConnection(...a),
    getCurrentScope: (...a: unknown[]) => mockGetCurrentScope(...a),
  }),
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
  describeCredentialSource: (...a: unknown[]) => mockDescribeCredentialSource(...a),
  diagnoseCredentials: (...a: unknown[]) => mockDiagnoseCredentials(...a),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
}));

jest.mock("../auth", () => ({
  listInstances: (...a: unknown[]) => mockListInstances(...a),
}));

jest.mock("../manifestBuilder", () => ({
  isScopedEndpointUnavailableError: (...a: unknown[]) => mockIsScopedUnavailable(...a),
}));

jest.mock("../commandHelpers", () => ({
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  logScopedEndpointCapability: (...a: unknown[]) => mockLogScopedEndpointCapability(...a),
  activeStoreHealth: (...a: unknown[]) => mockActiveStoreHealth(...a),
  getActiveStoreDecryptWarning: (...a: unknown[]) => mockGetActiveStoreDecryptWarning(...a),
}));

jest.mock("child_process", () => ({
  execFileSync: (...a: unknown[]) => mockExecFileSync(...a),
}));

// The command imports readFileSync + promises from "fs". Keep the real promises
// API (used for node_modules stat probes against a real temp dir) but let
// readFileSync be a spyable mock for the detectWsl branch.
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  };
});

import os from "os";
import path from "path";
import { promises as fsp } from "fs";

// Reasonable, connection-succeeds defaults; each test overrides what it needs.
beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue({ includes: { a: {}, b: {} }, excludes: { c: {} }, rules: [] });
  mockCheckConfigPath.mockReturnValue("/proj/sync.config.js");
  mockGetSourcePath.mockReturnValue("/proj/src");
  mockGetBuildPath.mockReturnValue("/proj/build");
  mockGetManifestPath.mockReturnValue("/proj/sync.manifest.json");
  mockGetManifest.mockReturnValue({ scope: "x_manifest_scope" });
  mockGetRootDir.mockReturnValue("/proj");
  mockResolveCredentials.mockReturnValue({
    instance: "dev.service-now.com",
    user: "admin",
    password: "secret",
  });
  mockDescribeCredentialSource.mockReturnValue("environment (.env / shell SN_* vars)");
  mockCheckConnection.mockResolvedValue(undefined);
  mockGetCurrentScope.mockResolvedValue({ scope: "x_scope" });
  mockUnwrapSNResponse.mockImplementation((p: unknown) => p);
  mockIsScopedUnavailable.mockReturnValue(false);
  mockGetActiveStoreDecryptWarning.mockResolvedValue(null);
});

describe("statusCommand", () => {
  it("reports ok and the resolved scope on a healthy connection", async () => {
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.ok).toBe(true);
    expect(summary.connectivityOk).toBe(true);
    expect(summary.envReady).toBe(true);
    expect(summary.scope).toBe("x_scope");
    // countConfigRules reads the merged config (2 includes / 1 exclude).
    expect(summary.includeRules).toBe(2);
    expect(summary.excludeRules).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("handles a config with no includes/excludes and no discovered config path (lines 48-49, 76)", async () => {
    mockGetConfig.mockReturnValue({});
    mockCheckConfigPath.mockReturnValue("");
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.includeRules).toBe(0);
    expect(summary.excludeRules).toBe(0);
    expect(summary.configPath).toBe("<not found>");
  });

  it("falls back to <unknown> when the resolved scope is empty (line 113)", async () => {
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "" });
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.scope).toBe("<unknown>");
  });

  it("falls back to <unknown> when the manifest scope is empty in Table-API mode (line 117)", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce(new Error("404 not found"));
    mockIsScopedUnavailable.mockReturnValue(true);
    mockGetManifest.mockReturnValue({ scope: "" });
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.scope).toBe("<unknown>");
  });

  it("falls back to zero rule counts when getConfig throws (line 52)", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("config unreadable");
    });
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.includeRules).toBe(0);
    expect(summary.excludeRules).toBe(0);
  });

  it("degrades to Table-API mode and records a warning when the scoped scope endpoint is unavailable", async () => {
    // Only the unwrap rejects; getCurrentScope() itself resolves so there is no
    // stray unhandled rejection that could bleed into a later test.
    mockUnwrapSNResponse.mockRejectedValueOnce(new Error("404 not found"));
    mockIsScopedUnavailable.mockReturnValue(true);
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.scope).toBe("x_manifest_scope");
    expect(summary.errors[0]).toContain("Scoped SyncroNow AI API is unavailable");
    // Connectivity itself succeeded — only the scope lookup degraded.
    expect(summary.connectivityOk).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it("rethrows a non-scoped scope error and records it as a connection failure (line 122)", async () => {
    mockUnwrapSNResponse.mockRejectedValueOnce(new Error("boom deep in scope"));
    mockIsScopedUnavailable.mockReturnValue(false);
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    // connectivityOk was already set true before the scope lookup ran, so the
    // rethrow into the outer catch only appends an error — it does not reset it.
    expect(summary.connectivityOk).toBe(true);
    expect(summary.errors.some((e) => e.includes("boom deep in scope"))).toBe(true);
  });

  it("reports a bare connection-failure message when the error has no text", async () => {
    mockCheckConnection.mockRejectedValue(new Error("   "));
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.connectivityOk).toBe(false);
    expect(summary.errors).toContain("Unable to connect to ServiceNow instance.");
  });

  it("appends the DX20b decrypt warning when env is missing and a stored instance won't decrypt (line 138)", async () => {
    mockResolveCredentials.mockReturnValue({ instance: "", user: "", password: "" });
    mockGetActiveStoreDecryptWarning.mockResolvedValue(
      'Active stored instance "old.service-now.com" failed to decrypt.'
    );
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.envReady).toBe(false);
    expect(summary.errors[0]).toContain("Missing environment variables");
    expect(summary.errors[1]).toContain("failed to decrypt");
    // Connectivity is skipped entirely when env is not ready.
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });

  it("prints credential diagnostics when --debug-credentials is set (lines 176, 185-222)", async () => {
    mockDiagnoseCredentials.mockReturnValue({
      baseEnvPresent: { instance: true, user: true, password: false },
      profile: "DEV",
      profileEnvPresent: { instance: true, user: false, password: false },
      source: "instance profile env vars",
      resolvedInstance: "dev.service-now.com",
      resolvedUser: "admin",
    });
    mockListInstances.mockResolvedValue(["dev.service-now.com", "prod.service-now.com"]);
    mockActiveStoreHealth.mockResolvedValue({
      active: "dev.service-now.com",
      decrypts: true,
    });
    const { statusCommand } = await import("../diagnosticsCommands");
    await statusCommand({ logLevel: "info", debugCredentials: true } as never);
    expect(mockDiagnoseCredentials).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith("--- credential diagnostics ---");
    // Profile block rendered (diag.profile + profileEnvPresent both present).
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining('Profile "DEV" env'));
    // Store block: 2 stored instances + active, active decrypts.
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Credential store: 2 instance(s)")
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('Active stored instance "dev.service-now.com" decrypts: yes')
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Resolved source (winner): instance profile env vars")
    );
  });

  it("warns in credential diagnostics when the active stored instance fails to decrypt (lines 211-215)", async () => {
    mockDiagnoseCredentials.mockReturnValue({
      baseEnvPresent: { instance: false, user: false, password: false },
      source: "none (credentials missing)",
      resolvedInstance: "",
      resolvedUser: "",
    });
    mockListInstances.mockResolvedValue(["broken.service-now.com"]);
    mockActiveStoreHealth.mockResolvedValue({
      active: "broken.service-now.com",
      decrypts: false,
      error: "unable to authenticate data",
    });
    const { statusCommand } = await import("../diagnosticsCommands");
    await statusCommand({ logLevel: "info", debugCredentials: true } as never);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Active stored instance "broken.service-now.com" FAILED to decrypt')
    );
    // No profile block when diag.profile is absent.
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.stringContaining("env: SN_INSTANCE_"));
    // Resolved instance/user rendered as <missing> placeholders.
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Resolved instance: <missing>, user: <missing>")
    );
  });

  it("renders <unresolved> path fields when a config path getter throws (line 83)", async () => {
    mockGetSourcePath.mockImplementation(() => {
      throw new Error("no source path");
    });
    const { statusCommand } = await import("../diagnosticsCommands");
    const summary = await statusCommand({ logLevel: "info" } as never);
    expect(summary.sourcePath).toBe("<unresolved>");
    // The other getters still resolve normally.
    expect(summary.buildPath).toBe("/proj/build");
  });

  it("reports an empty store with no active instance in diagnostics (lines 204-205)", async () => {
    mockDiagnoseCredentials.mockReturnValue({
      baseEnvPresent: { instance: true, user: true, password: true },
      source: "environment (.env / shell SN_* vars)",
      resolvedInstance: "dev.service-now.com",
      resolvedUser: "admin",
    });
    mockListInstances.mockResolvedValue([]);
    mockActiveStoreHealth.mockResolvedValue({ active: null, decrypts: false });
    const { statusCommand } = await import("../diagnosticsCommands");
    await statusCommand({ logLevel: "info", debugCredentials: true } as never);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Credential store: 0 instance(s), no active instance")
    );
  });

  it("reports the credential store as unreadable when listInstances rejects with an Error (line 218 message arm)", async () => {
    mockDiagnoseCredentials.mockReturnValue({
      baseEnvPresent: { instance: true, user: true, password: true },
      source: "environment (.env / shell SN_* vars)",
      resolvedInstance: "dev.service-now.com",
      resolvedUser: "admin",
    });
    mockListInstances.mockRejectedValue(new Error("store on fire"));
    const { statusCommand } = await import("../diagnosticsCommands");
    await statusCommand({ logLevel: "info", debugCredentials: true } as never);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Credential store: unreadable (store on fire)")
    );
  });

  it("reports the credential store as unreadable when listInstances rejects with a non-Error (lines 217-219)", async () => {
    mockDiagnoseCredentials.mockReturnValue({
      baseEnvPresent: { instance: true, user: true, password: true },
      source: "environment (.env / shell SN_* vars)",
      resolvedInstance: "dev.service-now.com",
      resolvedUser: "admin",
    });
    // A non-Error rejection exercises the String(e) branch of the catch.
    mockListInstances.mockRejectedValue("store locked");
    const { statusCommand } = await import("../diagnosticsCommands");
    await statusCommand({ logLevel: "info", debugCredentials: true } as never);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Credential store: unreadable (store locked)")
    );
  });
});

describe("doctorCommand", () => {
  it("passes every check when config, paths, env and connectivity are healthy", async () => {
    const { doctorCommand } = await import("../diagnosticsCommands");
    const result = await doctorCommand({ logLevel: "info" } as never);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "configPath",
      "sourcePath",
      "buildPath",
      "env",
      "connectivity",
    ]);
    expect(mockLoggerSuccess).toHaveBeenCalledWith(expect.stringContaining("Doctor checks passed"));
  });

  it("marks sourcePath and buildPath as failed when the config cannot resolve them (lines 248, 263)", async () => {
    mockGetSourcePath.mockImplementation(() => {
      throw new Error("no source");
    });
    mockGetBuildPath.mockImplementation(() => {
      throw new Error("no build");
    });
    const { doctorCommand } = await import("../diagnosticsCommands");
    const result = await doctorCommand({ logLevel: "info" } as never);
    const source = result.checks.find((c) => c.name === "sourcePath");
    const build = result.checks.find((c) => c.name === "buildPath");
    expect(source?.ok).toBe(false);
    expect(source?.details).toContain("Unable to resolve source path");
    expect(build?.ok).toBe(false);
    expect(build?.details).toContain("Unable to resolve build path");
    expect(result.ok).toBe(false);
  });

  it("marks connectivity failed when the connection check throws (line 296)", async () => {
    mockCheckConnection.mockRejectedValue(new Error("offline"));
    const { doctorCommand } = await import("../diagnosticsCommands");
    const result = await doctorCommand({ logLevel: "info" } as never);
    const conn = result.checks.find((c) => c.name === "connectivity");
    expect(conn?.ok).toBe(false);
    expect(conn?.details).toContain("Unable to reach ServiceNow instance");
    expect(result.ok).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("Doctor checks found issues"));
  });

  it("skips connectivity and reports missing env vars when credentials are absent", async () => {
    mockResolveCredentials.mockReturnValue({ instance: "", user: "", password: "" });
    const { doctorCommand } = await import("../diagnosticsCommands");
    const result = await doctorCommand({ logLevel: "info" } as never);
    const env = result.checks.find((c) => c.name === "env");
    const conn = result.checks.find((c) => c.name === "connectivity");
    expect(env?.ok).toBe(false);
    expect(env?.details).toContain("Missing environment variables");
    expect(conn?.details).toContain("Skipped connectivity check");
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });

  it("marks configPath failed when no config is discovered", async () => {
    mockCheckConfigPath.mockReturnValue("");
    const { doctorCommand } = await import("../diagnosticsCommands");
    const result = await doctorCommand({ logLevel: "info" } as never);
    const cfg = result.checks.find((c) => c.name === "configPath");
    expect(cfg?.ok).toBe(false);
    expect(cfg?.details).toContain("No sync.config.js discovered");
  });
});

describe("pluginsCommand", () => {
  let tmpRoot: string;

  afterEach(async () => {
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reports zero plugins with a hint when no rules are configured", async () => {
    mockGetConfig.mockReturnValue({ rules: [] });
    const { pluginsCommand } = await import("../diagnosticsCommands");
    const summary = await pluginsCommand({ logLevel: "info" } as never);
    expect(summary.totalRules).toBe(0);
    expect(summary.totalPlugins).toBe(0);
    expect(mockLoggerInfo).toHaveBeenCalledWith("No plugins configured in sync.config.js rules.");
  });

  it("falls back to empty rules when getConfig throws (line 339)", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("config broken");
    });
    const { pluginsCommand } = await import("../diagnosticsCommands");
    const summary = await pluginsCommand({ logLevel: "info" } as never);
    expect(summary.totalRules).toBe(0);
    expect(summary.totalPlugins).toBe(0);
  });

  it("skips blank/invalid plugin names and dedupes rule counts (line 348)", async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "syncrona-plugins-"));
    // "installed-plugin" exists in node_modules; "missing-plugin" does not.
    await fsp.mkdir(path.join(tmpRoot, "node_modules", "installed-plugin"), { recursive: true });
    mockGetRootDir.mockReturnValue(tmpRoot);
    mockGetConfig.mockReturnValue({
      rules: [
        { plugins: [{ name: "installed-plugin" }, { name: "  " }, { name: 42 }] },
        { plugins: [{ name: "installed-plugin" }, { name: "missing-plugin" }] },
        { plugins: "not-an-array" },
      ],
    });
    const { pluginsCommand } = await import("../diagnosticsCommands");
    const summary = await pluginsCommand({ logLevel: "info" } as never);
    expect(summary.totalRules).toBe(3);
    expect(summary.totalPlugins).toBe(2);
    const installed = summary.plugins.find((p) => p.name === "installed-plugin");
    const missing = summary.plugins.find((p) => p.name === "missing-plugin");
    expect(installed).toEqual({ name: "installed-plugin", installed: true, rulesMatched: 2 });
    expect(missing).toEqual({ name: "missing-plugin", installed: false, rulesMatched: 1 });
    // A missing plugin warns; the blank/numeric names never became entries.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("plugin:missing-plugin is configured but not installed")
    );
  });

  it("falls back to process.cwd() when getRootDir throws (line 358)", async () => {
    mockGetRootDir.mockImplementation(() => {
      throw new Error("no root");
    });
    mockGetConfig.mockReturnValue({
      rules: [{ plugins: [{ name: "some-uninstalled-plugin-xyz" }] }],
    });
    const { pluginsCommand } = await import("../diagnosticsCommands");
    const summary = await pluginsCommand({ logLevel: "info" } as never);
    // Resolving against cwd/node_modules for a nonexistent package => not installed.
    expect(summary.plugins[0]).toEqual({
      name: "some-uninstalled-plugin-xyz",
      installed: false,
      rulesMatched: 1,
    });
  });
});

describe("configCommand", () => {
  it("prints the built-in defaults for the show-defaults action (lines 415-426)", async () => {
    mockGetDefaultConfig.mockReturnValue({
      sourceDirectory: "src",
      buildDirectory: "build",
      pushConcurrency: 4,
      refreshInterval: 30,
      includes: { table_a: {}, table_b: {} },
      excludes: { table_c: {} },
    });
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({ logLevel: "info", action: "show-defaults" } as never);
    expect(mockGetDefaultConfig).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("sourceDirectory: src"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("pushConcurrency: 4"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("refreshInterval: 30s"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("default include table rules: 2")
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("default exclude table rules: 1")
    );
  });

  it("counts zero default include/exclude rules when the defaults omit them (lines 421-422)", async () => {
    mockGetDefaultConfig.mockReturnValue({
      sourceDirectory: "src",
      buildDirectory: "build",
      pushConcurrency: 4,
      refreshInterval: 30,
    });
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({ logLevel: "info", action: "show-defaults" } as never);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("default include table rules: 0")
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("default exclude table rules: 0")
    );
  });

  it("treats a missing action as an unknown action (line 413)", async () => {
    const oldExit = process.exitCode;
    const { configCommand } = await import("../diagnosticsCommands");
    // No action field at all -> String(undefined || "") === "" -> unknown action.
    await configCommand({ logLevel: "info" } as never);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown config action ""')
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("errors and sets a failing exit code for an unknown action", async () => {
    const oldExit = process.exitCode;
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({ logLevel: "info", action: "bogus" } as never);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown config action "bogus"')
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("marks a plugin [installed] in the add-plugin listing when present in node_modules (line 461)", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "syncrona-list-installed-"));
    // The first KNOWN_PLUGINS entry is @syncro-now-ai/typescript-plugin.
    await fsp.mkdir(path.join(tmpRoot, "node_modules", "@syncro-now-ai", "typescript-plugin"), {
      recursive: true,
    });
    mockGetRootDir.mockReturnValue(tmpRoot);
    try {
      const { configCommand } = await import("../diagnosticsCommands");
      await configCommand({ logLevel: "info", action: "add-plugin" } as never);
      // The listing line for the installed plugin carries the [installed] marker.
      const installedLine = mockLoggerInfo.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("typescript-plugin") && line.includes("[installed]"));
      expect(installedLine).toBeDefined();
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("lists available plugins and their install state when add-plugin has no --plugin", async () => {
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({ logLevel: "info", action: "add-plugin" } as never);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Available SyncroNow AI build plugins")
    );
    // A real KNOWN_PLUGINS entry is listed; none resolve under a fresh temp cwd.
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("typescript"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("syncro-now-ai config add-plugin --plugin typescript")
    );
  });

  it("prints an install hint + rule snippet for a known, not-installed plugin", async () => {
    // Fresh temp root with an empty node_modules => plugin is "missing".
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "syncrona-addplugin-"));
    mockGetRootDir.mockReturnValue(tmpRoot);
    try {
      const { configCommand } = await import("../diagnosticsCommands");
      await configCommand({ logLevel: "info", action: "add-plugin", plugin: "typescript" } as never);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("@syncro-now-ai/typescript-plugin")
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("not installed — run `npm i -D @syncro-now-ai/typescript-plugin`")
      );
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reports an installed status for a known plugin present in node_modules (lines 448, 480)", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "syncrona-installed-"));
    await fsp.mkdir(path.join(tmpRoot, "node_modules", "@syncro-now-ai", "typescript-plugin"), {
      recursive: true,
    });
    mockGetRootDir.mockReturnValue(tmpRoot);
    try {
      const { configCommand } = await import("../diagnosticsCommands");
      await configCommand({ logLevel: "info", action: "add-plugin", plugin: "typescript" } as never);
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Status: installed"));
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("falls back to cwd in isPluginInstalled when getRootDir throws (line 444)", async () => {
    // add-plugin --plugin typescript probes node_modules via isPluginInstalled;
    // when getRootDir throws it must degrade to process.cwd() rather than crash.
    mockGetRootDir.mockImplementation(() => {
      throw new Error("no root dir");
    });
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({ logLevel: "info", action: "add-plugin", plugin: "typescript" } as never);
    // The plugin is not present under the test cwd's node_modules => "not installed".
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("@syncro-now-ai/typescript-plugin")
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("not installed"));
  });

  it("errors for an unknown plugin name in add-plugin", async () => {
    const oldExit = process.exitCode;
    const { configCommand } = await import("../diagnosticsCommands");
    await configCommand({
      logLevel: "info",
      action: "add-plugin",
      plugin: "no-such-plugin",
    } as never);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown plugin "no-such-plugin"')
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });
});

describe("checkEnvCommand", () => {
  const savedWslDistro = process.env.WSL_DISTRO_NAME;

  afterEach(() => {
    if (savedWslDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedWslDistro;
  });

  it("passes on Node 22+ and a working git binary (lines 508-547)", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    const { checkEnvCommand } = await import("../diagnosticsCommands");
    const result = checkEnvCommand({ logLevel: "info" } as never);
    const node = result.checks.find((c) => c.name === "node");
    const git = result.checks.find((c) => c.name === "git");
    expect(node?.ok).toBe(true);
    expect(git?.ok).toBe(true);
    expect(git?.details).toBe("git version 2.42.0");
    // On the darwin/linux test host the platform check passes.
    const platform = result.checks.find((c) => c.name === "platform");
    expect(platform?.ok).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Environment looks good"));
    expect(process.exitCode).toBe(0);
    process.exitCode = oldExit;
  });

  it("flags an outdated Node runtime and fails the exit code (line 518, 559-561)", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
    // Report an old major so the >= 22 gate fails without touching the real runtime.
    Object.defineProperty(process, "versions", {
      value: { ...process.versions, node: "18.19.0" },
      configurable: true,
    });
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const node = result.checks.find((c) => c.name === "node");
      expect(node?.ok).toBe(false);
      expect(node?.details).toContain("too old");
      expect(node?.details).toContain("18.19.0");
      expect(result.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      if (originalVersions) Object.defineProperty(process, "versions", originalVersions);
      process.exitCode = oldExit;
    }
  });

  it("fails the git check and sets a failing exit code when git is not on PATH (lines 544-561)", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { checkEnvCommand } = await import("../diagnosticsCommands");
    const result = checkEnvCommand({ logLevel: "info" } as never);
    const git = result.checks.find((c) => c.name === "git");
    expect(git?.ok).toBe(false);
    expect(git?.details).toContain("git not found on PATH");
    expect(result.ok).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("git not found"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Environment has issues")
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = oldExit;
  });

  it("detects WSL via WSL_DISTRO_NAME on the platform check (line 493)", async () => {
    // detectWsl short-circuits on WSL_DISTRO_NAME without reading /proc/version.
    // Force process.platform to linux for this assertion only.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.WSL_DISTRO_NAME = "Ubuntu-22.04";
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const platform = result.checks.find((c) => c.name === "platform");
      expect(platform?.ok).toBe(true);
      expect(platform?.details).toContain("Ubuntu-22.04");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("detects Linux (non-WSL) by reading /proc/version (lines 496-499, 528-533)", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.WSL_DISTRO_NAME;
    // /proc/version has no "microsoft" marker => plain Linux.
    mockReadFileSync.mockReturnValue("Linux version 6.1.0 (gcc)");
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const platform = result.checks.find((c) => c.name === "platform");
      expect(platform?.ok).toBe(true);
      expect(platform?.details).toBe("Linux");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("detects WSL via a microsoft marker in /proc/version (line 497)", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.WSL_DISTRO_NAME;
    mockReadFileSync.mockReturnValue("Linux version 5.15.0-microsoft-standard-WSL2");
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const platform = result.checks.find((c) => c.name === "platform");
      expect(platform?.ok).toBe(true);
      expect(platform?.details).toContain("detected");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("treats /proc/version read failures as non-WSL (line 499)", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.WSL_DISTRO_NAME;
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT /proc/version");
    });
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const platform = result.checks.find((c) => c.name === "platform");
      expect(platform?.details).toBe("Linux");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("flags native Windows as unsupported (lines 521-527)", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mockExecFileSync.mockReturnValue("git version 2.42.0\n");
    try {
      const { checkEnvCommand } = await import("../diagnosticsCommands");
      const result = checkEnvCommand({ logLevel: "info" } as never);
      const platform = result.checks.find((c) => c.name === "platform");
      expect(platform?.ok).toBe(false);
      expect(platform?.details).toContain("Native Windows is not supported");
      expect(result.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      process.exitCode = oldExit;
    }
  });
});
