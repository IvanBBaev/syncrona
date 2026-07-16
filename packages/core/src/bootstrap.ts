// SPDX-License-Identifier: GPL-3.0-or-later
import dotenv from "dotenv";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import { preloadStoredCredentials } from "./snClient.js";
import { runUpdateNotifier } from "./updateNotifier.js";

// Commands whose stdout is a machine channel, not human-readable text: `mcp`
// (the parent's stdout is inherited by the spawned MCP server as its JSON-RPC
// transport) and `completion` (the shell-completion script is piped to a file).
// For these, every logger line — including the bootstrap-phase notices that
// loadConfigs() can emit (e.g. the `flat: true` layout notice) — must go to
// stderr so stdout stays byte-clean. Detected here because loadConfigs() below
// is the first thing that can log, long before yargs resolves the command.
function stdoutIsProtocolChannel(argv: string[]): boolean {
  // The yargs command is the first positional token. Skip any leading global
  // options first; the only value-taking ones are string options whose value
  // could otherwise be mistaken for the command (booleans consume no value).
  const valueTakingGlobals = new Set([
    "--log-level",
    "--logLevel",
    "--instance-profile",
    "--instanceProfile",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("-")) {
      return tok === "mcp" || tok === "completion";
    }
    // `--flag=value` is self-contained; `--flag value` consumes the next token
    // only for the known value-taking globals.
    if (!tok.includes("=") && valueTakingGlobals.has(tok)) {
      i++;
    }
  }
  return false;
}

export async function init() {
  // Engage stderr routing up front for protocol-channel commands so no
  // bootstrap-phase notice can corrupt stdout (see stdoutIsProtocolChannel).
  if (stdoutIsProtocolChannel(process.argv.slice(2))) {
    logger.routeAllToStderr();
  }

  try {
    await ConfigManager.loadConfigs();
  } catch (e) {
    // A discovered-but-broken sync.config.js is a hard error: continuing
    // would silently run with default includes/excludes.
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    process.exitCode = 1;
    return;
  }

  const path = ConfigManager.getEnvPath();
  // quiet: dotenv v17 prints an injection tip to stdout by default; stdout must
  // stay clean for pipeable commands like `syncrona completion bash >> ~/.bashrc`.
  dotenv.config({
    path,
    quiet: true,
  });

  // Load credentials from global store into memory (no-op if .env already has them)
  if (!process.env.JEST_WORKER_ID) {
    try {
      await preloadStoredCredentials();
    } catch (_) {
      // Store not configured yet — first run, continue normally
    }
  }

  if (process.env.JEST_WORKER_ID) {
    return;
  }

  // Best-effort "new version available" notice (once/day, opt-out, never blocks).
  await runUpdateNotifier();

  (await import("./commander.js")).initCommands();
}
