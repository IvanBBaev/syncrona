import { Sync } from "@syncro-now-ai/types";
import type { Arguments, Options, PositionalOptions } from "yargs";
import {
  downloadCommand,
  initCommand,
  buildCommand,
  deployCommand,
  docsCommand,
} from "./commands";
import { pushCommand } from "./pushCommand";
import { statusCommand, doctorCommand, pluginsCommand, checkEnvCommand, configCommand } from "./diagnosticsCommands";
import { mcpCommand } from "./mcpCommand";
import { devCommand, refreshCommand } from "./devCommands";
import {
  loginCommand,
  logoutCommand,
  instancesCommand,
  useCommand,
} from "./authCommands";

/**
 * Declarative contract for one CLI command module.
 *
 * The CLI surface is a plain registry: adding a command means appending one
 * entry here (pointing at its implementation module), removing a command
 * means deleting the entry. `commander.ts` interprets the registry and never
 * needs to change for new commands (open/closed at the command level).
 */
export type CliCommandModule = {
  /** yargs command spec, e.g. "download <scope>" or ["dev", "d"]. */
  command: string | string[];
  describe: string;
  /** Extra options merged over the shared set (logLevel/dryRun/instanceProfile). */
  options?: Record<string, Options>;
  /** Positional argument descriptions (the spec itself declares them). */
  positionals?: Record<string, PositionalOptions>;
  /** Set false for commands that do not take the shared options. */
  includeSharedOptions?: boolean;
  /** Usage examples shown in `--help`: [command, description] pairs. */
  examples?: Array<[string, string]>;
  handler: (args: Arguments) => unknown;
};

// G5: single controlled bridge between yargs' runtime Arguments and each
// command's typed args. The handler body is type-checked against TArgs, and
// the options/positionals declared in the same registry entry are what
// guarantee those fields exist at runtime.
const typedHandler =
  <TArgs>(handler: (args: Arguments & TArgs) => unknown) =>
  (args: Arguments): unknown =>
    handler(args as Arguments & TArgs);

export const SHARED_CLI_OPTIONS: Record<string, Options> = {
  logLevel: {
    type: "string",
    default: "info",
  },
  dryRun: {
    alias: "dry-run",
    type: "boolean",
    default: false,
    describe: "Preview command effects without writing files or applying remote changes",
  },
  instanceProfile: {
    alias: "instance-profile",
    type: "string",
    describe:
      "Credential profile suffix for SN_* env vars (ex. --instance-profile dev uses SN_INSTANCE_DEV/SN_USER_DEV/SN_PASSWORD_DEV)",
  },
};

const DIFF_OPTION: Record<string, Options> = {
  diff: {
    alias: "d",
    type: "string",
    default: "",
    describe:
      "Git branch to diff against: push acts on changed files only; build records a deploy diff manifest",
  },
};

export const CLI_COMMANDS: CliCommandModule[] = [
  {
    command: ["dev", "d"],
    describe: "Start Development Mode",
    options: {
      refreshInterval: {
        alias: "refresh-interval",
        type: "number",
        describe:
          "Seconds between manifest refreshes (overrides sync.config.js refreshInterval; 0 disables polling)",
      },
    },
    examples: [
      ["$0 dev", "Watch tracked files and push each change to ServiceNow as you save"],
      ["$0 dev --refresh-interval 60", "Poll for new manifest files every 60s instead of the default"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { refreshInterval?: number }>((args) => devCommand(args)),
  },
  {
    command: ["refresh", "r"],
    describe: "Refresh Manifest and download new files since last refresh",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => refreshCommand(args)),
  },
  {
    command: ["push [target]"],
    describe:
      "[DESTRUCTIVE] Push all files from current local files to ServiceNow instance.",
    options: {
      ...DIFF_OPTION,
      scopeSwap: {
        alias: "ss",
        type: "boolean",
        default: false,
        describe: "Will auto-swap to the correct scope for the files being pushed",
      },
      updateSet: {
        alias: "us",
        type: "string",
        default: "",
        describe:
          "Will create a new update set with the provided name to store all changes into",
      },
      ci: {
        type: "boolean",
        default: false,
        describe: "Will skip confirmation prompts during the push process",
      },
      pushConcurrency: {
        alias: ["push-concurrency", "concurrency"],
        type: "number",
        describe:
          "Max records pushed in parallel (1-50; overrides sync.config.js pushConcurrency, default 10)",
      },
    },
    examples: [
      ["$0 push --dry-run", "Preview what would be pushed without writing anything"],
      ["$0 push --concurrency 5", "Throttle to 5 parallel record pushes (slow networks)"],
      ["$0 push --diff main", "Push only the files changed vs the main branch (changed-only push)"],
      ["$0 push --ci", "Push without confirmation prompts (CI/automation)"],
    ],
    handler: typedHandler<Sync.PushCmdArgs>((args) => pushCommand(args)),
  },
  {
    command: "download <scope>",
    describe:
      "Downloads a scoped application's files from ServiceNow. Must specify a scope prefix for a scoped app.",
    options: {
      ci: {
        type: "boolean",
        default: false,
        describe: "Skip download confirmation prompt for noninteractive automation",
      },
    },
    examples: [
      ["$0 download x_my_app", "Download the x_my_app scope, overwriting local files"],
      ["$0 download x_my_app --dry-run", "Preview the download without overwriting anything"],
    ],
    handler: typedHandler<Sync.CmdDownloadArgs>((args) => downloadCommand(args)),
  },
  {
    command: "init",
    describe: "Provisions an initial project for you",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => initCommand(args)),
  },
  {
    command: "build",
    describe: "Build application files locally",
    options: {
      ...DIFF_OPTION,
      checkConfig: {
        alias: "check-config",
        type: "boolean",
        default: false,
        describe: "Validate sync.config.js rule order (detect shadowed rules) and exit without building",
      },
    },
    examples: [
      ["$0 build", "Build all source files into the local build directory"],
      ["$0 build --diff main", "Build and record a diff manifest vs the main branch for deploy"],
      ["$0 build --check-config", "Check that no rule is shadowed by an earlier, broader rule"],
    ],
    handler: typedHandler<Sync.BuildCmdArgs>((args) => buildCommand(args)),
  },
  {
    command: "deploy",
    describe: "Deploy local build files to the scoped application",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => deployCommand(args)),
  },
  {
    command: "docs",
    describe:
      "Generate or logically update Markdown documentation and diagrams for the local scope",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => docsCommand(args)),
  },
  {
    command: "status",
    describe: "Get information about the connected instance",
    options: {
      debugCredentials: {
        alias: "debug-credentials",
        type: "boolean",
        default: false,
        describe: "Print every credential source (env, profile, store) and which one won",
      },
    },
    examples: [
      ["$0 status", "Show instance, user, scope, credential source and connectivity"],
      ["$0 status --instance-profile dev", "Show status for the 'dev' credential profile"],
      ["$0 status --debug-credentials", "Explain where credentials resolve from and why"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { debugCredentials?: boolean }>((args) => statusCommand(args)),
  },
  {
    command: "check-env",
    describe: "Check OS, Node, WSL and Git prerequisites and print actionable fixes",
    examples: [["$0 check-env", "Verify your machine meets SyncroNow AI's prerequisites before init"]],
    handler: typedHandler<Sync.SharedCmdArgs>((args) => checkEnvCommand(args)),
  },
  {
    command: "doctor",
    describe: "Run local and connectivity diagnostics for the current SyncroNow AI workspace",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => doctorCommand(args)),
  },
  {
    command: "plugins",
    describe: "Show configured plugin rules and installed/missing plugin packages",
    handler: typedHandler<Sync.SharedCmdArgs>((args) => pluginsCommand(args)),
  },
  {
    command: "config <action>",
    describe: "Inspect configuration (action: show-defaults)",
    positionals: {
      action: {
        type: "string",
        describe: "config action",
        choices: ["show-defaults"],
      },
    },
    examples: [["$0 config show-defaults", "Print the built-in default includes/excludes and settings"]],
    handler: typedHandler<Sync.SharedCmdArgs & { action: string }>((args) => configCommand(args)),
  },
  {
    command: "mcp",
    describe:
      "Start standalone MCP server and optionally auto-configure local MCP client files",
    examples: [
      ["$0 mcp", "Auto-configure local MCP client files and start the MCP server"],
      ["$0 mcp --no-start", "Only write .vscode/mcp.json and secrets, do not start the server"],
    ],
    options: {
      autoConfigure: {
        alias: ["auto-configure", "configure"],
        type: "boolean",
        default: true,
        describe: "Write/update .vscode/mcp.json and .syncrona-mcp/secrets.json before start",
      },
      start: {
        type: "boolean",
        default: true,
        describe: "Start MCP server process after configuration",
      },
      mcpServerPath: {
        alias: "mcp-server-path",
        type: "string",
        default: "",
        describe: "Override MCP server entrypoint path",
      },
    },
    handler: typedHandler<Sync.SharedCmdArgs & { autoConfigure?: boolean; start?: boolean; mcpServerPath?: string; }>((args) => mcpCommand(args)),
  },
  {
    command: "login [instance]",
    describe: "Save ServiceNow credentials to the global credential store",
    includeSharedOptions: false,
    positionals: {
      instance: {
        type: "string",
        describe: "Instance hostname (e.g. dev12345.service-now.com)",
      },
    },
    examples: [
      ["$0 login", "Prompt for instance and credentials, then save them"],
      ["$0 login dev12345.service-now.com", "Save credentials for a specific instance"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { instance?: string }>((args) => loginCommand(args)),
  },
  {
    command: "logout [instance]",
    describe: "Remove saved credentials from the global credential store",
    includeSharedOptions: false,
    positionals: {
      instance: {
        type: "string",
        describe: "Instance hostname to log out from",
      },
    },
    options: {
      all: {
        type: "boolean",
        default: false,
        describe: "Remove credentials for all saved instances",
      },
    },
    handler: typedHandler<Sync.SharedCmdArgs & { instance?: string; all?: boolean }>((args) => logoutCommand(args)),
  },
  {
    command: "instances",
    describe: "List all instances saved in the global credential store",
    includeSharedOptions: false,
    handler: typedHandler<Sync.SharedCmdArgs>((args) => instancesCommand(args)),
  },
  {
    command: "use <instance>",
    describe: "Set the active instance from the global credential store",
    includeSharedOptions: false,
    positionals: {
      instance: {
        type: "string",
        describe: "Instance hostname to set as active",
      },
    },
    examples: [["$0 use dev12345.service-now.com", "Make this stored instance the active one for later commands"]],
    handler: typedHandler<Sync.SharedCmdArgs & { instance: string }>((args) => useCommand(args)),
  },
];
