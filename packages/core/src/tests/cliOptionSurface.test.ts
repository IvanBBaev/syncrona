// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { Arguments } from "yargs";
export {};

// The registry in cliCommands.ts is the ONLY thing that tells yargs which flags a
// command takes, and the parser runs .strict(): a flag a handler reads but the
// registry never declares is rejected before the handler ever sees it, and a flag
// declared without `choices` accepts values that break the command downstream.
// These tests drive the real registry through the real parser, so an option that
// exists only in a handler's imagination cannot pass unnoticed.

import { type CliCommandModule } from "../cliCommands.js";

let CLI_COMMANDS: typeof import("../cliCommands.js").CLI_COMMANDS;
let initCommands: typeof import("../commander.js").initCommands;
let LOG_LEVELS: typeof import("../Logger.js").LOG_LEVELS;

const flush = () => new Promise((resolve) => setImmediate(resolve));

const entryFor = (name: string): CliCommandModule => {
  const found = CLI_COMMANDS.find((mod) => {
    const spec = Array.isArray(mod.command) ? mod.command[0] : mod.command;
    return spec.split(" ")[0] === name;
  });
  if (!found) {
    throw new Error(`No CLI registry entry for "${name}"`);
  }
  return found;
};

/**
 * Parse `argv` with the real registry, but with the named command's handler
 * swapped for a spy, so the parse is observed without running the command.
 * Returns the args the parser handed the handler, or null when it refused.
 */
const parseInto = async (
  name: string,
  argv: string[]
): Promise<Arguments | null> => {
  const entry = entryFor(name);
  const original = entry.handler;
  let seen: Arguments | null = null;
  entry.handler = (args: Arguments): unknown => {
    seen = args;
    return undefined;
  };
  try {
    await initCommands(argv);
    await flush();
  } catch (_) {
    // yargs (exitProcess(false)) throws on a validation failure; a refused parse
    // is a result here, not a test error — `seen` staying null is the signal.
  } finally {
    entry.handler = original;
  }
  return seen;
};

describe("CLI option surface", () => {
  let prevExit: typeof process.exitCode;
  let stderr: jest.SpiedFunction<typeof process.stderr.write>;
  let consoleError: jest.SpiedFunction<typeof console.error>;

  beforeEach(async () => {
    ({ CLI_COMMANDS } = await import("../cliCommands.js"));
    ({ initCommands } = await import("../commander.js"));
    ({ LOG_LEVELS } = await import("../Logger.js"));
    prevExit = process.exitCode;
    // yargs prints the usage block on a rejected parse; keep the suite readable.
    stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    stderr.mockRestore();
    process.exitCode = prevExit;
  });

  it("accepts every log level the logger can actually run with", async () => {
    for (const level of LOG_LEVELS) {
      const args = await parseInto("status", ["status", "--log-level", level]);
      expect(args?.logLevel).toBe(level);
    }
  });

  it("rejects an unknown --log-level instead of running the command muted", async () => {
    const args = await parseInto("status", ["status", "--log-level", "warning"]);

    expect(args).toBeNull();
  });

  it("lets `init --ci` through to the handler that reads args.ci", async () => {
    const args = await parseInto("init", ["init", "--ci"]);

    expect(args?.ci).toBe(true);
  });

  it("lets `deploy --ci` through to the handler that reads args.ci", async () => {
    const args = await parseInto("deploy", ["deploy", "--ci"]);

    expect(args?.ci).toBe(true);
  });

  it("still defaults --ci to false so an interactive run keeps its confirmation", async () => {
    expect((await parseInto("init", ["init"]))?.ci).toBe(false);
    expect((await parseInto("deploy", ["deploy"]))?.ci).toBe(false);
  });
});
