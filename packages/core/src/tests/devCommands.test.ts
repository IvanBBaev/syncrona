// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockStartWatching = jest.fn();
const mockStopWatching = jest.fn();
const mockSyncManifest = jest.fn();
const mockDevModeLog = jest.fn();
const mockGetSourcePath = jest.fn();
const mockGetRefresh = jest.fn();
const mockSetLogLevel = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerSetLogLevel = jest.fn();
const mockLoggerGetLogLevel = jest.fn((..._a: unknown[]) => "info");

jest.unstable_mockModule("../Watcher.js", () => ({
  startWatching: (...a: unknown[]) => mockStartWatching(...a),
  stopWatching: (...a: unknown[]) => mockStopWatching(...a),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  syncManifest: (...a: unknown[]) => mockSyncManifest(...a),
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  devModeLog: (...a: unknown[]) => mockDevModeLog(...a),
}));

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: (...a: unknown[]) => mockGetSourcePath(...a),
  getRefresh: (...a: unknown[]) => mockGetRefresh(...a),
}));

// Run the wrapped callback directly so the real devCommand body executes.
const passThroughScopeCheck = async (fn: () => unknown) => {
  await fn();
};
const mockScopeCheck = jest.fn(passThroughScopeCheck);

jest.unstable_mockModule("../commandHelpers.js", () => ({
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  scopeCheck: (fn: () => unknown) => mockScopeCheck(fn),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    setLogLevel: (...a: unknown[]) => mockLoggerSetLogLevel(...a),
    getLogLevel: (...a: unknown[]) => mockLoggerGetLogLevel(...a),
  },
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real dependencies before the mocks take effect.
let devCommand: typeof import("../devCommands.js").devCommand;
let refreshCommand: typeof import("../devCommands.js").refreshCommand;

describe("devCommands", () => {
  const prevExit = process.exitCode;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ devCommand, refreshCommand } = await import("../devCommands.js"));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.removeAllListeners("SIGINT");
    process.exitCode = prevExit;
  });

  describe("refreshCommand", () => {
    it("logs success when the manifest sync succeeds", async () => {
      mockSyncManifest.mockResolvedValue(true);
      await refreshCommand({ logLevel: "info" } as never);
      expect(mockLoggerSuccess).toHaveBeenCalled();
      expect(process.exitCode).toBe(prevExit);
    });

    it("sets exitCode=1 on an interactive failure", async () => {
      mockSyncManifest.mockResolvedValue(false);
      process.exitCode = 0;
      await refreshCommand({ logLevel: "info" } as never, true);
      expect(process.exitCode).toBe(1);
      expect(mockLoggerSuccess).not.toHaveBeenCalled();
    });

    it("stays silent and leaves exitCode untouched on a background failure", async () => {
      mockSyncManifest.mockResolvedValue(false);
      process.exitCode = 0;
      await refreshCommand({ logLevel: "info" } as never, false);
      expect(process.exitCode).toBe(0);
      // #1: log=false quiets the logger DIRECTLY (logger.setLogLevel), and must
      // NOT go through the profile-mutating setLogLevel({ logLevel: "warn" }),
      // which would reset the active instance profile mid-session.
      expect(mockLoggerSetLogLevel).toHaveBeenCalledWith("warn");
      expect(mockSetLogLevel).not.toHaveBeenCalledWith({ logLevel: "warn" });
    });

    it("#1: a background refresh never resets the active instance profile", async () => {
      // setLogLevel(args) is the ONLY call that may touch profile state, and it
      // must always receive the real command args (with instanceProfile), never
      // the bare log-only { logLevel: "warn" } object.
      mockSyncManifest.mockResolvedValue(true);
      await refreshCommand({ logLevel: "info", instanceProfile: "dev" } as never, false);
      // Every setLogLevel (the profile helper) call carried the profile.
      for (const call of mockSetLogLevel.mock.calls) {
        expect(call[0]).toEqual(
          expect.objectContaining({ instanceProfile: "dev" })
        );
      }
      // The quiet-then-restore of the logger level happened via logger.setLogLevel.
      expect(mockLoggerSetLogLevel).toHaveBeenCalledWith("warn");
      expect(mockLoggerSetLogLevel).toHaveBeenCalledWith("info"); // restored
    });
  });

  describe("devCommand", () => {
    it("starts the watcher without a refresh timer when the interval is 0", async () => {
      await devCommand({ logLevel: "info", refreshInterval: 0 } as never);
      expect(mockStartWatching).toHaveBeenCalled();
      expect(mockDevModeLog).toHaveBeenCalled();
      expect(mockLoggerInfo).not.toHaveBeenCalledWith(
        expect.stringContaining("Checking for new manifest")
      );
    });

    it("falls back to the configured interval and wires a SIGINT shutdown", async () => {
      mockGetRefresh.mockReturnValue(10);
      let sigint: (() => void) | undefined;
      jest
        .spyOn(process, "once")
         
        .mockImplementation(((evt: string, h: () => void) => {
          if (evt === "SIGINT") sigint = h;
          return process;
        }) as any);

      await devCommand({ logLevel: "info" } as never);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("every 10 seconds")
      );
      // Invoke the captured handler to cover the clearInterval + stop path.
      expect(sigint).toBeDefined();
      sigint?.();
      expect(mockStopWatching).toHaveBeenCalled();
    });

    // REV-96 (GATE-2): the `refresher` closure — the whole point of the interval —
    // had no test. Its refreshInFlight guard is the only thing stopping a slow
    // instance from stacking concurrent manifest syncs, so the tick, the guard
    // and the guard RELEASE are all asserted here rather than left to the global
    // coverage average.
    it("skips a scheduled refresh while the previous one is still in flight", async () => {
      // Flush enough microtask turns for the refresher's await chain
      // (refresher -> refreshCommand -> scopeCheck -> syncManifest) to settle.
      const flush = async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      };

      jest.useFakeTimers();
      try {
        let release: (value: boolean) => void = () => {};
        mockSyncManifest.mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              release = resolve;
            })
        );

        await devCommand({ logLevel: "info", refreshInterval: 1 } as never);

        // First tick starts a refresh that has not settled yet.
        jest.advanceTimersByTime(1000);
        await flush();
        expect(mockSyncManifest).toHaveBeenCalledTimes(1);

        // Second tick lands while the first refresh is still running: it must be
        // DROPPED, not queued behind the first one.
        jest.advanceTimersByTime(1000);
        await flush();
        expect(mockSyncManifest).toHaveBeenCalledTimes(1);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
          "Skipping scheduled refresh: previous refresh still running."
        );

        // Completing the refresh releases the guard and reports the cost (DX21).
        release(true);
        await flush();
        expect(mockLoggerDebug).toHaveBeenCalledWith(
          expect.stringMatching(/^Manifest refresh took \d+ms$/)
        );

        // The guard is released, so the next tick refreshes again — the skip is a
        // one-tick drop, not a permanent stall.
        jest.advanceTimersByTime(1000);
        await flush();
        expect(mockSyncManifest).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
        // The never-settling implementation must not leak into later tests.
        mockSyncManifest.mockReset();
      }
    });

    it("keeps polling after a refresh fails and raises no unhandled rejection", async () => {
      // `setInterval(() => void refresher())` discards the promise, so anything
      // that escapes refresher() becomes an unhandled rejection and (under Node's
      // default --unhandled-rejections=throw) kills the dev watcher. Production is
      // safe only because the real scopeCheck sinks command-body errors and sets
      // exitCode=1, so this test uses that faithful behaviour instead of the
      // pass-through stub — and then asserts both halves of the contract: nothing
      // escapes, and polling continues.
      const flush = async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      };
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      const prevExitCode = process.exitCode;

      jest.useFakeTimers();
      process.on("unhandledRejection", onUnhandled);
      mockScopeCheck.mockImplementation(async (fn: () => unknown) => {
        try {
          await fn();
        } catch {
          process.exitCode = 1;
        }
      });
      try {
        mockSyncManifest
          .mockRejectedValueOnce(new Error("instance unreachable"))
          .mockResolvedValue(true);

        await devCommand({ logLevel: "info", refreshInterval: 1 } as never);

        jest.advanceTimersByTime(1000);
        await flush();
        expect(mockSyncManifest).toHaveBeenCalledTimes(1);

        // The failed refresh released the guard, so the next tick runs a real
        // refresh instead of being skipped forever.
        jest.advanceTimersByTime(1000);
        await flush();
        expect(mockSyncManifest).toHaveBeenCalledTimes(2);
        expect(mockLoggerDebug).not.toHaveBeenCalledWith(
          "Skipping scheduled refresh: previous refresh still running."
        );
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        jest.useRealTimers();
        mockSyncManifest.mockReset();
        mockScopeCheck.mockImplementation(passThroughScopeCheck);
        process.exitCode = prevExitCode;
      }
    });
  });
});
