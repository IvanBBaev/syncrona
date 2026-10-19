// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
// #1 (CRITICAL) regression: the dev background refresh must NOT reset the active
// instance profile. refreshCommand(args, false) previously called
// setLogLevel({ logLevel: "warn" }), and setLogLevel() also resets the active
// instance profile — so a bare log-only object wiped the profile mid-session and
// the refresh silently synced/pushed against the BASE instance.
//
// This test uses the REAL commandHelpers + REAL snClient credential resolution
// (no mocks on the profile path). It mocks only the I/O seams (Watcher, config,
// appUtils) and captures, at the moment syncManifest() runs, which SN_USER the
// active profile resolves to.
export {};

const mockStartWatching = jest.fn();
const mockStopWatching = jest.fn();

jest.unstable_mockModule("../Watcher.js", () => ({
  startWatching: (...a: unknown[]) => mockStartWatching(...a),
  stopWatching: (...a: unknown[]) => mockStopWatching(...a),
}));

// checkScope is used by the real scopeCheck; make it pass so the body runs.
jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: () => "/tmp/src",
  getRefresh: () => 0,
}));

// R5: give the automock a factory; graph-complete fills in the exact appUtils
// names the devCommands graph hard-links. checkScope/syncManifest are the two the
// test drives directly.
jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: jest.fn(),
  syncManifest: jest.fn(),
}));

// R1: the mocks do not hoist, so the mocked appUtils namespace and the SUT are
// imported dynamically after the mocks register. resolveCredentials is the REAL
// snClient export (intentionally unmocked) but still deferred so it evaluates in
// the same graph as the SUT.
let AppUtils: typeof import("../appUtils.js");
let resolveCredentials: typeof import("../snClient.js").resolveCredentials;
let refreshCommand: typeof import("../devCommands.js").refreshCommand;
let checkScopeMock: jest.MockedFunction<typeof AppUtils.checkScope>;
let syncManifestMock: jest.MockedFunction<typeof AppUtils.syncManifest>;

beforeAll(async () => {
  AppUtils = await import("../appUtils.js");
  ({ resolveCredentials } = await import("../snClient.js"));
  ({ refreshCommand } = await import("../devCommands.js"));
  checkScopeMock = AppUtils.checkScope as jest.MockedFunction<
    typeof AppUtils.checkScope
  >;
  syncManifestMock = AppUtils.syncManifest as jest.MockedFunction<
    typeof AppUtils.syncManifest
  >;
});

describe("#1 dev refresh preserves the active instance profile", () => {
  const savedEnv = { ...process.env };
  const prevExit = process.exitCode;

  beforeEach(() => {
    jest.clearAllMocks();
    // Base SN_* point at one instance; the DEV profile points at another.
    process.env.SN_USER = "base.user";
    process.env.SN_PASSWORD = "base.pw";
    process.env.SN_INSTANCE = "base.service-now.com";
    process.env.SN_USER_DEV = "dev.user";
    process.env.SN_PASSWORD_DEV = "dev.pw";
    process.env.SN_INSTANCE_DEV = "dev.service-now.com";
    checkScopeMock.mockResolvedValue({ match: true } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = prevExit;
  });

  it("resolves SN_USER_DEV (not SN_USER) during a background refresh", async () => {
    let userAtSyncTime = "";
    let instanceAtSyncTime = "";
    syncManifestMock.mockImplementation(async () => {
      // Snapshot what the active profile resolves to at sync time — this is the
      // exact moment the old bug had already reset the profile to undefined.
      const creds = resolveCredentials();
      userAtSyncTime = creds.user;
      instanceAtSyncTime = creds.instance;
      return true;
    });

    // log=false is the background refresher path (the one that used to reset).
    await refreshCommand({ logLevel: "info", instanceProfile: "dev" } as never, false);

    expect(syncManifestMock).toHaveBeenCalled();
    expect(userAtSyncTime).toBe("dev.user");
    expect(instanceAtSyncTime).toBe("dev.service-now.com");
    // Explicitly assert the bug is gone: it did NOT fall back to the base user.
    expect(userAtSyncTime).not.toBe("base.user");
  });
});
