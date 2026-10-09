// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import type { Arguments, Options, PositionalOptions } from "yargs";
import {
  downloadCommand,
  initCommand,
  buildCommand,
  deployCommand,
  docsCommand,
} from "./commands.js";
import { pushCommand } from "./pushCommand.js";
import { repairCommand } from "./repairCommand.js";
import { statusCommand, doctorCommand, pluginsCommand, checkEnvCommand, configCommand } from "./diagnosticsCommands.js";
import { mcpCommand } from "./mcpCommand.js";
import { devCommand, refreshCommand } from "./devCommands.js";
import {
  loginCommand,
  logoutCommand,
  instancesCommand,
  useCommand,
} from "./authCommands.js";
import {
  jiraCommand,
  jiraLoginCommand,
  jiraLogoutCommand,
} from "./jiraCommands.js";
import { completionCommand } from "./completionCommand.js";
import { mirrorCommand, MIRROR_ACTIONS } from "./mirrorCommand.js";
import {
  queryCommand,
  QUERY_DEFAULT_LIMIT,
  QUERY_DEFAULT_TIMEOUT_MS,
  QUERY_DISPLAY_VALUES,
  QUERY_OUTPUT_FORMATS,
  type QueryCmdArgs,
} from "./queryCommand.js";
import { cicdCommand, CICD_ACTIONS, type CicdCmdArgs } from "./cicdCommand.js";
import { fluentCommand, FLUENT_ACTIONS, type FluentCmdArgs } from "./fluentCommand.js";
import type { InitCmdArgs } from "./appCreator.js";
import { LOG_LEVELS } from "./Logger.js";

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
  /**
   * Set false for a command that takes the shared options but has no preview
   * mode. `--dry-run` is then refused with an explanation instead of parsed and
   * silently ignored — a silently-ignored `--dry-run` is the worst outcome
   * available, because the user asked for a preview, got a real run, and the
   * command reported nothing unusual. Omitted (the default) means the command
   * honours the flag; `commander.ts` enforces the contract.
   */
  supportsDryRun?: boolean;
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
    // An unknown level is not a louder or quieter run — winston silences the
    // whole command. Reject it at parse time and show the real level set.
    choices: LOG_LEVELS,
    describe: "Console verbosity",
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
    // A watcher that pushes every save has nothing to preview: the writes it
    // makes are the ones the user has not typed yet.
    supportsDryRun: false,
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
    supportsDryRun: false,
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
      // No default on purpose: "not given" must stay distinguishable from
      // `--no-create`, so createRecords in sync.config.js can decide only when
      // the flag is absent.
      create: {
        type: "boolean",
        describe:
          "Create (or adopt) records for local files not in the manifest yet (default: createRecords in sync.config.js, else off)",
      },
      prune: {
        type: "boolean",
        default: false,
        describe:
          "[DESTRUCTIVE] Delete instance records whose tracked files git shows deleted (in-scope only; with --diff, only files the diff deletes; confirms unless --ci)",
      },
      allowMassDelete: {
        type: "boolean",
        alias: "allow-mass-delete",
        default: false,
        describe:
          "With --prune, allow more than 25 deletions or over 20% of the manifest, and --ci without --diff or a target",
      },
    },
    examples: [
      ["$0 push --create", "Also create records for new local files that are not in the manifest yet"],
      ["$0 push --diff main --prune", "Also delete the records whose files were deleted since main"],
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
    options: {
      ci: {
        type: "boolean",
        default: false,
        describe: "Skip the all-scope init confirmation prompt for noninteractive automation",
      },
      new: {
        type: "boolean",
        describe: "Create a new scoped application on the instance and bind this directory to it",
      },
      name: {
        type: "string",
        describe: "--new: display name of the new application",
      },
      scope: {
        type: "string",
        describe: "--new: scope (x_<prefix>_<name>, max 18 chars); derived from --name by default",
      },
      vendorPrefix: {
        alias: "vendor-prefix",
        type: "string",
        describe: "--new: vendor prefix (company code); read from the instance by default",
      },
    },
    examples: [
      ["$0 init", "Provision a project, confirming before any folders are created"],
      ["$0 init --ci", "Initialize every scope a detected .env exposes without prompting"],
      ['$0 init --new --name "Asset Tracker"', "Create x_<prefix>_asset_tracker and bind this directory to it"],
      ['$0 init --new --name "Asset Tracker" --dry-run', "Print the sys_app body init --new would send"],
    ],
    handler: typedHandler<InitCmdArgs>((args) => initCommand(args)),
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
    options: {
      ci: {
        type: "boolean",
        default: false,
        describe: "Skip the deploy confirmation prompt for noninteractive automation",
      },
    },
    examples: [
      ["$0 deploy", "Deploy the local build directory, confirming before overwriting"],
      ["$0 deploy --ci", "Deploy without the confirmation prompt (CI/automation)"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs>((args) => deployCommand(args)),
  },
  {
    command: "docs",
    describe:
      "Generate or logically update Markdown documentation and diagrams for the local scope",
    // scopeDocs writes the Markdown and the diagrams unconditionally; there is
    // no plan-only path through the generator.
    supportsDryRun: false,
    handler: typedHandler<Sync.SharedCmdArgs>((args) => docsCommand(args)),
  },
  {
    command: "repair",
    describe:
      "Reconcile the manifest with local files; report or re-download missing files and prune orphans",
    options: {
      apply: {
        type: "boolean",
        default: false,
        describe: "Apply repairs (re-download missing files); report-only without it",
      },
      prune: {
        type: "boolean",
        default: false,
        describe:
          "With --apply, also delete orphan files git holds committed and unchanged; new or edited " +
          "files and records awaiting push --create are kept",
      },
      ci: {
        type: "boolean",
        default: false,
        describe: "Skip the prune confirmation prompt for noninteractive automation",
      },
    },
    examples: [
      ["$0 repair", "Report missing and orphan files without changing anything"],
      ["$0 repair --apply", "Re-download files the manifest expects but are missing locally"],
      ["$0 repair --apply --prune --dry-run", "Preview which orphans a prune would delete and keep"],
      [
        "$0 repair --apply --prune --ci",
        "Re-download missing files and delete committed, unchanged orphans without prompting",
      ],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { apply?: boolean; prune?: boolean; ci?: boolean }>(
      (args) => repairCommand(args)
    ),
  },
  {
    command: "status",
    describe: "Get information about the connected instance",
    // Read-only already, so a preview of it would be the command itself.
    supportsDryRun: false,
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
    command: "query <table>",
    describe:
      "Query records from any table through the Table API (now-sdk query compatible; -o json prints {ok, hasMore, nextOffset, records})",
    // Read-only: a preview of a query would be the query itself.
    supportsDryRun: false,
    positionals: {
      table: {
        type: "string",
        describe: "ServiceNow table name (e.g. incident, sys_user)",
      },
    },
    options: {
      query: {
        alias: "q",
        type: "string",
        demandOption: true,
        describe: 'Encoded query (sysparm_query), e.g. "active=true^priority<=2"; pass "" for every row',
      },
      limit: {
        type: "number",
        default: QUERY_DEFAULT_LIMIT,
        describe: "Maximum records per page (sysparm_limit)",
      },
      offset: {
        type: "number",
        default: 0,
        describe: "Starting offset (sysparm_offset)",
      },
      fields: {
        alias: "f",
        type: "string",
        describe: "Comma-separated fields to return (sysparm_fields)",
      },
      displayValue: {
        alias: "display-value",
        type: "string",
        choices: [...QUERY_DISPLAY_VALUES],
        default: "false",
        describe: 'Return display values (sysparm_display_value): "true", "false", or "all" for both',
      },
      excludeReferenceLink: {
        alias: "exclude-reference-link",
        type: "boolean",
        default: true,
        describe: "Exclude reference link metadata (sysparm_exclude_reference_link); --no-exclude-reference-link keeps it",
      },
      count: {
        type: "boolean",
        default: true,
        describe: "Let the instance compute the total row count; --no-count skips it (sysparm_no_count)",
      },
      timeout: {
        type: "number",
        default: QUERY_DEFAULT_TIMEOUT_MS,
        describe: "Per-request timeout in milliseconds",
      },
      view: {
        type: "string",
        describe: "UI view that decides which fields to return (sysparm_view)",
      },
      queryCategory: {
        alias: "query-category",
        type: "string",
        describe: "Query category for extended queries (sysparm_query_category)",
      },
      queryNoDomain: {
        alias: "query-no-domain",
        type: "boolean",
        default: false,
        describe: "Ignore domain separation when querying (sysparm_query_no_domain)",
      },
      output: {
        alias: "o",
        type: "string",
        choices: [...QUERY_OUTPUT_FORMATS],
        describe: "Machine-readable output: print the {ok, hasMore, nextOffset, records} envelope only",
      },
    },
    examples: [
      ['$0 query incident -q "active=true^priority=1"', "Print the first 100 active P1 incidents"],
      ["$0 query sys_user -q active=true -f sys_id,user_name --limit 10 --offset 10", "Fetch the second page of 10 users, two fields each"],
      ["$0 query sys_script_include -q api_name=x_app.Util -o json", "Emit the now-sdk compatible JSON envelope for scripting"],
    ],
    handler: typedHandler<QueryCmdArgs>((args) => queryCommand(args)),
  },
  {
    command: "check-env",
    describe: "Check OS, Node, WSL and Git prerequisites and print actionable fixes",
    supportsDryRun: false,
    examples: [["$0 check-env", "Verify your machine meets SyncroNow AI's prerequisites before init"]],
    handler: typedHandler<Sync.SharedCmdArgs>((args) => checkEnvCommand(args)),
  },
  {
    command: "doctor",
    describe: "Run local and connectivity diagnostics for the current SyncroNow AI workspace",
    supportsDryRun: false,
    handler: typedHandler<Sync.SharedCmdArgs>((args) => doctorCommand(args)),
  },
  {
    command: "plugins",
    describe: "Show configured plugin rules and installed/missing plugin packages",
    supportsDryRun: false,
    handler: typedHandler<Sync.SharedCmdArgs>((args) => pluginsCommand(args)),
  },
  {
    command: "config <action>",
    describe: "Inspect or extend configuration (action: show-defaults, add-plugin)",
    // Both actions only print (`add-plugin` emits the install command and a
    // paste-ready snippet rather than editing sync.config.js), so there is
    // nothing for a preview to withhold.
    supportsDryRun: false,
    positionals: {
      action: {
        type: "string",
        describe: "config action",
        choices: ["show-defaults", "add-plugin"],
      },
    },
    options: {
      plugin: {
        type: "string",
        describe: "Plugin to wire for `add-plugin` (e.g. typescript, babel, sass)",
      },
    },
    examples: [
      ["$0 config show-defaults", "Print the built-in default includes/excludes and settings"],
      ["$0 config add-plugin", "List the first-party build plugins and which are installed"],
      ["$0 config add-plugin --plugin typescript", "Print the install command and a paste-ready rules snippet"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { action: string; plugin?: string }>((args) => configCommand(args)),
  },
  {
    command: "completion [shell]",
    describe:
      "Print a bash or zsh completion script (shell auto-detected from $SHELL when omitted)",
    includeSharedOptions: false,
    positionals: {
      shell: {
        type: "string",
        describe: "Target shell for the completion script (default: derived from $SHELL)",
        choices: ["bash", "zsh"],
      },
    },
    examples: [
      ["$0 completion", "Print a completion script for the shell in $SHELL"],
      ["$0 completion bash >> ~/.bashrc", "Install bash tab completion for syncrona"],
      ["$0 completion zsh >> ~/.zshrc", "Install zsh tab completion for syncrona"],
    ],
    // The live registry is passed in so the emitted script always completes
    // exactly the commands registered here (see completionCommand.ts).
    handler: typedHandler<Sync.SharedCmdArgs & { shell?: string }>((args) =>
      completionCommand(args, CLI_COMMANDS)
    ),
  },
  {
    command: "mcp",
    describe:
      "Start standalone MCP server and optionally auto-configure local MCP client files",
    // `--no-start` / `--no-auto-configure` are the real levers here; --dry-run
    // would still write .vscode/mcp.json and the secrets file.
    supportsDryRun: false,
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
    options: {
      authMethod: {
        alias: "auth-method",
        type: "string",
        describe:
          "Authentication method: basic | oauth-password | oauth-client-credentials | oauth-jwt-bearer | api-key",
      },
      user: {
        type: "string",
        describe: "Username (basic / oauth-password)",
      },
      password: {
        type: "string",
        describe: "Password (basic / oauth-password)",
      },
      clientId: {
        alias: "client-id",
        type: "string",
        describe: "OAuth client id (oauth-password / client-credentials / jwt-bearer)",
      },
      clientSecret: {
        alias: "client-secret",
        type: "string",
        describe: "OAuth client secret",
      },
      apiKey: {
        alias: "api-key",
        type: "string",
        describe: "Inbound REST API key value (api-key method)",
      },
      apiKeyHeader: {
        alias: "api-key-header",
        type: "string",
        describe: "Override the API key header name (default x-sn-apikey)",
      },
      jwtKey: {
        alias: "jwt-key",
        type: "string",
        describe: "Path to the JWT signing key PEM (jwt-bearer method)",
      },
      jwtKid: {
        alias: "jwt-kid",
        type: "string",
        describe: "JWT header key id (jwt-bearer)",
      },
      jwtIss: {
        alias: "jwt-iss",
        type: "string",
        describe: "JWT issuer claim (jwt-bearer)",
      },
      jwtSub: {
        alias: "jwt-sub",
        type: "string",
        describe: "JWT subject claim (jwt-bearer)",
      },
      jwtAud: {
        alias: "jwt-aud",
        type: "string",
        describe: "JWT audience claim (jwt-bearer)",
      },
      clientCert: {
        alias: "client-cert",
        type: "string",
        describe: "Path to the client certificate PEM for mutual TLS",
      },
      clientKey: {
        alias: "client-key",
        type: "string",
        describe: "Path to the client private key PEM for mutual TLS",
      },
      clientKeyPassphrase: {
        alias: "client-key-passphrase",
        type: "string",
        describe: "Passphrase for the mutual TLS client private key",
      },
    },
    examples: [
      ["$0 login", "Prompt for instance, method, and credentials, then save them"],
      ["$0 login dev12345.service-now.com", "Save credentials for a specific instance"],
      [
        "$0 login --auth-method api-key --api-key XXXX",
        "Non-interactive login with an inbound REST API key",
      ],
    ],
    handler: typedHandler<
      Sync.SharedCmdArgs & {
        instance?: string;
        authMethod?: string;
        user?: string;
        password?: string;
        clientId?: string;
        clientSecret?: string;
        apiKey?: string;
        apiKeyHeader?: string;
        jwtKey?: string;
        jwtKid?: string;
        jwtIss?: string;
        jwtSub?: string;
        jwtAud?: string;
        clientCert?: string;
        clientKey?: string;
        clientKeyPassphrase?: string;
      }
    >((args) => loginCommand(args)),
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
  {
    command: "jira [key]",
    describe:
      "Show rich context for a Jira issue (key, or inferred from the git branch)",
    includeSharedOptions: false,
    positionals: {
      key: {
        type: "string",
        describe: "Jira issue key (e.g. PROJ-123); omit to infer from the branch",
      },
    },
    options: {
      logLevel: { ...SHARED_CLI_OPTIONS.logLevel },
      profile: {
        type: "string",
        describe: "Jira credential profile to use (default: default)",
      },
      comments: {
        type: "number",
        default: 5,
        describe: "Number of most-recent comments to include (0 to omit)",
      },
      json: {
        type: "boolean",
        default: false,
        describe: "Print the normalized issue as raw JSON instead of formatted text",
      },
    },
    examples: [
      ["$0 jira PROJ-123", "Print rich context for issue PROJ-123"],
      ["$0 jira", "Infer the issue key from the current git branch and print it"],
      ["$0 jira PROJ-123 --json", "Emit the normalized issue as JSON for scripting"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { key?: string; profile?: string; comments?: number; json?: boolean }>(
      (args) => jiraCommand(args)
    ),
  },
  {
    command: "jira-login",
    describe: "Save Jira credentials (Cloud API token or Server/DC PAT) to the credential store",
    includeSharedOptions: false,
    options: {
      logLevel: { ...SHARED_CLI_OPTIONS.logLevel },
      profile: {
        type: "string",
        describe: "Jira credential profile to save under (default: default)",
      },
    },
    examples: [
      ["$0 jira-login", "Prompt for base URL, deployment, and token, then verify and save"],
      ["$0 jira-login --profile work", "Save Jira credentials under the 'work' profile"],
    ],
    handler: typedHandler<Sync.SharedCmdArgs & { profile?: string }>((args) => jiraLoginCommand(args)),
  },
  {
    command: "jira-logout",
    describe: "Remove saved Jira credentials from the credential store",
    includeSharedOptions: false,
    options: {
      logLevel: { ...SHARED_CLI_OPTIONS.logLevel },
      profile: {
        type: "string",
        describe: "Jira credential profile to remove (default: default)",
      },
      all: {
        type: "boolean",
        default: false,
        describe: "Remove credentials for all Jira profiles",
      },
    },
    handler: typedHandler<Sync.SharedCmdArgs & { profile?: string; all?: boolean }>(
      (args) => jiraLogoutCommand(args)
    ),
  },
  {
    // One registry entry for five subcommands, because they share one engine and
    // one credential resolution; splitting them into five top-level commands
    // would put `syncrona verify` next to `syncrona push` in `--help` and lose
    // the fact that all five only ever mean something inside a mirror repo.
    command: "mirror <action>",
    describe:
      "Full-instance git mirror (action: init, sync, status, verify, report); exits 2 on drift or findings",
    // The read-only preview of a sweep is a first-class action here — `mirror
    // status` compares the tree against the live instance and writes nothing —
    // so --dry-run has no separate meaning and is refused rather than ignored.
    supportsDryRun: false,
    positionals: {
      action: {
        type: "string",
        describe: "mirror action",
        choices: [...MIRROR_ACTIONS],
      },
    },
    options: {
      full: {
        type: "boolean",
        default: false,
        describe: "sync: sweep every included table instead of only what changed",
      },
      reconcile: {
        // The cheap half of `--full`. Deletions only reach the mirror on a sweep
        // that observed a table whole (INV-5), which the cadence schedules every
        // Nth sync; this forces one now without re-fetching unchanged rows.
        type: "boolean",
        default: false,
        describe: "sync: force this sweep to reconcile deletions, without waiting for the cadence",
      },
      verifyQuiescent: {
        // Declared explicitly rather than left to yargs' camel-case expansion:
        // the expansion parses `--verify-quiescent` but does not PRINT it, and
        // the kebab spelling is the one the design and the README name.
        alias: "verify-quiescent",
        type: "boolean",
        default: false,
        describe: "sync: re-read row counts after the sweep and report tables that moved under it",
      },
      deep: {
        type: "boolean",
        default: false,
        describe: "status/verify: also re-hash sampled records instead of comparing aggregates only",
      },
      json: {
        type: "boolean",
        default: false,
        describe: "Emit the machine-readable result instead of the human rendering",
      },
    },
    examples: [
      ["$0 mirror init", "Provision the current repository for a million-file mirror"],
      ["$0 mirror sync --full", "Run a complete baseline sweep of the instance"],
      ["$0 mirror status", "Compare the mirrored tree against the live instance (exit 2 on drift)"],
      ["$0 mirror verify --deep", "Check the tree against its own manifests, offline"],
      ["$0 mirror report --json", "Re-print the last sweep's machine report and its exit code"],
    ],
    handler: typedHandler<
      Sync.SharedCmdArgs & {
        action: string;
        full?: boolean;
        reconcile?: boolean;
        verifyQuiescent?: boolean;
        deep?: boolean;
        json?: boolean;
      }
    >((args) => mirrorCommand(args)),
  },
  {
    // WP-5 (R6): the CI/CD REST API (`api/sn_cicd/*`). One entry for five
    // subcommands for the same reason as `mirror`: they share one dispatch-then-
    // poll engine, one exit-code contract and one set of credentials.
    command: "cicd <action>",
    describe:
      "Run ATF and app-repo CI/CD actions (action: run-suite, run-test, install, publish, rollback); exits 2 on test failures",
    // The dispatch POST is the whole effect — there is nothing to preview short
    // of not sending it — so --dry-run is refused rather than ignored.
    supportsDryRun: false,
    positionals: {
      action: {
        type: "string",
        describe: "cicd action",
        choices: [...CICD_ACTIONS],
      },
    },
    options: {
      suiteId: { alias: "suite-id", type: "string", describe: "run-suite: sys_id of the ATF test suite" },
      suiteName: { alias: "suite-name", type: "string", describe: "run-suite: name of the ATF test suite" },
      testId: { alias: "test-id", type: "string", describe: "run-test: sys_id of the ATF test" },
      browserName: {
        alias: "browser-name",
        type: "string",
        describe: "run-suite: browser to run UI tests in (e.g. chrome, firefox, any)",
      },
      browserVersion: { alias: "browser-version", type: "string", describe: "run-suite: browser version" },
      osName: { alias: "os-name", type: "string", describe: "run-suite: operating system of the client runner" },
      osVersion: { alias: "os-version", type: "string", describe: "run-suite: operating system version" },
      runInCloud: {
        alias: "run-in-cloud",
        type: "boolean",
        describe: "run-suite/run-test: run on the cloud runner instead of a local client test runner",
      },
      performance: { type: "boolean", describe: "run-suite: mark the run as a performance run" },
      captureNodeLogs: {
        alias: "capture-node-logs",
        type: "boolean",
        describe: "run-test: capture node logs for the run",
      },
      scope: { type: "string", describe: "install/publish/rollback: application scope (e.g. x_acme_app)" },
      appSysId: {
        alias: "app-sys-id",
        type: "string",
        describe: "install/publish/rollback: application sys_id (instead of --scope)",
      },
      appVersion: {
        // Not `--version`: yargs reserves it for the CLI's own version.
        alias: "app-version",
        type: "string",
        describe: "install/publish: application version; rollback: the version to roll back to (required)",
      },
      baseAppVersion: { alias: "base-app-version", type: "string", describe: "install: base application version" },
      autoUpgradeBaseApp: {
        alias: "auto-upgrade-base-app",
        type: "boolean",
        describe: "install: upgrade the base application when the requested version needs it",
      },
      devNotes: { alias: "dev-notes", type: "string", describe: "publish: developer notes for the published version" },
      progressId: {
        alias: "progress-id",
        type: "string",
        describe:
          "Resume: poll this existing sn_cicd progress tracker (sys_id) instead of dispatching new work; dispatch flags are ignored",
      },
      pollMs: {
        alias: "poll-ms",
        type: "number",
        default: 1000,
        describe: "Milliseconds between progress polls",
      },
      timeout: {
        type: "number",
        default: 3600,
        describe: "Seconds to wait for the work to finish before exiting 1",
      },
      json: {
        type: "boolean",
        default: false,
        describe: "Emit the machine-readable result instead of the human rendering",
      },
    },
    examples: [
      ["$0 cicd run-suite --suite-name 'Smoke tests'", "Run an ATF suite and exit 2 if any test fails"],
      ["$0 cicd run-test --test-id <sys_id> --json", "Run one ATF test and print the machine result"],
      ["$0 cicd install --scope x_acme_app --app-version 1.2.0", "Install an application version from the app repository"],
      ["$0 cicd publish --scope x_acme_app --app-version 1.3.0 --dev-notes 'Release'", "Publish the application to the app repository"],
      ["$0 cicd rollback --scope x_acme_app --app-version 1.2.0", "Roll the application back to a version"],
      ["$0 cicd install --progress-id <sys_id>", "Resume waiting on an install that outlived --timeout"],
    ],
    handler: typedHandler<CicdCmdArgs>((args) => cicdCommand(args)),
  },
  {
    // One entry for the whole Fluent tier, for the same reason as `mirror`: every
    // action drives one engine (the ServiceNow SDK orchestrator, through the
    // optional @syncrona/fluent adapter) and only means something inside a
    // Fluent project. The adapter is loaded by the handler, never at startup.
    command: "fluent <action> [topic]",
    describe:
      "Fluent (.now.ts) apps via the ServiceNow SDK (action: init, build, transform, pack, install, types, dependencies, run, status, explain, move-to-app); needs @syncrona/fluent, except `types --native`",
    // `--dry-run` prints the SDK call each action would make, without loading the
    // SDK, resolving credentials or prompting.
    supportsDryRun: true,
    positionals: {
      action: {
        type: "string",
        describe: "fluent action",
        choices: [...FLUENT_ACTIONS],
      },
      topic: {
        type: "string",
        describe: "explain: topic name or keyword to look up in the SDK docs",
      },
    },
    options: {
      project: { type: "string", describe: "Fluent project directory (default: nearest now.config.json)" },
      json: { type: "boolean", default: false, describe: "Emit the machine-readable result" },
      ci: { type: "boolean", default: false, describe: "install, move-to-app: skip the confirmation prompt" },
      name: { type: "string", describe: "init: application name" },
      scope: {
        type: "string",
        describe: "init: application scope; dependencies: dependency scope; types --native: scope to generate",
      },
      packageName: { type: "string", describe: "init: npm package name (derived from the scope by default)" },
      description: { type: "string", describe: "init: application description" },
      template: { type: "string", describe: "init: SDK template id" },
      from: { type: "string", describe: "init: convert an existing instance application (scope sys_id)" },
      frozenKeys: { type: "boolean", describe: "build: fail when generated keys would change" },
      errorOnConflict: { type: "boolean", describe: "build: treat key conflicts as errors" },
      skipClean: { type: "boolean", describe: "build: keep the previous output directory" },
      out: {
        type: "string",
        describe: "pack: output path for the application package; types --native: output .d.ts path",
      },
      reinstall: { type: "boolean", describe: "install: uninstall the application first, then install" },
      store: { type: "boolean", describe: "install: install as a store application" },
      sync: { type: "boolean", describe: "install: wait for the install instead of returning a tracker" },
      demoData: { type: "boolean", default: true, describe: "install: load demo data (--no-demo-data to skip)" },
      skipFlowActivation: { type: "boolean", describe: "install: do not activate flows" },
      paths: { type: "string", describe: "transform: comma-separated source paths to convert locally" },
      table: {
        type: "string",
        describe: "transform: limit to tables (comma-separated); dependencies: table; types --native: tables to generate",
      },
      ids: {
        type: "string",
        describe: "dependencies: comma-separated record sys_ids; move-to-app: global records to move into the app",
      },
      updateSet: { type: "string", describe: "transform: convert one update set (sys_id)" },
      incremental: { type: "boolean", describe: "transform: only records changed since the last transform" },
      force: { type: "boolean", describe: "transform: overwrite existing Fluent sources" },
      scripts: { type: "boolean", describe: "types: also download script type definitions" },
      fluent: { type: "boolean", describe: "types: also download Fluent definitions" },
      native: {
        type: "boolean",
        describe: "types: generate table types from sys_dictionary without the SDK (the fallback when it is absent)",
      },
      script: { type: "string", describe: "run: project script to execute" },
      list: { type: "boolean", describe: "explain: list topics (filtered by the topic when one is given)" },
      peek: { type: "boolean", describe: "explain: show summaries instead of the full document" },
    },
    examples: [
      ["$0 fluent init --name 'My App' --scope x_acme_app", "Create a Fluent project in the current directory"],
      ["$0 fluent build", "Build the Fluent project (exit 2 on build errors)"],
      ["$0 fluent install --ci", "Install the packed application without prompting"],
      ["$0 fluent install --reinstall", "Uninstall the application, then install it again"],
      ["$0 fluent status", "Show the SDK version and the last install's progress"],
      ["$0 fluent build --dry-run", "Print the SDK call without running it"],
      ["$0 fluent types --native", "Generate the scope's table types without the SDK"],
      ["$0 fluent explain table", "Read the SDK's documentation on a topic, offline"],
      ["$0 fluent move-to-app --ids <sys_id>,<sys_id>", "Move global records into this global application"],
    ],
    handler: typedHandler<FluentCmdArgs>((args) => fluentCommand(args)),
  },
];
