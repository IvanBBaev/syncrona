// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import winston from "winston";
export {};

// #17: runHandler in commander.ts is the SINGLE sink that turns an async command
// failure into `logger.error(message)` + `logErrorHint(e)` (the actionable `-> hint`
// line) + `process.exitCode = 1`. Nothing referenced it before, so the user-visible
// failure path (message + hint + non-zero exit) was unverified above the pure
// classifier. This drives the real sink through initCommands()/yargs by registering a
// synthetic command that rejects, then asserts all three effects — including that an
// auth-shaped error (HTTP 401) renders the AUTH hint, not a generic one.

const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    error: (...a: unknown[]) => mockLoggerError(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
  },
  // The registry's shared --log-level option takes its `choices` from here, so
  // the mock has to carry the real level set for cliCommands.js to link.
  LOG_LEVELS: Object.keys(winston.config.npm.levels),
}));

import { type CliCommandModule } from "../cliCommands.js";

// The SUT (commander.js) and the shared CLI_COMMANDS registry it reads are
// imported dynamically AFTER the Logger mock is registered: jest.unstable_mockModule
// does not hoist, so a static import of commander.js would bind the real logger
// before the mock takes effect. CLI_COMMANDS must come from the same deferred
// import so the synthetic commands the test appends are the ones commander sees.
let CLI_COMMANDS: typeof import("../cliCommands.js").CLI_COMMANDS;
let initCommands: typeof import("../commander.js").initCommands;

// initCommands(argv) builds an ISOLATED yargs parser (exitProcess(false)) from
// the given argv, so each run is independent and a strict/validation failure
// never kills the jest worker.
const runArgv = async (argv: string[]): Promise<void> => {
  await initCommands(argv);
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("commander runHandler failure sink (#17)", () => {
  const registered: CliCommandModule[] = [];
  let prevExit: typeof process.exitCode;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ CLI_COMMANDS } = await import("../cliCommands.js"));
    ({ initCommands } = await import("../commander.js"));
    prevExit = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    // Remove any synthetic commands we appended so the real registry is intact.
    for (const mod of registered) {
      const idx = CLI_COMMANDS.indexOf(mod);
      if (idx >= 0) CLI_COMMANDS.splice(idx, 1);
    }
    registered.length = 0;
    process.exitCode = prevExit;
  });

  const registerFailing = (name: string, error: unknown): void => {
    const mod: CliCommandModule = {
      command: name,
      describe: `synthetic failing ${name}`,
      includeSharedOptions: false,
      handler: () => Promise.reject(error),
    };
    CLI_COMMANDS.push(mod);
    registered.push(mod);
  };

  it("logs the error message, renders the actionable hint and sets exit code 1", async () => {
    registerFailing("boom", new Error("kaboom"));

    await runArgv(["boom"]);
    // The rejection is caught asynchronously inside runHandler.
    await flush();

    expect(mockLoggerError).toHaveBeenCalledWith("kaboom");
    // logErrorHint renders "-> <hint>" via logger.info — the exact line the pure
    // classifier alone never proved reaches the user.
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringMatching(/^→ /));
    expect(process.exitCode).toBe(1);
  });

  it("classifies an HTTP 401 command failure as an AUTH problem in the hint", async () => {
    // Shape mirrors an axios error so the DX19 taxonomy routes it to the auth hint.
    registerFailing("authfail", { response: { status: 401 } });

    await runArgv(["authfail"]);
    await flush();

    const hintCall = mockLoggerInfo.mock.calls.find((c) =>
      String(c[0]).startsWith("→ ")
    );
    expect(hintCall).toBeDefined();
    expect(String(hintCall?.[0])).toContain("Authentication issue");
    expect(process.exitCode).toBe(1);
  });

  it("falls back to a generic message when the rejection is not an Error", async () => {
    registerFailing("weird", "");

    await runArgv(["weird"]);
    await flush();

    expect(mockLoggerError).toHaveBeenCalledWith(
      "Command failed with an unknown error."
    );
    expect(process.exitCode).toBe(1);
  });

  // DEP1: inquirer 14 rejects with ExitPromptError on Ctrl-C instead of killing
  // the process — the sink must treat that as a quiet cancellation (exit 130,
  // no error banner, no hint), not as a command failure.
  it("treats a prompt abort (ExitPromptError) as a quiet cancellation with exit code 130", async () => {
    const abort = new Error("User force closed the prompt with SIGINT");
    abort.name = "ExitPromptError";
    registerFailing("cancelled", abort);

    await runArgv(["cancelled"]);
    await flush();

    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });
});
