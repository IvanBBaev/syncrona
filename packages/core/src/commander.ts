// SPDX-License-Identifier: GPL-3.0-or-later
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { Argv, Arguments } from "yargs";
import { logger } from "./Logger.js";
import { logErrorHint } from "./commandHelpers.js";
import {
  CLI_COMMANDS,
  SHARED_CLI_OPTIONS,
  type CliCommandModule,
} from "./cliCommands.js";

// yargs invokes handlers without awaiting them; this wrapper turns an async
// command failure into a logged error + non-zero exit instead of an
// unhandled promise rejection.
const runHandler =
  (handler: (args: Arguments) => unknown) =>
  (args: Arguments): void => {
    Promise.resolve()
      .then(() => handler(args))
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        logger.error(message || "Command failed with an unknown error.");
        logErrorHint(e); // DX19: actionable next step based on error category
        process.exitCode = 1;
      });
  };

function buildCommandBuilder(mod: CliCommandModule) {
  return (cmdArgs: Argv) => {
    if (mod.includeSharedOptions !== false) {
      cmdArgs.options({ ...SHARED_CLI_OPTIONS, ...(mod.options || {}) });
    } else if (mod.options) {
      cmdArgs.options(mod.options);
    }
    for (const [name, config] of Object.entries(mod.positionals || {})) {
      cmdArgs.positional(name, config);
    }
    for (const [example, description] of mod.examples || []) {
      cmdArgs.example(example, description);
    }
    return cmdArgs;
  };
}

// Interprets the CLI_COMMANDS registry. New commands are added by appending a
// module entry in cliCommands.ts — this file should not need to change.
//
// `argv` is an optional, explicit argument vector. Production leaves it
// undefined so the parser reads the real process.argv (with the node/script
// prefix stripped by hideBin). Passing an argv (tests) builds an isolated
// parser from the yargs(argv) factory and disables process.exit, so the async
// failure sink (runHandler) can be driven without process.exit killing the
// test runner. yargs 18 is a pure factory (no shared singleton), so each call
// yields an independent parser.
export async function initCommands(argv?: string[]) {
  const base: Argv =
    argv === undefined ? yargs(hideBin(process.argv)) : yargs(argv);
  let cli = base.scriptName("syncro-now-ai");
  if (argv !== undefined) {
    cli = cli.exitProcess(false);
  }
  for (const mod of CLI_COMMANDS) {
    cli = cli.command(
      mod.command,
      mod.describe,
      buildCommandBuilder(mod),
      runHandler(mod.handler)
    );
  }

  cli
    .demandCommand(1, "Specify a command to run. Use --help to list available commands.")
    .strict()
    .help().argv;
}
