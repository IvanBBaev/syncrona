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

jest.unstable_mockModule("../config.js", () => ({
  loadConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
  getEnvPath: (...args: unknown[]) => mockGetEnvPath(...args),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLoadConfigs.mockResolvedValue(undefined as any);
    mockGetEnvPath.mockReturnValue("/tmp/does-not-exist.env");

    process.exitCode = 0;
    await expect(init()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});
