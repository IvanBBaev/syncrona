import { Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import * as ConfigManager from "./config";
import { logger } from "./Logger";
import { getActiveInstance } from "./auth";
import { resolveCredentials } from "./snClient";
import { setLogLevel } from "./commandHelpers";

type McpServerProcessArgs = Sync.SharedCmdArgs & {
  autoConfigure?: boolean;
  start?: boolean;
  mcpServerPath?: string;
};

type McpClientConfig = {
  mcpServers?: Record<string, {
    command: string;
    args: string[];
    cwd?: string;
  }>;
};

type McpClientTarget = {
  clientName: string;
  configPath: string;
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
  const fromEnv = String(process.env.SYNCRONA_MCP_SERVER_PATH || "").trim();
  const candidates = [
    explicitPath || "",
    fromEnv,
    path.join(workspaceRoot, "packages", "mcp-server", "dist", "index.js"),
    path.join(workspaceRoot, "node_modules", "@syncrona", "mcp-server", "dist", "index.js"),
    path.resolve(__dirname, "..", "..", "mcp-server", "dist", "index.js"),
  ].filter((item) => item.length > 0);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find MCP server entrypoint. Build @syncrona/mcp-server or provide --mcp-server-path."
  );
}

async function writeMcpClientConfig(mcpConfigPath: string, mcpServerPath: string, workspaceRoot: string): Promise<string> {
  await fsp.mkdir(path.dirname(mcpConfigPath), { recursive: true });

  let config: McpClientConfig = {};
  try {
    const raw = await fsp.readFile(mcpConfigPath, "utf8");
    const parsed = JSON.parse(raw) as McpClientConfig;
    if (parsed && typeof parsed === "object") {
      config = parsed;
    }
  } catch (_) {
    config = {};
  }

  const existingServers = config.mcpServers && typeof config.mcpServers === "object"
    ? config.mcpServers
    : {};

  config.mcpServers = {
    ...existingServers,
    syncrona: {
      command: "node",
      args: [mcpServerPath],
      cwd: workspaceRoot,
    },
  };

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
      restartHint: "VS Code: run `Developer: Reload Window`.",
      onlyIfExists: false,
    },
  ];

  if (process.platform === "darwin") {
    targets.push(
      {
        clientName: "Claude Desktop",
        configPath: path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        restartHint: "Claude Desktop: fully quit and open again.",
        onlyIfExists: true,
      },
      {
        clientName: "Cursor",
        configPath: path.join(homeDir, ".cursor", "mcp.json"),
        restartHint: "Cursor: run `Developer: Reload Window`.",
        onlyIfExists: true,
      }
    );
  }

  if (process.platform === "win32" && appData) {
    targets.push(
      {
        clientName: "Claude Desktop",
        configPath: path.join(appData, "Claude", "claude_desktop_config.json"),
        restartHint: "Claude Desktop: fully quit and open again.",
        onlyIfExists: true,
      },
      {
        clientName: "Cursor",
        configPath: path.join(appData, "Cursor", "mcp.json"),
        restartHint: "Cursor: run `Developer: Reload Window`.",
        onlyIfExists: true,
      }
    );
  }

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
  const targetInstance = instanceFromStore || credentials.instance;
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
  setLogLevel(args);

  const workspaceRoot = getWorkspaceRoot();
  const shouldAutoConfigure = args.autoConfigure !== false;
  const shouldStart = args.start !== false;

  const mcpServerPath = await resolveMcpServerPath(args.mcpServerPath, workspaceRoot);

  if (shouldAutoConfigure) {
    const clientTargets = await resolveMcpClientTargets(workspaceRoot);
    const updatedConfigs: McpClientTarget[] = [];
    for (const target of clientTargets) {
      await writeMcpClientConfig(target.configPath, mcpServerPath, workspaceRoot);
      updatedConfigs.push(target);
      logger.success(`MCP client config updated (${target.clientName}): ${target.configPath}`);
    }

    const secretsPath = await writeMcpSecretsConfig(args, workspaceRoot);
    if (secretsPath) {
      logger.success(`MCP secrets config updated: ${secretsPath}`);
    } else {
      logger.error("Run syncrona login first.");
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

  logger.info(`Starting Syncrona MCP server from ${mcpServerPath}...`);
  const exitCode = await startMcpServerProcess(mcpServerPath, workspaceRoot);
  if (exitCode !== 0) {
    logger.error(`Syncrona MCP server exited with code ${exitCode}.`);
    process.exit(exitCode);
  }
}
