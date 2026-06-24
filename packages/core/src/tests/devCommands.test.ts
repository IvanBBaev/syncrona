// SPDX-License-Identifier: GPL-3.0-or-later
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

jest.mock("../Watcher", () => ({
  startWatching: (...a: unknown[]) => mockStartWatching(...a),
  stopWatching: (...a: unknown[]) => mockStopWatching(...a),
}));

jest.mock("../appUtils", () => ({
  syncManifest: (...a: unknown[]) => mockSyncManifest(...a),
}));

jest.mock("../logMessages", () => ({
  devModeLog: (...a: unknown[]) => mockDevModeLog(...a),
}));

jest.mock("../config", () => ({
  getSourcePath: (...a: unknown[]) => mockGetSourcePath(...a),
  getRefresh: (...a: unknown[]) => mockGetRefresh(...a),
}));

jest.mock("../commandHelpers", () => ({
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  // Run the wrapped callback directly so the real devCommand body executes.
  scopeCheck: (fn: () => unknown) => fn(),
}));

jest.mock("../Logger", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
  },
}));

import { devCommand, refreshCommand } from "../devCommands";

describe("devCommands", () => {
  const prevExit = process.exitCode;

  beforeEach(() => jest.clearAllMocks());
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
      // log=false drops the level to warn before syncing.
      expect(mockSetLogLevel).toHaveBeenCalledWith({ logLevel: "warn" });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  });
});
