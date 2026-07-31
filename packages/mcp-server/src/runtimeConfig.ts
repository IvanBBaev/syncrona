// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "fs";
import path from "path";

export const DEFAULT_TIMEOUT_MS = 120000;
export const SERVER_NAME = "syncrona-mcp-server";

// The version an MCP client sees in the `initialize` handshake, in `sync_health`
// and in every tool-module banner. It is read from this package's own
// package.json rather than hardcoded: a literal here silently rots at the first
// release that does not remember to bump it, and it rotted — it read "0.1.0"
// while the package was at 0.9.1, so every client was told the wrong version for
// eight minor releases. Same defect, same fix as `syncrona --version` in 0.9.1.
// The compiled file lives in dist/, so `..` is the package root.
function resolveServerVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch (_) {
    // fall through to the sentinel
  }
  // Deliberately not a plausible-looking version: if the lookup ever fails, the
  // handshake should say "unknown" rather than assert a number that is a guess.
  return "0.0.0-unknown";
}

export const SERVER_VERSION = resolveServerVersion();
export const TOOL_CONTRACT_VERSION = "1.0.0";
// npm package identifier, not the brand display name: this value is passed to
// `npx <pkg> <subcommand>`, and npm rejects names with spaces or uppercase.
// Must stay in sync with the `name`/`bin` keys of packages/core/package.json.
export const PRIMARY_SYNCRO_CLI = "syncrona";
export const PROJECT_DIR = process.cwd();
export const AUDIT_DIR = path.join(PROJECT_DIR, ".syncrona-mcp");
export const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");
export const METRICS_FILE = path.join(AUDIT_DIR, "metrics.jsonl");
export const GUARDRAIL_CONFIG_FILE = path.join(PROJECT_DIR, "sync.mcp.guardrails.json");
export const AUTO_PULL_ALL_SCOPES_ENV = "SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES";
export const SCOPE_BOOTSTRAP_TIMEOUT_MS = 120000;
