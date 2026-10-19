// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { spawn } from "child_process";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import { getActiveInstance } from "./auth.js";
import { resolveCredentials } from "./snClient.js";
import { setLogLevel } from "./commandHelpers.js";

// ESM has no CommonJS __dirname; derive it from this module's URL so the
// bundled-sibling MCP server path candidate resolves relative to this file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type McpServerProcessArgs = Sync.SharedCmdArgs & {
  autoConfigure?: boolean;
  start?: boolean;
  mcpServerPath?: string;
};

type McpServerEntry = {
  type?: "stdio";
  command: string;
  args: string[];
  cwd?: string;
};

type McpClientConfig = Record<string, unknown>;

// VS Code's mcp.json keeps its servers under `servers`; Claude Desktop and
// Cursor use `mcpServers`. An entry under the other client's key is ignored.
type McpServersKey = "servers" | "mcpServers";

type McpClientTarget = {
  clientName: string;
  configPath: string;
  serversKey: McpServersKey;
  restartHint: string;
  onlyIfExists: boolean;
};

function getWorkspaceRoot(): string {
  try {
    return ConfigManager.getRootDir();
  } catch (_) {
    return process.cwd();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.stat(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveMcpServerPath(explicitPath: string | undefined, workspaceRoot: string): Promise<string> {
  const explicit = String(explicitPath || "").trim();
  if (explicit) {
    // Resolved against the invoking cwd BEFORE the stat, and the absolute path
    // is what gets returned: the client configs and the spawn both run with
    // cwd=workspaceRoot, so a relative path validated here as-is would be
    // consumed against a different base than the one it was checked in.
    const resolved = path.resolve(explicit);
    if (await pathExists(resolved)) {
      return resolved;
    }
    // An explicit --mcp-server-path is honoured or it fails: falling through to
    // the discovery candidates would start a DIFFERENT server than the one that
    // was asked for, or report "unable to find" without ever naming the typo.
    const where = resolved === explicit ? explicit : `${explicit} (resolved to ${resolved})`;
    throw new Error(
      `MCP server entrypoint not found at --mcp-server-path: ${where}`
    );
  }

  const fromEnv = String(process.env.SYNCRONA_MCP_SERVER_PATH || "").trim();
  const candidates = [
    // Same base-mismatch hazard as the explicit flag: the env var may be
    // relative, and the consumers resolve against workspaceRoot, not cwd.
    fromEnv ? path.resolve(fromEnv) : "",
    path.join(workspaceRoot, "packages", "mcp-server", "dist", "index.js"),
    path.join(workspaceRoot, "node_modules", "@syncrona", "mcp-server", "dist", "index.js"),
    // An installed CLI lives at <node_modules>/syncrona/dist, so the server it
    // ships beside is <node_modules>/@syncrona/mcp-server — a global install
    // (`npm i -g syncrona @syncrona/mcp-server`) found nothing, because only the
    // monorepo sibling below was tried. It goes first: in node_modules that
    // unscoped sibling is whatever unrelated package is called "mcp-server".
    path.resolve(__dirname, "..", "..", "@syncrona", "mcp-server", "dist", "index.js"),
    path.resolve(__dirname, "..", "..", "mcp-server", "dist", "index.js"),
  ].filter((item) => item.length > 0);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find MCP server entrypoint. Install @syncrona/mcp-server next to syncrona, build it, or provide --mcp-server-path."
  );
}

// An MCP client config must be a JSON object. Arrays are excluded explicitly:
// `typeof [] === "object"`, and JSON.stringify drops the non-index properties of
// an array — so an array config would swallow the mcpServers entry and still be
// written back (and reported) as a success.
function isMcpClientConfigDocument(value: unknown): value is McpClientConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// VS Code's mcp.json is JSONC: comments and trailing commas are normal there,
// and other clients' configs pick them up from hand edits. JSON.parse rejects
// both, and a config read as malformed is replaced — every other server in it
// was lost. Strip them outside string literals so plain JSON.parse can read it.
function stripJsonc(raw: string): string {
  return dropOutsideStrings(dropOutsideStrings(raw, "comments"), "trailingCommas");
}

function dropOutsideStrings(raw: string, what: "comments" | "trailingCommas"): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (what === "comments" && ch === "/" && raw[i + 1] === "/") {
      while (i + 1 < raw.length && raw[i + 1] !== "\n") i += 1;
    } else if (what === "comments" && ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end === -1) {
        // left in place so JSON.parse rejects the file as malformed
        out += raw.slice(i);
        break;
      }
      i = end + 1;
      out += " ";
    } else if (what === "trailingCommas" && ch === "," && /^\s*[}\]]/.test(raw.slice(i + 1))) {
      // dropped: only whitespace stands between it and the closing bracket
    } else {
      out += ch;
    }
  }
  return out;
}

function isServerMap(value: unknown): value is Record<string, McpServerEntry> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeMcpClientConfig(
  mcpConfigPath: string,
  serversKey: McpServersKey,
  mcpServerPath: string,
  workspaceRoot: string
): Promise<string> {
  await fsp.mkdir(path.dirname(mcpConfigPath), { recursive: true });

  let config: McpClientConfig = {};
  let existingRaw: string | null = null;
  try {
    existingRaw = await fsp.readFile(mcpConfigPath, "utf8");
  } catch (_) {
    // No config file yet (or it cannot be read): start from an empty document.
    existingRaw = null;
  }

  if (existingRaw !== null) {
    let parsed: unknown;
    try {
      // Windows editors often save JSON with a UTF-8 byte order mark, which
      // JSON.parse rejects; reading it as malformed would wipe every other
      // server in the file.
      const text = existingRaw.replace(/^\uFEFF/, "");
      const plain = stripJsonc(text);
      parsed = JSON.parse(plain);
      if (plain !== text && isMcpClientConfigDocument(parsed)) {
        logger.warn(`Comments and trailing commas in ${mcpConfigPath} are not kept when it is rewritten.`);
      }
    } catch (_) {
      parsed = undefined;
    }

    if (isMcpClientConfigDocument(parsed)) {
      config = parsed;
    } else {
      // Self-healing is kept (the command must not abort on a corrupt file), but
      // the rewrite is announced with the path so the user can tell which file
      // lost its previous contents.
      logger.warn(`Replacing malformed MCP client config: ${mcpConfigPath}`);
      config = {};
    }
  }

  // Same array exclusion as the document-level guard: spreading an array here
  // would register its elements as servers named "0", "1", ... — a garbage
  // entry per element, written back as a success.
  const existing = config[serversKey];
  const existingServers = isServerMap(existing) ? existing : {};

  const entry: McpServerEntry = {
    command: "node",
    args: [mcpServerPath],
    cwd: workspaceRoot,
  };
  config[serversKey] = {
    ...existingServers,
    "syncrona": serversKey === "servers" ? { type: "stdio", ...entry } : entry,
  };

  // Earlier releases wrote the VS Code entry under `mcpServers`, where VS Code
  // never looks. Drop that dead copy so the file holds one syncrona entry.
  const legacy = config.mcpServers;
  if (serversKey !== "mcpServers" && isServerMap(legacy) && "syncrona" in legacy) {
    const { syncrona: _dead, ...others } = legacy;
    if (Object.keys(others).length > 0) {
      config.mcpServers = others;
    } else {
      delete config.mcpServers;
    }
  }

  await fsp.writeFile(mcpConfigPath, JSON.stringify(config, null, 2), "utf8");
  return mcpConfigPath;
}

async function resolveMcpClientTargets(workspaceRoot: string): Promise<McpClientTarget[]> {
  const homeDir = os.homedir();
  const appData = process.env.APPDATA || "";
  const targets: McpClientTarget[] = [
    {
      clientName: "VS Code",
      configPath: path.join(workspaceRoot, ".vscode", "mcp.json"),
      serversKey: "servers",
      restartHint: "VS Code: run `Developer: Reload Window`.",
      onlyIfExists: false,
    },
  ];

  if (process.platform === "darwin") {
    targets.push(
      {
        clientName: "Claude Desktop",
        configPath: path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        serversKey: "mcpServers",
        restartHint: "Claude Desktop: fully quit and open again.",
        onlyIfExists: true,
      }
    );
  }

  if (process.platform === "win32") {
    if (appData) {
      targets.push(
        {
          clientName: "Claude Desktop",
          configPath: path.join(appData, "Claude", "claude_desktop_config.json"),
          serversKey: "mcpServers",
          restartHint: "Claude Desktop: fully quit and open again.",
          onlyIfExists: true,
        }
      );
    } else {
      // Without %APPDATA% there is no roaming profile to derive the desktop
      // client paths from. Say so, or the skip is indistinguishable from "those
      // clients are not installed".
      logger.warn(
        "APPDATA is not set: skipping Claude Desktop configuration on win32."
      );
    }
  }

  // Cursor keeps its global MCP config at ~/.cursor/mcp.json on every OS; the
  // %APPDATA%\Cursor path it was once looked up at on Windows never exists.
  targets.push({
    clientName: "Cursor",
    configPath: path.join(homeDir, ".cursor", "mcp.json"),
    serversKey: "mcpServers",
    restartHint: "Cursor: run `Developer: Reload Window`.",
    onlyIfExists: true,
  });

  const resolved: McpClientTarget[] = [];
  for (const target of targets) {
    if (!target.onlyIfExists || await pathExists(target.configPath)) {
      resolved.push(target);
    }
  }

  return resolved;
}

async function writeMcpSecretsConfig(args: Sync.SharedCmdArgs, workspaceRoot: string): Promise<string | null> {
  let instanceFromStore = "";
  try {
    const activeInstance = await getActiveInstance();
    if (activeInstance) {
      instanceFromStore = activeInstance;
    }
  } catch (_) {
    instanceFromStore = "";
  }

  const credentials = resolveCredentials(args.instanceProfile);
  // An explicit --instance-profile is a deliberate target selection, so the
  // credentials resolved for THAT profile outrank the stored active instance
  // (`syncrona use`); without a profile the stored active instance stays the
  // authority over a stale SN_INSTANCE in the environment. Never fall back
  // across that line: writing another instance into the secrets file would
  // silently point the MCP server at the wrong environment.
  const targetInstance = args.instanceProfile
    ? credentials.instance
    : instanceFromStore || credentials.instance;
  if (!targetInstance) {
    return null;
  }

  const secretsDir = path.join(workspaceRoot, ".syncrona-mcp");
  const secretsPath = path.join(secretsDir, "secrets.json");
  await fsp.mkdir(secretsDir, { recursive: true });
  await fsp.writeFile(
    secretsPath,
    JSON.stringify(
      {
        servicenow: {
          instance: targetInstance,
        },
      },
      null,
      2
    ),
    "utf8"
  );

  return secretsPath;
}

async function startMcpServerProcess(serverPath: string, workspaceRoot: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve(typeof code === "number" ? code : 0);
    });
  });
}

export async function mcpCommand(args: McpServerProcessArgs): Promise<void> {
  // stdout must stay byte-clean: when an MCP client launches `syncrona mcp`,
  // the spawned server inherits stdout as the MCP JSON-RPC protocol channel.
  // Route to stderr BEFORE setLogLevel(): resolving a `.syncrona-local`
  // instance profile there emits a `debug` line, so routing must already be
  // engaged. The flag is sticky, so setLogLevel()'s logger rebuild keeps it.
  logger.routeAllToStderr();
  setLogLevel(args);

  const workspaceRoot = getWorkspaceRoot();
  const shouldAutoConfigure = args.autoConfigure !== false;
  const shouldStart = args.start !== false;

  const mcpServerPath = await resolveMcpServerPath(args.mcpServerPath, workspaceRoot);

  if (shouldAutoConfigure) {
    const clientTargets = await resolveMcpClientTargets(workspaceRoot);
    const updatedConfigs: McpClientTarget[] = [];
    for (const target of clientTargets) {
      await writeMcpClientConfig(target.configPath, target.serversKey, mcpServerPath, workspaceRoot);
      updatedConfigs.push(target);
      logger.success(`MCP client config updated (${target.clientName}): ${target.configPath}`);
    }

    const secretsPath = await writeMcpSecretsConfig(args, workspaceRoot);
    if (secretsPath) {
      logger.success(`MCP secrets config updated: ${secretsPath}`);
    } else {
      logger.error("Run syncrona login first.");
      // Missing credentials is a failure, not a normal skip — signal it so the
      // CLI exits non-zero (matches the other error paths and lets scripts/CI
      // detect that auto-configure did not complete).
      process.exitCode = 1;
      return;
    }

    if (updatedConfigs.length > 0) {
      logger.info("Restart MCP clients to pick up the updated configuration:");
      for (const target of updatedConfigs) {
        logger.info(`- ${target.restartHint}`);
      }
    }
  }

  if (!shouldStart) {
    logger.info("MCP auto-configure complete. Server start skipped (--start=false).");
    return;
  }

  logger.info(`Starting SyncroNow AI MCP server from ${mcpServerPath}...`);
  const exitCode = await startMcpServerProcess(mcpServerPath, workspaceRoot);
  if (exitCode !== 0) {
    logger.error(`SyncroNow AI MCP server exited with code ${exitCode}.`);
    process.exit(exitCode);
  }
}
