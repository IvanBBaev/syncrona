// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";

export {};

// Closes the Logger.ts gaps the other suites leave: the diagnostic file
// transport is off by default (privacy), so diagnosticFileTransport()'s enabled
// body (mkdir + winston File transport wiring, and the push onto the transport
// list) is never exercised, and neither are the verbose/silly/getInternalLogger
// pass-throughs. We point getSyncronaDir at a real temp dir (so no write ever
// touches the real ~/.syncrona), flip the diagnostic env flag on, and rebuild
// the singleton logger via setLogLevel to trigger the enabled path.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-logger-"));

// getSyncronaDir is the sole home-dir escape hatch the diagnostic transport
// uses; redirect it to the temp dir to keep the file transport hermetic. A
// mutable override lets a single test point it at an invalid location to force
// the mkdir failure branch.
let syncronaDirOverride: string | null = null;
jest.mock("@syncro-now-ai/credential-store", () => ({
  getSyncronaDir: () => syncronaDirOverride ?? tempRoot,
}));

import { logger } from "../Logger";
import type winston from "winston";

const DIAG_KEY = "SYNCRONA_DIAGNOSTIC_LOG";

describe("Logger diagnostic file transport (G7)", () => {
  const originalDiag = process.env[DIAG_KEY];
  const originalLevel = logger.getLogLevel();

  afterEach(() => {
    if (originalDiag === undefined) delete process.env[DIAG_KEY];
    else process.env[DIAG_KEY] = originalDiag;
    syncronaDirOverride = null;
  });

  afterAll(() => {
    // Restore the singleton to a non-diagnostic state for any later suite in the
    // same worker, then remove the temp dir the file transport wrote into.
    delete process.env[DIAG_KEY];
    logger.setLogLevel(originalLevel);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("does not add a file transport when diagnostics are disabled", () => {
    delete process.env[DIAG_KEY];
    logger.setLogLevel("info");

    const internal = logger.getInternalLogger();
    const fileTransports = internal.transports.filter(
      (t) => (t as winston.transport & { filename?: string }).filename !== undefined
    );
    expect(fileTransports).toHaveLength(0);
  });

  it("wires a rotating file transport under the syncrona logs dir when enabled", () => {
    process.env[DIAG_KEY] = "1";
    logger.setLogLevel("info");

    // mkdirSync ran, so the logs directory physically exists under the temp dir.
    const logsDir = path.join(tempRoot, "logs");
    expect(fs.existsSync(logsDir)).toBe(true);

    // The internal winston logger now carries the File transport pointed at
    // cli.log, sized/rotated per the G7 configuration.
    const internal = logger.getInternalLogger();
    const fileTransport = internal.transports.find(
      (t) => (t as winston.transport & { filename?: string }).filename !== undefined
    ) as
      | (winston.transport & {
          filename?: string;
          dirname?: string;
          maxsize?: number;
          maxFiles?: number;
        })
      | undefined;

    // winston splits the path: filename holds the basename, dirname the folder.
    expect(fileTransport).toBeDefined();
    expect(fileTransport?.filename).toBe("cli.log");
    expect(fileTransport?.dirname).toBe(logsDir);
    expect(fileTransport?.maxsize).toBe(1_000_000);
    expect(fileTransport?.maxFiles).toBe(3);
  });

  it("falls back to no file transport when the logs directory cannot be created", () => {
    // Plant a regular FILE where the syncrona dir is expected, then point
    // getSyncronaDir at a path *under* that file. mkdirSync(<file>/logs) throws
    // ENOTDIR, which the best-effort transport swallows and returns null for —
    // the CLI must never break because diagnostics could not be wired.
    const blocker = path.join(tempRoot, "blocker-file");
    fs.writeFileSync(blocker, "not a directory", "utf-8");
    syncronaDirOverride = path.join(blocker, "nested");

    process.env[DIAG_KEY] = "1";
    expect(() => logger.setLogLevel("info")).not.toThrow();

    const internal = logger.getInternalLogger();
    const fileTransports = internal.transports.filter(
      (t) => (t as winston.transport & { filename?: string }).filename !== undefined
    );
    // The mkdir failure means the transport wiring was abandoned entirely.
    expect(fileTransports).toHaveLength(0);
  });

  it("appends emitted messages to the diagnostic log file when enabled", (done) => {
    process.env[DIAG_KEY] = "1";
    logger.setLogLevel("info");

    const marker = `diagnostic-marker-${Date.now()}`;
    logger.info(marker);

    // winston's File transport flushes asynchronously; poll briefly for the line.
    const logFile = path.join(tempRoot, "logs", "cli.log");
    const started = Date.now();
    const check = (): void => {
      if (fs.existsSync(logFile) && fs.readFileSync(logFile, "utf-8").includes(marker)) {
        done();
        return;
      }
      if (Date.now() - started > 2000) {
        done(new Error("diagnostic log file was not written with the expected marker"));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
});

describe("Logger level pass-throughs", () => {
  it("verbose and silly forward to the internal winston logger at their levels", () => {
    // Raise the level so verbose/silly are actually emitted, then spy on the
    // internal logger to prove the wrapper routes to the right winston level.
    logger.setLogLevel("silly");
    const internal = logger.getInternalLogger();

    const verboseSpy = jest.spyOn(internal, "verbose").mockReturnValue(internal);
    const sillySpy = jest.spyOn(internal, "silly").mockReturnValue(internal);

    logger.verbose("verbose line");
    logger.silly("silly line");

    expect(verboseSpy).toHaveBeenCalledWith("verbose line");
    expect(sillySpy).toHaveBeenCalledWith("silly line");

    verboseSpy.mockRestore();
    sillySpy.mockRestore();
  });

  it("getInternalLogger exposes the underlying winston logger instance", () => {
    const internal = logger.getInternalLogger();
    expect(internal).toBeDefined();
    // A winston logger exposes a .log method and a mutable .level; this is the
    // same instance the wrapper delegates every level to.
    expect(typeof internal.log).toBe("function");
    expect(typeof logger.getLogLevel()).toBe("string");
  });
});
