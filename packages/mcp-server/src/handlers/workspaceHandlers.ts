// SPDX-License-Identifier: GPL-3.0-or-later
import type { CmdResult } from "../processRunner";
import { commandResultToText, toJsonText } from "../runtimeUtils";
import { requiresConfirmation } from "../safetyPolicy";


import type { ToolResponse } from "../toolResponse";

/**
 * JSON response for a CLI command result. The payload is serialized into the
 * text block and, on success, mirrored into MCP structuredContent (re-parsed
 * from the same text so both views are identical). sync_status/sync_refresh
 * declare an outputSchema, so their success results must carry conforming
 * structuredContent; failed runs (isError: true) are exempt per the MCP spec
 * and stay text-only.
 */
function commandJsonResponse(result: CmdResult): ToolResponse {
  const payload = {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  const text = toJsonText(payload);
  const isError = result.exitCode !== 0;
  const response: ToolResponse = {
    isError,
    content: [{ type: "text", text }],
  };
  if (!isError) {
    response.structuredContent = JSON.parse(text) as Record<string, unknown>;
  }
  return response;
}

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
    timeoutMs: number,
    cwd?: string,
    extraEnv?: Record<string, string>,
    envBase?: NodeJS.ProcessEnv
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

// REV-82 (SEC-1): env-scrubbing helper (defense-in-depth).
//
// Strips every environment key that could carry a ServiceNow/OAuth secret or the
// credential-store key before it is handed to a child process, so a compromised
// or hostile snippet cannot read `SN_PASSWORD`, `SYNCRONA_STORE_KEY`, an OAuth
// `*_TOKEN`, etc. Matching is case-insensitive: `SN_*`, `SYNCRONA_*` (which
// covers `SYNCRONA_STORE_KEY`), suffixes like `_TOKEN`/`_SECRET`/`_PASSWORD`/
// `_PASSWD`/`_PASSPHRASE`/`_KEY`, and — broadened for REV-116 — substrings such
// as PASSWORD/PASSWD/PASSPHRASE/SECRET/TOKEN/APIKEY/API_KEY/CREDENTIAL plus the
// well-known AWS credential keys. Broadening only ever removes MORE keys from a
// child's env, which is fail-safe; the helper is shared by run_node_code full
// mode and the run_workspace_command scrub.
function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.startsWith("SN_") ||
    upper.startsWith("SYNCRONA_") ||
    upper.endsWith("_TOKEN") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_PASSWORD") ||
    upper.endsWith("_PASSWD") ||
    upper.endsWith("_PASSPHRASE") ||
    upper.endsWith("_KEY") ||
    upper.includes("PASSWORD") ||
    upper.includes("PASSWD") ||
    upper.includes("PASSPHRASE") ||
    upper.includes("SECRET") ||
    upper.includes("TOKEN") ||
    upper.includes("APIKEY") ||
    upper.includes("API_KEY") ||
    upper.includes("CREDENTIAL") ||
    upper === "AWS_ACCESS_KEY_ID" ||
    upper === "AWS_SESSION_TOKEN"
  );
}

/**
 * Returns a shallow copy of `env` with secret-bearing keys removed. Exported so
 * a child-process runner (or a test) can obtain a reduced environment that can
 * no longer leak credentials even if in-process isolation is bypassed.
 */
export function scrubSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isSecretEnvKey(key)) {
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}

/**
 * REV-82 (SEC-1): full-access Node execution via a real child process.
 *
 * There is deliberately no in-process "safe" sandbox any more. `vm.createContext`
 * is not a security boundary: the host-realm `Function` reached through
 * `console.log.constructor` escapes the context back to the real `process`, which
 * gave a reproduced host RCE, secret exfiltration, and host prototype pollution
 * (see docs/ai/repro/sec1-vm-escape.cjs). A subprocess is the only mechanism that
 * can actually contain the code.
 *
 * Full mode is an explicit opt-in to host access (allowFullNodeAccess), so it runs
 * actual Node through the shell:false runner. Two defenses apply, but (REV-129,
 * honest-limits) NEITHER is an isolation boundary — run_node_code (full mode) and
 * run_workspace_command are host-privilege primitives by design, and code that
 * reaches them already has the host's privileges:
 *   - `--disallow-code-generation-from-strings` disables eval / new Function INSIDE
 *     the child. It does not stop the child from requiring modules or spawning
 *     further processes.
 *   - The child is spawned with scrubSecretsFromEnv(process.env), which removes
 *     secret-bearing keys from the child's OWN environment. This is defense-in-depth
 *     — it blocks naive `process.env.SN_PASSWORD` reads and stops the secrets being
 *     INHERITED by anything the child itself spawns — NOT isolation. On Linux a child
 *     can still read the PARENT's exec-time environment via /proc/<ppid>/environ, and
 *     with host access it can read credential files, the OS keychain, or memory. Do
 *     not rely on the scrub to contain a hostile script; rely on the confirmation gate
 *     and the allowFullNodeAccess opt-in that guard REACHING this primitive.
 */
function runFullNodeAccessCode(
  runCommand: WorkspaceToolContext["runCommand"],
  code: string,
  timeoutMs: number
): Promise<CmdResult> {
  return runCommand(
    "node",
    ["--disallow-code-generation-from-strings", "-e", code],
    timeoutMs,
    undefined,
    undefined,
    scrubSecretsFromEnv(process.env)
  );
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
      return commandJsonResponse(result);
    }

    case "sync_refresh": {
      const logLevel = typeof args.logLevel === "string" ? args.logLevel : "info";
      const result = await context.runSyncroCliCommand("refresh", ["--logLevel", logLevel], timeoutMs);
      return commandJsonResponse(result);
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

      // REV-83 (SEC-2): default-deny allowlist. requiresConfirmation returns true
      // for anything not on the read-only allowlist (every interpreter/wrapper —
      // node, python3, perl, ruby, php, env, find, xargs, … — plus mutating git
      // subcommands and destructive syncrona subcommands). The old
      // isDestructiveWorkspaceCommand denylist silently allowed all of those.
      if (requiresConfirmation(command, cmdArgs) && !confirmDestructive) {
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

      // SEC-1 follow-up (REV-116): run_workspace_command can also run `node -e ...`,
      // so it must spawn with the same credential-scrubbed base env as run_node_code's
      // full mode — otherwise the scrub is trivially bypassed via this sibling tool.
      const result = await context.runCommand(
        command,
        cmdArgs,
        timeoutMs,
        undefined,
        undefined,
        scrubSecretsFromEnv(process.env)
      );
      // A destructive invocation reaches the instance exactly like sync_push, so
      // it owes the same mutation audit entry; auditMutatingTool decides from the
      // args whether this particular invocation was one.
      context.auditMutatingTool(toolName, args, { exitCode: result.exitCode, timedOut: result.timedOut }, Date.now() - startedAt);
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

      // REV-82 (SEC-1): there is no in-process "safe" execution any more. The old
      // vm.createContext path was a false boundary — the host-realm Function reached
      // through console.log.constructor escaped it back to the real process (host
      // RCE + secret exfiltration + host prototype pollution; see
      // docs/ai/repro/sec1-vm-escape.cjs). Rather than pretend to sandbox, safe mode
      // (the default) refuses honestly: run_node_code is disabled unless the operator
      // has explicitly opted in to real host access via allowFullNodeAccess. The
      // former isUnsafeWorkspaceCommand("node", ["-e", code]) pre-check is deleted —
      // it gated only shell -c/--command wrappers and was never the real boundary.
      if (!context.allowFullNodeAccess) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "run_node_code is disabled. In-process sandboxing of arbitrary Node.js code " +
                "is not a real security boundary, so this tool refuses to fake one. To run " +
                "real Node.js code with full host access, enable allowFullNodeAccess in the " +
                "MCP server guardrail configuration.",
            },
          ],
        };
      }

      // Full mode: an explicit opt-in to host access. Runs actual Node in a child
      // process (shell:false) with --disallow-code-generation-from-strings.
      const result = await runFullNodeAccessCode(context.runCommand, code, timeoutMs);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: commandResultToText(result) }],
      };
    }

    default:
      return null;
  }
}
