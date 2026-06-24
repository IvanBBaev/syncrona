// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
import { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import { startWizard } from "./wizard";
import { logger } from "./Logger";
import {
  logPushResults,
  logBuildResults,
} from "./logMessages";
import {
  defaultClient,
  resolveCredentials,
  unwrapSNResponse,
} from "./snClient";
import inquirer from "inquirer";
import { gitDiffToEncodedPaths } from "./gitUtils";
import { encodedPathsToFilePaths } from "./FileUtils";
import {
  isScopedEndpointUnavailableError,
  buildManifestFromTableAPI,
  listAppsFromTableAPI,
} from "./manifestBuilder";
import { generateScopeDocs } from "./scopeDocs";
import {
  LOGIN_DEFAULT_SOURCE_DIRECTORY,
  setLogLevel,
  scopeCheck,
  logScopedEndpointCapability,
} from "./commandHelpers";
import { mcpCommand } from "./mcpCommand";

// Re-export extracted command modules so consumers can import the full command
// surface from "./commands" (barrel) in addition to the dedicated modules.
export { pushCommand } from "./pushCommand";
export { statusCommand, doctorCommand, pluginsCommand } from "./diagnosticsCommands";
export { mcpCommand } from "./mcpCommand";

async function localPathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function ensureScopeWorkspace(scopeDir: string): Promise<void> {
  const sourcePath = path.join(scopeDir, LOGIN_DEFAULT_SOURCE_DIRECTORY);
  const configPath = path.join(scopeDir, "sync.config.js");

  await fsp.mkdir(sourcePath, { recursive: true });
  if (!(await localPathExists(configPath))) {
    await fsp.writeFile(
      configPath,
      ConfigManager.getDefaultConfigFile(LOGIN_DEFAULT_SOURCE_DIRECTORY),
      "utf8"
    );
  }
}

async function initAllScopesFromEnv(args: Sync.SharedCmdArgs): Promise<void> {
  const workspaceRoot = process.cwd();
  const packagesRoot = path.join(workspaceRoot, "packages");
  await fsp.mkdir(packagesRoot, { recursive: true });

  const client = defaultClient(args.instanceProfile);
  let apps: import("@syncro-now-ai/types").SN.App[] = [];
  try {
    apps = await unwrapSNResponse(client.getAppList());
  } catch (e) {
    if (isScopedEndpointUnavailableError(e)) {
      apps = await listAppsFromTableAPI(client);
    } else {
      throw e;
    }
  }

  const scopedApps = apps
    .filter((app) => app.scope && app.scope.startsWith("x_"))
    .sort((a, b) => a.scope.localeCompare(b.scope));

  if (scopedApps.length === 0) {
    logger.warn("No active scoped apps found for initialization.");
    return;
  }

  // Resolve the folder name for each scope up front so we can show the user
  // exactly what would be created before touching the filesystem.
  // Use the short scope alias (strip the "x_<vendor>_" prefix), e.g.
  // x_nuvo_cs -> cs; fall back to the full scope on collision or empty name.
  // The full scope is still used for all API calls and stored in the manifest.
  const usedDirNames = new Set<string>();
  const plan = scopedApps.map((app) => {
    let dirName = app.scope.replace(/^x_[^_]+_/, "");
    if (dirName.length === 0 || usedDirNames.has(dirName)) {
      dirName = app.scope;
    }
    usedDirNames.add(dirName);
    return { scope: app.scope, dirName };
  });

  // DX4: auto-init can create many directories from a single `init` — say what
  // and confirm first (skipped with --ci; --dry-run reports without creating).
  logger.info(
    `Found ${plan.length} scoped app(s). Would create under packages/: ${plan
      .map((p) => p.dirName)
      .join(", ")}`
  );
  if (args.dryRun === true) {
    logger.info("Dry run: skipping directory creation and downloads.");
    return;
  }
  if (args.ci !== true) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message: `Create ${plan.length} package folder(s) under packages/ and download each scope?`,
        default: false,
      },
    ]);
    if (!confirmed) {
      logger.info("Auto init cancelled.");
      return;
    }
  }

  logger.info(`Auto init: preparing ${plan.length} scoped packages...`);
  for (const { scope, dirName } of plan) {
    const scopeDir = path.join(packagesRoot, dirName);
    await ensureScopeWorkspace(scopeDir);

    const originalCwd = process.cwd();
    try {
      process.chdir(scopeDir);
      // Re-resolve config/manifest/source paths for this scope. The config
      // store is a singleton initialized once at startup, so without this the
      // chdir is ignored and every scope would write to the workspace root.
      ConfigManager.resetConfigState();
      await ConfigManager.loadConfigs();
      await downloadCommand({
        logLevel: args.logLevel,
        scope,
        dryRun: args.dryRun,
        instanceProfile: args.instanceProfile,
        ci: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  }
}

export async function downloadCommand(args: Sync.CmdDownloadArgs) {
  setLogLevel(args);
  const dryRun = args.dryRun === true;
  if (dryRun) {
    logger.info(`Dry run: would download scope ${args.scope} and overwrite local manifest/files.`);
    return;
  }

  const skipPrompt = args.ci === true;
  if (!skipPrompt) {
    const answers: { confirmed: boolean } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: "Downloading will overwrite manifest and files. Are you sure?",
        default: false,
      },
    ]);
    if (!answers["confirmed"]) {
      return;
    }
  }
  logger.info("Downloading manifest...");
  const client = defaultClient(args.instanceProfile);
  const config = ConfigManager.getConfig();

  let man: import("@syncro-now-ai/types").SN.AppManifest;
  try {
    man = await unwrapSNResponse(client.getManifest(args.scope, config));
  } catch (e) {
    if (isScopedEndpointUnavailableError(e)) {
      logger.info("Custom scope not found — building manifest from Table API...");
      man = await buildManifestFromTableAPI(args.scope, client, config);
    } else {
      throw e;
    }
  }

  logger.info("Creating local files from manifest...");
  await AppUtils.processManifest(man, true);
  logger.info("Fetching file contents...");
  await AppUtils.downloadAllFiles(man, args.instanceProfile);
  try {
    const docPath = await generateScopeDocs(man);
    logger.success(`Scope documentation written to ${docPath}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Could not generate scope documentation: ${message}`);
  }
  logger.success("Download complete ✅");
}
export async function docsCommand(args: Sync.SharedCmdArgs): Promise<void> {
  setLogLevel(args);
  const man = ConfigManager.getManifest();
  if (!man) {
    logger.error(
      "No manifest found. Run 'syncro-now-ai init' or 'syncro-now-ai download <scope>' first."
    );
    return;
  }
  try {
    const docPath = await generateScopeDocs(man);
    logger.success(`Scope documentation written to ${docPath}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to generate scope documentation: ${message}`);
  }
}
export async function initCommand(args: Sync.SharedCmdArgs) {
  setLogLevel(args);
  const hasEnvFile = await localPathExists(path.join(process.cwd(), ".env"));
  if (hasEnvFile) {
    // DX2: name the instance the .env resolves to so the user knows which
    // server init will talk to before it proceeds (folder creation is then
    // confirmed in initAllScopesFromEnv — DX4 — unless --ci).
    const detectedInstance = resolveCredentials(args.instanceProfile).instance;
    logger.info(
      `Detected .env in current directory${detectedInstance ? ` (SN_INSTANCE=${detectedInstance})` : ""}. ` +
        "Running all-scope initialization — you'll confirm before any folders are created."
    );
    await initAllScopesFromEnv(args);
    logger.success("Init complete: all discoverable scopes initialized. ✅");
    return;
  }

  await startWizard();
  await mcpCommand({ ...args, autoConfigure: true, start: false });
}

export async function buildCommand(args: Sync.BuildCmdArgs) {
  setLogLevel(args);
  try {
    if (args.checkConfig === true) {
      const rules = ConfigManager.getConfig().rules ?? [];
      const issues = ConfigManager.checkRuleOrder(rules);
      if (issues.length === 0) {
        logger.success(`Config rule order OK (${rules.length} rule(s); no shadowing detected).`);
        return;
      }
      for (const issue of issues) {
        logger.warn(
          `Rule #${issue.laterIndex + 1} (${rules[issue.laterIndex].match}) is shadowed by ` +
            `earlier rule #${issue.earlierIndex + 1} (${rules[issue.earlierIndex].match}): ` +
            `a file like "${issue.sample}" would match the earlier rule first. ` +
            "Move the more specific rule before the broader one."
        );
      }
      process.exitCode = 1;
      return;
    }

    const encodedPaths = await gitDiffToEncodedPaths(args.diff);
    const fileList = await AppUtils.getAppFileList(encodedPaths);
    logger.info(`${fileList.length} files to build.`);
    if (args.dryRun === true) {
      logger.info("Dry run: skipping local build output writes.");
      return;
    }
    const results = await AppUtils.buildFiles(fileList);
    logBuildResults(results);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`Build failed: ${message}`);
    process.exitCode = 1;
  }
}

async function getDeployPaths(): Promise<string[]> {
  let changedPaths: string[] = [];
  try {
    changedPaths = ConfigManager.getDiffFile().changed || [];
  } catch (e) {}
  if (changedPaths.length > 0) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Would you like to deploy only files changed in your diff file?",
        default: false,
      },
    ]);
    if (confirmed) return changedPaths;
  }
  return encodedPathsToFilePaths(ConfigManager.getBuildPath());
}

export async function deployCommand(args: Sync.SharedCmdArgs): Promise<void> {
  setLogLevel(args);
  await scopeCheck(async () => {
    const dryRun = args.dryRun === true;
    const credentials = resolveCredentials(args.instanceProfile);
    const targetServer = credentials.instance;
    if (!targetServer) {
      logger.error("No server configured for deploy!");
      return;
    }

    const client = defaultClient(args.instanceProfile);
    try {
      await client.checkConnection(5000);
      logScopedEndpointCapability("deploy");
    } catch (e) {
      logger.error(
        "Unable to reach ServiceNow instance before deploy. Check SN_INSTANCE/SN_USER/SN_PASSWORD and network connectivity."
      );
      return;
    }

    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Deploying will overwrite code in your instance. Are you sure?",
        default: false,
      },
    ]);
    if (!confirmed) {
      return;
    }
    const paths = await getDeployPaths();
    logger.silly(`${paths.length} paths found...`);
    logger.silly(JSON.stringify(paths, null, 2));
    const appFileList = await AppUtils.getAppFileList(paths);
    if (dryRun) {
      logger.info(
        `Dry run: would deploy ${appFileList.length} records to ${targetServer}, skipping remote push.`
      );
      return;
    }
    const pushResults = await AppUtils.pushFiles(appFileList);
    logPushResults(pushResults);
  });
}
