// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// A log level winston does not recognize silences the logger completely: its
// write guard compares levels[configured] >= levels[message], and an unknown
// level resolves to undefined, which loses every comparison — so a typo like
// `--log-level warning` mutes the command instead of making it noisier. These
// tests pin the clamp that keeps output flowing, and the accepted level set the
// CLI advertises.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-loglevel-"));

// The diagnostic file transport is the only thing in Logger.ts that touches the
// home dir; redirect it so the suite can never write to the real ~/.syncrona.
jest.unstable_mockModule("@syncrona/credential-store", () => ({
  getSyncronaDir: () => tempRoot,
}));

// Deferred: jest.unstable_mockModule does not hoist, so a static import would
// bind the real getSyncronaDir before the mock is registered.
let logger: typeof import("../Logger.js").logger;
let LOG_LEVELS: typeof import("../Logger.js").LOG_LEVELS;

beforeAll(async () => {
  ({ logger, LOG_LEVELS } = await import("../Logger.js"));
});

describe("Logger log-level validation", () => {
  let originalLevel: string;

  beforeAll(() => {
    originalLevel = logger.getLogLevel();
  });

  afterAll(() => {
    logger.setLogLevel(originalLevel);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("exposes the level set winston actually runs with", () => {
    expect(LOG_LEVELS).toEqual(
      expect.arrayContaining(["error", "warn", "info", "verbose", "debug", "silly"])
    );
  });

  it("keeps every valid level exactly as given", () => {
    for (const level of LOG_LEVELS) {
      logger.setLogLevel(level);
      expect(logger.getLogLevel()).toBe(level);
    }
  });

  it("falls back to info instead of silencing the logger on an unknown level", () => {
    logger.setLogLevel("warning");

    expect(logger.getLogLevel()).toBe("info");

    const internal = logger.getInternalLogger();
    // The real proof the run is not muted: winston still accepts writes at the
    // levels an unknown configured level would have dropped.
    expect(internal.isLevelEnabled("error")).toBe(true);
    expect(internal.isLevelEnabled("info")).toBe(true);
  });

  it("warns which level it fell back to so the typo is visible", () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      logger.setLogLevel("loud");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('Unknown log level "loud"');
    } finally {
      warn.mockRestore();
    }
  });
});
