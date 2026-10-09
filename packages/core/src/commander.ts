// SPDX-License-Identifier: GPL-3.0-or-later
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { Argv, Arguments, Options } from "yargs";
import { logger } from "./Logger.js";
import { logErrorHint } from "./commandHelpers.js";
import { isPromptAbort } from "./errorTaxonomy.js";
import {
  CLI_COMMANDS,
  SHARED_CLI_OPTIONS,
  type CliCommandModule,
} from "./cliCommands.js";
import { resolveCurrentVersion } from "./updateNotifier.js";

// yargs invokes handlers without awaiting them; this wrapper turns an async
// command failure into a logged error + non-zero exit instead of an
// unhandled promise rejection.
const runHandler =
  (handler: (args: Arguments) => unknown) =>
  (args: Arguments): void => {
    Promise.resolve()
      .then(() => handler(args))
      .catch((e) => {
        // Ctrl-C during a prompt (inquirer 14 rejects with ExitPromptError
        // instead of killing the process): a user cancellation, not a command
        // failure — no error banner, conventional SIGINT exit code (130).
        if (isPromptAbort(e)) {
          process.exitCode = 130;
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        logger.error(message || "Command failed with an unknown error.");
        logErrorHint(e); // DX19: actionable next step based on error category
        process.exitCode = 1;
      });
  };

/** Primary name of a command, without its positional placeholders. */
function commandName(mod: CliCommandModule): string {
  const spec = Array.isArray(mod.command) ? mod.command[0] : mod.command;
  return spec.trim().split(/\s+/)[0];
}

// `--dry-run` is shared, but only the commands that implement a preview honour
// it. For the rest the flag used to parse fine and then do nothing: the user
// asked for a preview, got a real run, and the output said nothing about it.
// Declaring the option and refusing it is the honest contract.
//
// It stays DECLARED (just hidden and default-less) rather than being dropped,
// for two reasons: .strict() would otherwise answer "Unknown argument: dry-run",
// which reads as a typo instead of a deliberate limitation; and leaving the
// default off is what lets the check tell "the user typed it" apart from "yargs
// filled in false".
function sharedOptionsFor(mod: CliCommandModule): Record<string, Options> {
  if (mod.supportsDryRun !== false) return SHARED_CLI_OPTIONS;
  return {
    ...SHARED_CLI_OPTIONS,
    dryRun: {
      alias: SHARED_CLI_OPTIONS.dryRun.alias,
      type: "boolean",
      hidden: true,
      describe: SHARED_CLI_OPTIONS.dryRun.describe,
    },
  };
}

// `--no-dry-run` (dryRun === false) asks for the behaviour the command already
// has, so only the truthy spelling is refused.
const rejectDryRun =
  (mod: CliCommandModule) =>
  (args: Arguments): true => {
    if (args.dryRun !== true) return true;
    throw new Error(
      `\`syncrona ${commandName(mod)}\` has no preview mode, so --dry-run would run it for real. Re-run without --dry-run.`
    );
  };

function buildCommandBuilder(mod: CliCommandModule) {
  return (cmdArgs: Argv) => {
    if (mod.includeSharedOptions !== false) {
      cmdArgs.options({ ...sharedOptionsFor(mod), ...(mod.options || {}) });
      if (mod.supportsDryRun === false) {
        cmdArgs.check(rejectDryRun(mod));
      }
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

/** Every name a command answers to: its primary name and any alias. */
function commandNames(mod: CliCommandModule): string[] {
  const specs = Array.isArray(mod.command) ? mod.command : [mod.command];
  return specs.map((spec) => spec.trim().split(/\s+/)[0]);
}

const isFlag = (token: string): boolean =>
  token.startsWith("-") && token !== "-" && token !== "--";

// Spellings that never take the next token as a value.
const takesNoValue = (token: string): boolean =>
  token.startsWith("--no-") || token.includes("=");

// The flags the top-level parse does know: with one of them yargs prints help
// or the version, which needs no correction.
const isTopLevelFlag = (token: string): boolean => /^(--help|-h|--version)$/.test(token);

/**
 * The refusal for `syncrona --dry-run status`. Every option is declared per
 * command, so the top-level parse does not know a leading `--dry-run` is a
 * boolean: it takes the next token, the command name, as the flag's value, and
 * yargs reports only "specify a command" (or the leftover arguments as
 * unknown). Undefined unless the raw arguments open with flags whose last one
 * swallows a known command name, and no later token names a command yargs
 * could still run.
 */
function leadingFlagHint(raw: readonly string[], names: ReadonlySet<string>): string | undefined {
  const index = raw.findIndex((token) => !isFlag(token));
  if (index <= 0 || !names.has(raw[index])) return undefined;
  const flags = raw.slice(0, index);
  const swallowing = flags[flags.length - 1];
  if (takesNoValue(swallowing) || flags.some(isTopLevelFlag)) {
    return undefined;
  }
  const rest = raw.slice(index + 1);
  if (rest.some((token) => names.has(token))) return undefined;
  const command = raw[index];
  const corrected = ["syncrona", command, ...flags, ...rest].join(" ");
  return (
    `Specify a command to run. Options go after the command: \`${swallowing}\` ` +
    `took \`${command}\` as its value. Run \`${corrected}\` instead.`
  );
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
  // A leading flag that swallowed the command name leaves no command to run.
  // The run is refused, as yargs would refuse it, but with the corrected order:
  // running the command anyway would turn a mistyped `syncrona --dry-run push`
  // into a real push the moment the guess about the user's intent was wrong.
  const hint = leadingFlagHint(
    argv ?? hideBin(process.argv),
    new Set(CLI_COMMANDS.flatMap(commandNames))
  );
  if (hint) {
    logger.error(hint);
    process.exitCode = 1;
    return;
  }
  const base: Argv =
    argv === undefined ? yargs(hideBin(process.argv)) : yargs(argv);
  let cli = base.scriptName("syncrona");
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

  let parser = cli
    .demandCommand(1, "Specify a command to run. Use --help to list available commands.")
    .strict();
  // Wire `--version` to our own package.json explicitly. yargs' default version
  // detection derives the path from the yargs module's node_modules parent, which
  // (under a hoisted/symlinked install) resolves to the wrong package.json.
  const version = resolveCurrentVersion();
  if (version) {
    parser = parser.version(version);
  }
  parser.help().parse();
}
