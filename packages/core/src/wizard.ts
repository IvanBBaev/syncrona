// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncro-now-ai/types";
import inquirer from "inquirer";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import fs from "fs";
const fsp = fs.promises;
import { logger } from "./Logger";
import path from "path";
import { snClient, unwrapSNResponse, defaultClient, preloadStoredCredentials } from "./snClient";
import {
  buildManifestFromTableAPI,
  listAppsFromTableAPI,
  isScopedEndpointUnavailableError,
} from "./manifestBuilder";
import {
  saveCredentials,
  setActiveInstance,
  getActiveInstance,
  resolveCredentialsFromStore,
} from "./auth";
import { writeDotEnv, ensureGitignored } from "./envFile";
import { generateScopeDocs } from "./scopeDocs";

function normalizeInstance(instance: string): string {
  return String(instance || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function countManifestFiles(manifest: SN.AppManifest): number {
  return Object.values(manifest.tables || {}).reduce((tableAcc, tableConfig) => {
    const records = Object.values(tableConfig.records || {});
    const recordFileCount = records.reduce((recAcc, record) => recAcc + (record.files?.length || 0), 0);
    return tableAcc + recordFileCount;
  }, 0);
}

export async function startWizard() {
  try {
    const loginAnswers = await getWizardCredentials();
    const { username, password, instance } = loginAnswers;
    let filesReady = 0;
    const sourceDirectory = await getSourceDirectorySelection();
    await ensureSourceDirectory(sourceDirectory);

    await saveCredentials(instance, username, password);
    await setActiveInstance(instance);
    await preloadStoredCredentials(instance);

    const client = snClient(`https://${instance}/`, username, password);
    let apps: SN.App[];
    try {
      apps = await unwrapSNResponse(client.getAppList());
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — listing apps from Table API...");
        apps = await listAppsFromTableAPI(client);
      } else {
        throw e;
      }
    }
    if (apps.length === 0) {
      logger.info("Custom endpoint returned no apps — listing apps from Table API...");
      apps = await listAppsFromTableAPI(client);
    }
    if (apps.length === 0) {
      logger.info("No scoped apps were found on this instance.");
      logger.info(
        "Create a new scoped app in ServiceNow Studio first, then re-run 'syncro-now-ai init'."
      );
      logger.info(
        "Or enter a scope code manually if the app exists but wasn't returned by the API (ACL restriction)."
      );
      const { tryManual } = await inquirer.prompt<{ tryManual: boolean }>([
        {
          type: "confirm",
          name: "tryManual",
          message: "Enter scope code manually?",
          default: false,
        },
      ]);
      if (!tryManual) {
        return;
      }
      const { manualScope } = await inquirer.prompt<{ manualScope: string }>([
        {
          type: "input",
          name: "manualScope",
          message: "Scope code (e.g. x_acme_myapp):",
          validate: (v: string) =>
            String(v || "").trim().length > 0 ? true : "Scope is required.",
        },
      ]);
      const sc = String(manualScope || "").trim();
      apps = [{ scope: sc, displayName: sc, sys_id: "" }];
    }
    await setupDotEnv(loginAnswers);

    const hasConfig = await checkConfig();
    if (!hasConfig) {
      logger.info("Generating config...");
      await writeDefaultConfig(hasConfig, sourceDirectory);
    }

    const man = ConfigManager.getManifest(true);
    if (!man) {
      const selectedApp = await showAppList(apps);
      if (!selectedApp) {
        return;
      }
      const downloadedManifest = await downloadApp(selectedApp);
      filesReady = countManifestFiles(downloadedManifest);
      await generateDocsForManifest(downloadedManifest);
    } else {
      const existingManifest = man as SN.AppManifest;
      filesReady = countManifestFiles(existingManifest);
      await generateDocsForManifest(existingManifest);
    }

    logger.info("Running initial diagnostics...");
    try {
      const currentScope = await unwrapSNResponse(client.getCurrentScope());
      logger.success(`Wizard doctor: connection OK, current scope is ${currentScope.scope || "<unknown>"}.`);
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info(
          "Wizard doctor: SyncroNow AI scoped API is unavailable on this instance. Continuing in Table API compatibility mode."
        );
      } else {
        throw e;
      }
    }
    logger.success(`${filesReady} files ready. Open Claude and start coding.`);
    logger.success(
      "You are all set up 👍 Try running 'npx syncro-now-ai dev' to begin development mode."
    );
    await ConfigManager.loadConfigs();
  } catch (e) {
    if (e instanceof Error && e.message.trim().length > 0) {
      logger.error(e.message);
    }
    logger.error(
      "Failed to set up workspace. Run 'syncro-now-ai doctor' or re-run 'syncro-now-ai login'."
    );
    return;
  }
}

async function getWizardCredentials(): Promise<Sync.LoginAnswers> {
  const activeInstance = await getActiveInstance();
  if (!activeInstance) {
    throw new Error(
      "No active credentials profile found. Run 'syncro-now-ai login' first."
    );
  }

  const storedCreds = await resolveCredentialsFromStore(activeInstance);
  if (
    !storedCreds ||
    !storedCreds.instance ||
    !storedCreds.user ||
    !storedCreds.password
  ) {
    throw new Error(
      "No active credentials profile found. Run 'syncro-now-ai login' first."
    );
  }

  const normalizedInstance = normalizeInstance(storedCreds.instance);
  logger.info(`Using active CredentialStore profile for ${normalizedInstance}.`);
  return {
    instance: normalizedInstance,
    username: String(storedCreds.user || "").trim(),
    password: String(storedCreds.password || "").trim(),
  };
}

async function checkConfig(): Promise<boolean> {
  try {
    const checkConfig = ConfigManager.checkConfigPath();
    if (!checkConfig) {
      return false;
    }
    await fsp.access(checkConfig, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function setupDotEnv(answers: Sync.LoginAnswers) {
  // Persist the instance and credentials to .env for the synced workspace.
  // The .env is added to .gitignore so plain-text credentials are not committed.
  let envPath = path.join(process.cwd(), ".env");
  try {
    envPath = ConfigManager.getEnvPath();
  } catch (_) {
    envPath = path.join(process.cwd(), ".env");
  }
  await writeDotEnv(envPath, {
    SN_INSTANCE: answers.instance,
    SN_USER: answers.username,
    SN_PASSWORD: answers.password,
  });
  try {
    await ensureGitignored(path.dirname(envPath), ".env");
  } catch (_) {
    // Updating .gitignore is best-effort and must not fail setup.
  }
}

async function writeDefaultConfig(hasConfig: boolean, sourceDirectory = "src") {
  let pth;
  if (hasConfig) pth = ConfigManager.getConfigPath();
  else pth = path.join(process.cwd(), "sync.config.js");
  if (pth) {
    await fsp.writeFile(pth, ConfigManager.getDefaultConfigFile(sourceDirectory));
  }
}

async function getSourceDirectorySelection(): Promise<string> {
  const answer = await inquirer.prompt<{ sourceDirectory: string }>([
    {
      type: "input",
      name: "sourceDirectory",
      message: "Source directory:",
      default: "src",
      validate: (value: string) =>
        String(value || "").trim().length > 0 ? true : "Source directory is required.",
    },
  ]);

  return String(answer.sourceDirectory || "src").trim();
}

async function ensureSourceDirectory(sourceDirectory: string): Promise<void> {
  const target = path.resolve(process.cwd(), sourceDirectory);
  await fsp.mkdir(target, { recursive: true });
  logger.info(`Source directory ready: ${target}`);
}

async function showAppList(apps: SN.App[]): Promise<string | undefined> {
  const appSelection: Sync.AppSelectionAnswer = await inquirer.prompt([
    {
      type: "list",
      name: "app",
      message: "Which app would you like to work with?",
      choices: apps.map((app) => {
        const maybeTableCount = (app as SN.App & { tableCount?: number; table_count?: number }).tableCount
          ?? (app as SN.App & { tableCount?: number; table_count?: number }).table_count;
        const tableCountSuffix = typeof maybeTableCount === "number"
          ? `, ${maybeTableCount} tables`
          : "";
        return {
          name: `${app.scope} - ${app.displayName}${tableCountSuffix}`,
          value: app.scope,
          short: app.displayName,
        };
      }),
    },
  ]);
  return appSelection.app;
}

function renderProgressBar(current: number, total: number): string {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const width = 20;
  const filled = Math.round(width * ratio);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

async function downloadApp(scope: string) {
  try {
    const client = defaultClient();
    const config = ConfigManager.getConfig();
    let man: SN.AppManifest;
    try {
      man = await unwrapSNResponse(client.getManifest(scope, config, true));
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — building manifest from Table API...");
        man = await buildManifestFromTableAPI(scope, client, config);
      } else {
        throw e;
      }
    }

    if (countManifestFiles(man) === 0) {
      logger.info("Custom endpoint returned empty manifest — building from Table API...");
      man = await buildManifestFromTableAPI(scope, client, config);
    }

    const totalFiles = countManifestFiles(man);
    logger.info(`Downloading scope ${scope}... ${totalFiles} files`);
    logger.info(`${renderProgressBar(0, totalFiles)} 0%`);
    await AppUtils.processManifest(man);
    logger.info(`${renderProgressBar(totalFiles, totalFiles)} 100% (${totalFiles}/${totalFiles})`);
    return man;
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    logger.error(message);
    throw new Error("Failed to download files!");
  }
}

async function generateDocsForManifest(man: SN.AppManifest): Promise<void> {
  try {
    const docPath = await generateScopeDocs(man);
    logger.success(`Scope documentation written to ${docPath}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Could not generate scope documentation: ${message}`);
  }
}
