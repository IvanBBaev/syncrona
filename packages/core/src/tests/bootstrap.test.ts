// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// init() runs under jest (JEST_WORKER_ID set), so it returns right after
// loading config + dotenv, before the network/notifier/commander steps. That
// lets us cover the two reachable branches: a broken config (hard error ->
// exitCode 1) and a clean load (resolves, early return).

// ESM namespace objects are frozen, so the previous jest.spyOn(ConfigManager,
// "loadConfigs") throws "Cannot assign to read only property". Mock the module
// with jest.fn()s instead and drive them directly (graph-complete fills in any
// other names the config graph hard-links).
const mockLoadConfigs = jest.fn();
const mockGetEnvPath = jest.fn();
const mockDotenvConfig = jest.fn();
const mockRouteAllToStderr = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  loadConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
  getEnvPath: (...args: unknown[]) => mockGetEnvPath(...args),
}));

// bootstrap calls logger.routeAllToStderr() up front for protocol-channel
// commands (mcp/completion). Mock the logger so that decision is observable
// without touching the real winston transports.
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    routeAllToStderr: (...args: unknown[]) => mockRouteAllToStderr(...args),
  },
}));

// bootstrap imports the dotenv default export; the mock captures the exact
// option object so the quiet flag (stdout purity) can be pinned below.
jest.unstable_mockModule("dotenv", () => ({
  default: { config: (...args: unknown[]) => mockDotenvConfig(...args) },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  setActiveInstanceProfile: jest.fn(),
  getScopedEndpointPrefix: jest.fn(),
  defaultClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  clearStoredCredentialsCache: jest.fn(),
  getErrorResponseStatus: jest.fn(),
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  snClient: jest.fn(),
  preloadStoredCredentials: jest.fn(),
}));

jest.unstable_mockModule("../updateNotifier.js", () => ({
  runUpdateNotifier: jest.fn(),
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real dependencies before the mocks take effect.
let init: typeof import("../bootstrap.js").init;

describe("bootstrap init", () => {
  const prevExit = process.exitCode;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ init } = await import("../bootstrap.js"));
    mockGetEnvPath.mockReturnValue("/tmp/does-not-exist.env");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = prevExit;
  });

  it("logs the message and sets exitCode=1 when config loading fails", async () => {
    mockLoadConfigs.mockRejectedValue(new Error("broken sync.config.js"));
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    process.exitCode = 0;
    await init();

    expect(errSpy).toHaveBeenCalledWith("broken sync.config.js");
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error config failure before logging it", async () => {
     
    mockLoadConfigs.mockRejectedValue("plain string failure" as any);
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    process.exitCode = 0;
    await init();

    expect(errSpy).toHaveBeenCalledWith("plain string failure");
    expect(process.exitCode).toBe(1);
  });

  it("loads config + dotenv and returns early under jest", async () => {
     
    mockLoadConfigs.mockResolvedValue(undefined as any);
    mockGetEnvPath.mockReturnValue("/tmp/does-not-exist.env");

    process.exitCode = 0;
    await expect(init()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("passes quiet:true to dotenv so the v17 tip line never reaches stdout", async () => {
    // Pipeable commands (`syncrona completion bash >> ~/.bashrc`) require a
    // clean stdout; dotenv v17 prints an injection tip there unless quieted.
     
    mockLoadConfigs.mockResolvedValue(undefined as any);
    mockGetEnvPath.mockReturnValue("/tmp/does-not-exist.env");

    await init();

    expect(mockDotenvConfig).toHaveBeenCalledTimes(1);
    expect(mockDotenvConfig).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/does-not-exist.env", quiet: true })
    );
  });
});

// The parent `syncrona mcp` process inherits its stdout to the spawned MCP
// server as the JSON-RPC transport, and `syncrona completion` pipes a script
// there — so for those commands every bootstrap-phase notice must go to stderr,
// decided from process.argv before loadConfigs() can log.
describe("bootstrap init — protocol-channel stdout routing", () => {
  const realArgv = process.argv;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ init } = await import("../bootstrap.js"));
     
    mockLoadConfigs.mockResolvedValue(undefined as any);
    mockGetEnvPath.mockReturnValue("/tmp/does-not-exist.env");
  });

  afterEach(() => {
    process.argv = realArgv;
  });

  it("routes all logger output to stderr for the `mcp` command", async () => {
    process.argv = ["node", "syncrona", "mcp"];
    await init();
    expect(mockRouteAllToStderr).toHaveBeenCalledTimes(1);
  });

  it("routes to stderr for `completion` (the piped script must keep stdout clean)", async () => {
    process.argv = ["node", "syncrona", "completion", "bash"];
    await init();
    expect(mockRouteAllToStderr).toHaveBeenCalledTimes(1);
  });

  it("finds the command past leading global options (`--log-level debug mcp`)", async () => {
    process.argv = ["node", "syncrona", "--log-level", "debug", "mcp"];
    await init();
    expect(mockRouteAllToStderr).toHaveBeenCalledTimes(1);
  });

  it("handles the `--flag=value` global-option form before the command", async () => {
    process.argv = ["node", "syncrona", "--log-level=debug", "mcp"];
    await init();
    expect(mockRouteAllToStderr).toHaveBeenCalledTimes(1);
  });

  it("does NOT route for a normal command whose stdout is human-readable text", async () => {
    process.argv = ["node", "syncrona", "status"];
    await init();
    expect(mockRouteAllToStderr).not.toHaveBeenCalled();
  });

  it("does not mistake an option value of `mcp` for the command", async () => {
    process.argv = ["node", "syncrona", "--instance-profile", "mcp", "status"];
    await init();
    expect(mockRouteAllToStderr).not.toHaveBeenCalled();
  });
});
