import yargs from "yargs";
import type { Argv, Arguments } from "yargs";
import { logger } from "./Logger";
import {
  CLI_COMMANDS,
  SHARED_CLI_OPTIONS,
  type CliCommandModule,
} from "./cliCommands";

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
export async function initCommands() {
  let cli = (yargs as Argv).scriptName("syncro-now-ai");
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
