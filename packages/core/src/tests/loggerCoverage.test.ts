// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
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
jest.unstable_mockModule("@syncrona/credential-store", () => ({
  getSyncronaDir: () => syncronaDirOverride ?? tempRoot,
}));

import type winston from "winston";

// The logger singleton is imported dynamically AFTER the credential-store mock
// is registered: jest.unstable_mockModule does not hoist, so a static import of
// Logger.js would bind the real getSyncronaDir (pointing at the real ~/.syncrona)
// before the mock's temp-dir redirection can take effect.
let logger: typeof import("../Logger.js").logger;

const DIAG_KEY = "SYNCRONA_DIAGNOSTIC_LOG";

beforeAll(async () => {
  ({ logger } = await import("../Logger.js"));
});

describe("Logger diagnostic file transport (G7)", () => {
  const originalDiag = process.env[DIAG_KEY];
  let originalLevel: ReturnType<typeof logger.getLogLevel>;

  beforeAll(() => {
    originalLevel = logger.getLogLevel();
  });

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

// Shared by the stream-routing suites below. winston stores stderrLevels as a
// { level: true } map on the Console transport.
const consoleStderrLevels = (): Record<string, boolean> => {
  const internal = logger.getInternalLogger();
  const consoleTransport = internal.transports.find(
    (t) => (t as winston.transport & { filename?: string }).filename === undefined
  ) as (winston.transport & { stderrLevels?: Record<string, boolean> }) | undefined;
  expect(consoleTransport).toBeDefined();
  return consoleTransport?.stderrLevels ?? {};
};

describe("Console transport stream routing (stdout purity)", () => {
  // POSIX convention pinned by Logger.genLoggerOpts: warn/error are diagnostics
  // and must land on stderr so pipeable commands (`syncrona completion`) keep a
  // clean stdout.

  afterAll(() => {
    logger.setLogLevel("info");
  });

  it("routes warn and error to stderr while info stays on stdout", () => {
    logger.setLogLevel("info");
    const stderrLevels = consoleStderrLevels();
    expect(stderrLevels.warn).toBe(true);
    expect(stderrLevels.error).toBe(true);
    expect(stderrLevels.info).toBeUndefined();
  });

  it("keeps the stderr routing after setLogLevel rebuilds the logger", () => {
    // setLogLevel recreates the winston logger from genLoggerOpts; the stderr
    // routing must survive that rebuild, not just the initial construction.
    logger.setLogLevel("debug");
    const stderrLevels = consoleStderrLevels();
    expect(stderrLevels.warn).toBe(true);
    expect(stderrLevels.error).toBe(true);
    expect(stderrLevels.info).toBeUndefined();
  });
});

describe("routeAllToStderr (MCP stdio protocol safety)", () => {
  // A command whose stdout may become an MCP stdio protocol channel
  // (`syncrona mcp`) opts in via routeAllToStderr(); every console line must
  // then land on stderr. NOTE: keep this describe LAST in the file — the flag
  // is sticky on the module singleton, so once flipped here the default
  // warn/error-only routing pinned above can no longer be observed.
  let configuredLevels: string[];

  beforeAll(async () => {
    // createLogger without an explicit `levels` option runs on winston's npm
    // level set — the same source genLoggerOpts derives its stderrLevels from,
    // so the expectation can never drift behind a winston level-set change.
    const winstonRuntime = (await import("winston")).default;
    configuredLevels = Object.keys(winstonRuntime.config.npm.levels);
  });

  it("routes every configured level to stderr once routeAllToStderr() is called", () => {
    logger.setLogLevel("info");
    logger.routeAllToStderr();
    const stderrLevels = consoleStderrLevels();
    expect(configuredLevels.length).toBeGreaterThan(0);
    for (const level of configuredLevels) {
      expect(stderrLevels[level]).toBe(true);
    }
  });

  it("keeps all-levels stderr routing after a later setLogLevel rebuild", () => {
    // setLogLevel rebuilds the winston logger from genLoggerOpts; the sticky
    // flag must survive so a level change inside an MCP-hosted command can
    // never route chatter back onto the protocol channel.
    logger.setLogLevel("debug");
    const stderrLevels = consoleStderrLevels();
    for (const level of configuredLevels) {
      expect(stderrLevels[level]).toBe(true);
    }
  });
});
