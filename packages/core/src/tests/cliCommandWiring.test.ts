// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { Arguments } from "yargs";
export {};

// REV-96 (GATE-2): cliCommands.ts measured 24.13% lines — the lowest in the
// package. Every uncovered line is one `handler: typedHandler<…>((args) =>
// xCommand(args))` delegation in the CLI_COMMANDS registry, which reads like
// untestable wiring. It is not: the delegations are 23 near-identical one-liners,
// so a copy/paste that points `deploy` at buildCommand, or that drops `args` on
// the way through, type-checks, lints, and ships. cliOptionSurface.test.ts proves
// the parser DECLARES the right flags; nothing proved the handler then calls the
// right command with them.
//
// Every command module is mocked, so this suite asserts the wiring only — one
// named command function per registry entry, invoked exactly once, with the args
// object forwarded by identity, and its result returned so commander can await it.

const commandNames = [
  "downloadCommand",
  "initCommand",
  "buildCommand",
  "deployCommand",
  "docsCommand",
  "pushCommand",
  "repairCommand",
  "statusCommand",
  "doctorCommand",
  "pluginsCommand",
  "checkEnvCommand",
  "configCommand",
  "mcpCommand",
  "devCommand",
  "refreshCommand",
  "loginCommand",
  "logoutCommand",
  "instancesCommand",
  "useCommand",
  "jiraCommand",
  "jiraLoginCommand",
  "jiraLogoutCommand",
  "completionCommand",
] as const;

type CommandName = (typeof commandNames)[number];

// One spy per command function. Each resolves to a per-command sentinel so the
// test can prove the handler RETURNS the command's promise instead of firing it
// and forgetting (which would make commander.ts unable to await or catch it).
const spies = Object.fromEntries(
  commandNames.map((name) => [
    name,
    jest.fn((..._args: unknown[]) => Promise.resolve(`result:${name}`)),
  ])
) as Record<CommandName, jest.Mock>;

const pick = (...names: CommandName[]) =>
  Object.fromEntries(
    names.map((name) => [name, (...args: unknown[]) => spies[name](...args)])
  );

jest.unstable_mockModule("../commands.js", () => ({
  ...pick("downloadCommand", "initCommand", "buildCommand", "deployCommand", "docsCommand"),
}));
jest.unstable_mockModule("../pushCommand.js", () => ({ ...pick("pushCommand") }));
jest.unstable_mockModule("../repairCommand.js", () => ({ ...pick("repairCommand") }));
jest.unstable_mockModule("../diagnosticsCommands.js", () => ({
  ...pick("statusCommand", "doctorCommand", "pluginsCommand", "checkEnvCommand", "configCommand"),
}));
jest.unstable_mockModule("../mcpCommand.js", () => ({ ...pick("mcpCommand") }));
jest.unstable_mockModule("../devCommands.js", () => ({
  ...pick("devCommand", "refreshCommand"),
}));
jest.unstable_mockModule("../authCommands.js", () => ({
  ...pick("loginCommand", "logoutCommand", "instancesCommand", "useCommand"),
}));
jest.unstable_mockModule("../jiraCommands.js", () => ({
  ...pick("jiraCommand", "jiraLoginCommand", "jiraLogoutCommand"),
}));
jest.unstable_mockModule("../completionCommand.js", () => ({
  ...pick("completionCommand"),
}));

// The registry is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the real
// command modules (and actually run a command) before the mocks take effect.
let CLI_COMMANDS: typeof import("../cliCommands.js").CLI_COMMANDS;

/** The command WORD of a registry entry, e.g. "download <scope>" -> "download". */
const nameOf = (entry: (typeof CLI_COMMANDS)[number]): string => {
  const spec = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  return spec.split(" ")[0];
};

// The wiring contract, written out by hand on purpose: an assertion derived from
// the registry itself would pass no matter which function an entry points at.
const EXPECTED_WIRING: Array<[string, CommandName]> = [
  ["dev", "devCommand"],
  ["refresh", "refreshCommand"],
  ["push", "pushCommand"],
  ["download", "downloadCommand"],
  ["init", "initCommand"],
  ["build", "buildCommand"],
  ["deploy", "deployCommand"],
  ["docs", "docsCommand"],
  ["repair", "repairCommand"],
  ["status", "statusCommand"],
  ["check-env", "checkEnvCommand"],
  ["doctor", "doctorCommand"],
  ["plugins", "pluginsCommand"],
  ["config", "configCommand"],
  ["completion", "completionCommand"],
  ["mcp", "mcpCommand"],
  ["login", "loginCommand"],
  ["logout", "logoutCommand"],
  ["instances", "instancesCommand"],
  ["use", "useCommand"],
  ["jira", "jiraCommand"],
  ["jira-login", "jiraLoginCommand"],
  ["jira-logout", "jiraLogoutCommand"],
];

describe("CLI command wiring", () => {
  beforeAll(async () => {
    ({ CLI_COMMANDS } = await import("../cliCommands.js"));
  });

  beforeEach(() => {
    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
  });

  it("declares one wiring expectation per registry entry", () => {
    // Guards the table above: a command added to the registry without an entry
    // here would otherwise be silently exempt from the delegation check.
    expect(CLI_COMMANDS.map(nameOf).sort()).toEqual(
      EXPECTED_WIRING.map(([name]) => name).sort()
    );
  });

  it.each(EXPECTED_WIRING)(
    "%s delegates to %s exactly once and to nothing else",
    async (commandWord, expectedFn) => {
      const entry = CLI_COMMANDS.find((mod) => nameOf(mod) === commandWord);
      expect(entry).toBeDefined();

      const args = { _: [commandWord], $0: "syncrona", logLevel: "info" } as Arguments;
      const returned = await entry!.handler(args);

      expect(spies[expectedFn]).toHaveBeenCalledTimes(1);
      // Same object, not a copy: a handler that rebuilt or partially spread the
      // args would drop positionals/aliases the parser resolved.
      expect(spies[expectedFn].mock.calls[0][0]).toBe(args);
      // The command's promise is handed back so commander.ts can await it and a
      // rejection is not swallowed into an unhandled rejection.
      expect(returned).toBe(`result:${expectedFn}`);

      for (const [name, spy] of Object.entries(spies)) {
        if (name !== expectedFn) {
          expect(spy).not.toHaveBeenCalled();
        }
      }
    }
  );

  it("passes the live registry to completionCommand so the script stays in sync", () => {
    // completionCommand emits the tab-completion script from the registry it is
    // handed; a stale or hand-written list would complete commands that no longer
    // exist. The second argument must be the SAME array the CLI registers.
    const entry = CLI_COMMANDS.find((mod) => nameOf(mod) === "completion");
    entry!.handler({ _: ["completion"], $0: "syncrona" } as Arguments);

    expect(spies.completionCommand).toHaveBeenCalledTimes(1);
    expect(spies.completionCommand.mock.calls[0][1]).toBe(CLI_COMMANDS);
  });

  it("gives every registry entry a callable handler and a non-empty describe", () => {
    for (const entry of CLI_COMMANDS) {
      expect(typeof entry.handler).toBe("function");
      expect(entry.describe.trim().length).toBeGreaterThan(0);
    }
  });
});
