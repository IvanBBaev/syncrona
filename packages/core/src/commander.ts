import { Sync } from "@syncrona/types";
import {
  downloadCommand,
  initCommand,
  buildCommand,
  deployCommand,
  docsCommand,
} from "./commands";
import { pushCommand } from "./pushCommand";
import { statusCommand, doctorCommand, pluginsCommand } from "./diagnosticsCommands";
import { mcpCommand } from "./mcpCommand";
import { devCommand, refreshCommand } from "./devCommands";
import {
  loginCommand,
  logoutCommand,
  instancesCommand,
  useCommand,
} from "./authCommands";
import yargs from "yargs";
import type { Arguments, Options } from "yargs";
export async function initCommands() {
  const sharedOptions: Record<string, Options> = {
    logLevel: {
      type: "string",
      default: "info"
    },
    dryRun: {
      alias: "dry-run",
      type: "boolean",
      default: false,
      describe: "Preview command effects without writing files or applying remote changes"
    },
    instanceProfile: {
      alias: "instance-profile",
      type: "string",
      describe:
        "Credential profile suffix for SN_* env vars (ex. --instance-profile dev uses SN_INSTANCE_DEV/SN_USER_DEV/SN_PASSWORD_DEV)"
    }
  };

  yargs
    .command(["dev", "d"], "Start Development Mode", sharedOptions, (args: Arguments) => {
      devCommand(args as unknown as Sync.SharedCmdArgs);
    })
    .command(
      ["refresh", "r"],
      "Refresh Manifest and download new files synce last refresh",
      sharedOptions,
      (args: Arguments) => {
        refreshCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      ["push [target]"],
      "[DESTRUCTIVE] Push all files from current local files to ServiceNow instance.",
      cmdArgs => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against"
          },
          scopeSwap: {
            alias: "ss",
            type: "boolean",
            default: false,
            describe:
              "Will auto-swap to the correct scope for the files being pushed"
          },
          updateSet: {
            alias: "us",
            type: "string",
            default: "",
            describe:
              "Will create a new update set with the provided anme to store all changes into"
          },
          ci: {
            type: "boolean",
            default: false,
            describe: "Will skip confirmation prompts during the push process"
          }
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        pushCommand(args as unknown as Sync.PushCmdArgs);
      }
    )
    .command(
      "download <scope>",
      "Downloads a scoped application's files from ServiceNow. Must specify a scope prefix for a scoped app.",
      cmdArgs => {
        cmdArgs.options({
          ...sharedOptions,
          ci: {
            type: "boolean",
            default: false,
            describe: "Skip download confirmation prompt for noninteractive automation"
          }
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        downloadCommand(args as unknown as Sync.CmdDownloadArgs);
      }
    )
    .command(
      "init",
      "Provisions an initial project for you",
      sharedOptions,
      (args: Arguments) => {
        initCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "build",
      "Build application files locally",
      cmdArgs => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against"
          }
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        buildCommand(args as unknown as Sync.BuildCmdArgs);
      }
    )
    .command(
      "deploy",
      "Deploy local build files to the scoped application",
      sharedOptions,
      (args: Arguments) => {
        deployCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "docs",
      "Generate or logically update Markdown documentation and diagrams for the local scope",
      sharedOptions,
      (args: Arguments) => {
        docsCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "status",
      "Get information about the connected instance",
      sharedOptions,
      (args: Arguments) => {
        statusCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "doctor",
      "Run local and connectivity diagnostics for the current syncrona workspace",
      sharedOptions,
      (args: Arguments) => {
        doctorCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "plugins",
      "Show configured plugin rules and installed/missing plugin packages",
      sharedOptions,
      (args: Arguments) => {
        pluginsCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "mcp",
      "Start standalone MCP server and optionally auto-configure local MCP client files",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
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
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        mcpCommand(args as unknown as Sync.SharedCmdArgs & { autoConfigure?: boolean; start?: boolean; mcpServerPath?: string });
      }
    )
    .command(
      "login [instance]",
      "Save ServiceNow credentials to the global credential store",
      (cmdArgs) => {
        cmdArgs.positional("instance", {
          type: "string",
          describe: "Instance hostname (e.g. dev12345.service-now.com)",
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        loginCommand(args as unknown as Sync.SharedCmdArgs & { instance?: string });
      }
    )
    .command(
      "logout [instance]",
      "Remove saved credentials from the global credential store",
      (cmdArgs) => {
        cmdArgs
          .positional("instance", {
            type: "string",
            describe: "Instance hostname to log out from",
          })
          .option("all", {
            type: "boolean",
            default: false,
            describe: "Remove credentials for all saved instances",
          });
        return cmdArgs;
      },
      (args: Arguments) => {
        logoutCommand(args as unknown as Sync.SharedCmdArgs & { instance?: string; all?: boolean });
      }
    )
    .command(
      "instances",
      "List all instances saved in the global credential store",
      {},
      (args: Arguments) => {
        instancesCommand(args as unknown as Sync.SharedCmdArgs);
      }
    )
    .command(
      "use <instance>",
      "Set the active instance from the global credential store",
      (cmdArgs) => {
        cmdArgs.positional("instance", {
          type: "string",
          describe: "Instance hostname to set as active",
        });
        return cmdArgs;
      },
      (args: Arguments) => {
        useCommand(args as unknown as Sync.SharedCmdArgs & { instance: string });
      }
    )
    .help().argv;
}
