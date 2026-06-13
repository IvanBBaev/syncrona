import type { CmdResult } from "../processRunner";
import { commandResultToText } from "../runtimeUtils";
import vm from "node:vm";


import type { ToolResponse } from "../toolResponse";

type WorkspaceToolContext = {
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  allowFullNodeAccess?: boolean;
  runSyncroCliCommand: (
    subcommand: string,
    args: string[],
    timeoutMs: number
  ) => Promise<CmdResult>;
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number
  ) => Promise<CmdResult>;
  isUnsafeWorkspaceCommand: (command: string, args: string[]) => boolean;
  makeDryRunAuditResponse: (
    toolName: string,
    args: Record<string, unknown>,
    details: Record<string, unknown>
  ) => ToolResponse;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

function stringifySandboxValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function executeSandboxedNodeCode(code: string, timeoutMs: number): CmdResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let timedOut = false;

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      stdout.push(args.map(stringifySandboxValue).join(" "));
    },
    info: (...args: unknown[]) => {
      stdout.push(args.map(stringifySandboxValue).join(" "));
    },
    warn: (...args: unknown[]) => {
      stderr.push(args.map(stringifySandboxValue).join(" "));
    },
    error: (...args: unknown[]) => {
      stderr.push(args.map(stringifySandboxValue).join(" "));
    },
  };

  try {
    const script = new vm.Script(code, {
      filename: "mcp-run_node_code.vm.js",
    });
    const context = vm.createContext(
      {
        console: sandboxConsole,
      },
      {
        name: "syncrona-run-node-code",
        codeGeneration: {
          strings: false,
          wasm: false,
        },
      }
    );

    const result = script.runInContext(context, {
      timeout: Math.min(Math.max(timeoutMs, 100), 30000),
      displayErrors: true,
      breakOnSigint: true,
    });

    if (result && typeof (result as Promise<unknown>).then === "function") {
      stderr.push("Async results are not supported in sandboxed run_node_code.");
      return {
        exitCode: 1,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
        timedOut,
      };
    }

    return {
      exitCode: 0,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      timedOut,
    };
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err && err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      timedOut = true;
      stderr.push("Sandboxed code execution timed out.");
    } else {
      stderr.push(err?.message || String(error));
    }

    return {
      exitCode: 1,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      timedOut,
    };
  }
}

export async function handleWorkspaceTool(
  toolName: string,
  args: Record<string, unknown>,
  context: WorkspaceToolContext
): Promise<ToolResponse | null> {
  const { timeoutMs, dryRun, startedAt } = context;

  switch (toolName) {
    case "sync_status": {
      const logLevel = typeof args.logLevel === "string" ? args.logLevel : "info";
      const result = await context.runSyncroCliCommand("status", ["--logLevel", logLevel], timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    case "sync_refresh": {
      const logLevel = typeof args.logLevel === "string" ? args.logLevel : "info";
      const result = await context.runSyncroCliCommand("refresh", ["--logLevel", logLevel], timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    case "sync_build": {
      const logLevel = typeof args.logLevel === "string" ? args.logLevel : "info";
      const diff = typeof args.diff === "string" ? args.diff.trim() : "";
      const cmdArgs = ["--logLevel", logLevel];
      if (diff.length > 0) {
        cmdArgs.push("--diff", diff);
      }
      const result = await context.runSyncroCliCommand("build", cmdArgs, timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    case "sync_push": {
      const confirmDestructive = args.confirmDestructive === true;
      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Push is destructive. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          target: typeof args.target === "string" ? args.target.trim() : "",
          diff: typeof args.diff === "string" ? args.diff.trim() : "",
          updateSet: typeof args.updateSet === "string" ? args.updateSet.trim() : "",
          scopeSwap: args.scopeSwap === true,
        });
      }

      const logLevel = typeof args.logLevel === "string" ? args.logLevel : "info";
      const target = typeof args.target === "string" ? args.target.trim() : "";
      const diff = typeof args.diff === "string" ? args.diff.trim() : "";
      const updateSet = typeof args.updateSet === "string" ? args.updateSet.trim() : "";
      const scopeSwap = args.scopeSwap === true;

      const cmdArgs = ["--ci", "--logLevel", logLevel];
      if (target.length > 0) {
        cmdArgs.push(target);
      }
      if (diff.length > 0) {
        cmdArgs.push("--diff", diff);
      }
      if (scopeSwap) {
        cmdArgs.push("--scopeSwap");
      }
      if (updateSet.length > 0) {
        cmdArgs.push("--updateSet", updateSet);
      }

      const result = await context.runSyncroCliCommand("push", cmdArgs, timeoutMs);
      context.auditMutatingTool(toolName, args, { exitCode: result.exitCode, timedOut: result.timedOut }, Date.now() - startedAt);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    case "run_workspace_command": {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const cmdArgs = Array.isArray(args.args)
        ? args.args.filter((item): item is string => typeof item === "string")
        : [];
      const confirmDestructive = args.confirmDestructive === true;

      if (!command) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: command" }],
        };
      }

      if (context.isUnsafeWorkspaceCommand(command, cmdArgs)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Blocked unsafe command. Shell interpreter execution with -c/--command is not allowed.",
            },
          ],
        };
      }

      const joined = `${command} ${cmdArgs.join(" ")}`.toLowerCase();
      const seemsDestructive =
        joined.includes("sync push") ||
        joined.includes("sync deploy") ||
        joined.includes("sync download");

      if (seemsDestructive && !confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "This command may modify instance state. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      const result = await context.runCommand(command, cmdArgs, timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    case "run_node_code": {
      const code = typeof args.code === "string" ? args.code : "";
      const confirmDestructive = args.confirmDestructive === true;
      if (!code.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: code" }],
        };
      }

      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Running Node.js code may modify workspace or environment state. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      if (context.isUnsafeWorkspaceCommand("node", ["-e", code])) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Blocked unsafe command. Shell interpreter execution with -c/--command is not allowed.",
            },
          ],
        };
      }

      const result = context.allowFullNodeAccess
        ? await context.runCommand("node", ["-e", code], timeoutMs)
        : executeSandboxedNodeCode(code, timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    default:
      return null;
  }
}
