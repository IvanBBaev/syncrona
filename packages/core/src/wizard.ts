// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { constants as fsConstants, promises as fsp } from "fs";
import inquirer from "inquirer";
import path from "path";
import * as AppUtils from "./appUtils.js";
import { applyDataModelTableOptions } from "./dataModel.js";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import {
  snClient,
  defaultClient,
  preloadStoredCredentials,
  buildClientAuth,
  credentialsFromStore,
  type SNClient,
} from "./snClient.js";
import { buildManifestFromTableAPI, listAppsFromTableAPI } from "./manifestBuilder.js";
import {
  saveCredentials,
  setActiveInstance,
  getActiveInstance,
  resolveCredentialsFromStore,
  type StoredCredentials,
} from "./auth.js";
import { writeDotEnv, ensureGitignored } from "./envFile.js";
import { isPromptAbort } from "./errorTaxonomy.js";
import { generateScopeDocs } from "./scopeDocs.js";

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

/**
 * Runs the interactive setup. Resolves `true` only when the workspace was fully
 * set up; `false` when the user cancelled or setup failed. The caller used to
 * get no signal at all and unconditionally continued with the post-init steps
 * (MCP auto-configure) over a half-configured workspace.
 */
export async function startWizard(): Promise<boolean> {
  try {
    const { answers: loginAnswers, stored } = await getWizardCredentials();
    const { username, password, instance } = loginAnswers;
    let filesReady = 0;
    const sourceDirectory = await getSourceDirectorySelection();
    await ensureSourceDirectory(sourceDirectory);

    // Re-save under the normalized instance, carrying the rest of the profile:
    // without it the OAuth client, API key and JWT fields `syncrona login`
    // stored were dropped, and every later command fell back to Basic auth.
    await saveCredentials(instance, username, password, stored);
    await setActiveInstance(instance);
    await preloadStoredCredentials(instance);

    // The app listing authenticates with the profile's method, as every other
    // command does, rather than Basic auth an OAuth-only instance refuses.
    const { oauth, apiKey } = buildClientAuth(credentialsFromStore(stored));
    const client = snClient(`https://${instance}/`, username, password, oauth, apiKey);
    let apps: SN.App[] = await listAppsFromTableAPI(client);
    if (apps.length === 0) {
      logger.info("No scoped apps were found on this instance.");
      logger.info(
        "Create a new scoped app in ServiceNow Studio first, then re-run 'syncrona init'."
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
      // Nothing was set up: a zero exit would let `init && refresh` go on.
      if (!tryManual) {
        process.exitCode = 1;
        return false;
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
      // The configs loaded at startup predate the file just written, so the
      // download below would land in the default `src` rather than the source
      // directory the user chose. Reload before anything resolves a path.
      await ConfigManager.loadConfigs();
    }

    const man = ConfigManager.getManifest(true);
    if (!man) {
      const selectedApp = await showAppList(apps);
      if (!selectedApp) {
        process.exitCode = 1;
        return false;
      }
      const downloadedManifest = await downloadApp(selectedApp, client);
      filesReady = countManifestFiles(downloadedManifest);
      await generateDocsForManifest(downloadedManifest);
    } else {
      const existingManifest = man as SN.AppManifest;
      filesReady = countManifestFiles(existingManifest);
      await generateDocsForManifest(existingManifest);
    }

    logger.info("Running initial diagnostics...");
    try {
      const currentScope = await client.getSessionScope();
      logger.success(`Wizard doctor: connection OK, current scope is ${currentScope.scope || "<unknown>"}.`);
    } catch (e) {
      // The files are already on disk: an unreadable preference only leaves the
      // session scope unconfirmed, which every later command checks again.
      logger.warn(
        `Wizard doctor: could not read the session scope (${e instanceof Error ? e.message : String(e)}).`
      );
    }
    // Reload so the rest of this process sees the configuration just written,
    // and only then report success.
    await ConfigManager.loadConfigs();
    logger.success(`${filesReady} files ready. Open Claude and start coding.`);
    logger.success("Setup complete. Run 'npx syncrona dev' to start development mode.");
    return true;
  } catch (e) {
    if (isPromptAbort(e)) {
      // REV-161: user cancelled — no error banner, but the run did NOT succeed.
      // Leaving the exit code untouched reported success (0) for an aborted setup,
      // so a scripted `syncrona init && ...` continued as if the workspace was
      // ready. 130 is the conventional SIGINT exit code, matching commander.ts.
      process.exitCode = 130;
      return false;
    }
    if (e instanceof Error && e.message.trim().length > 0) {
      logger.error(e.message);
    }
    logger.error(
      "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'."
    );
    // Signal failure so CI and scripted runs can detect the wizard did not
    // complete; previously this returned with a success (0) exit code.
    process.exitCode = 1;
    return false;
  }
}

async function getWizardCredentials(): Promise<{
  answers: Sync.LoginAnswers;
  stored: StoredCredentials;
}> {
  const activeInstance = await getActiveInstance();
  if (!activeInstance) {
    throw new Error(
      "No active credentials profile found. Run 'syncrona login' first."
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
      "No active credentials profile found. Run 'syncrona login' first."
    );
  }

  const normalizedInstance = normalizeInstance(storedCreds.instance);
  logger.info(`Using active CredentialStore profile for ${normalizedInstance}.`);
  return {
    answers: {
      instance: normalizedInstance,
      username: String(storedCreds.user || "").trim(),
      // Do not trim the stored password — edge whitespace can be significant.
      password: String(storedCreds.password || ""),
    },
    stored: storedCreds,
  };
}

/** True when the project already has a sync.config.js that exists on disk. */
async function checkConfig(): Promise<boolean> {
  try {
    const configPath = ConfigManager.checkConfigPath();
    if (!configPath) return false;
    await fsp.access(configPath, fsConstants.F_OK);
    return true;
  } catch {
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

type ListedApp = SN.App & { tableCount?: number; table_count?: number };

// One picker entry: "scope - Display Name", plus the table count when the
// listing reported one (under either spelling).
function appChoice(app: ListedApp) {
  const tables = app.tableCount ?? app.table_count;
  const suffix = typeof tables === "number" ? `, ${tables} tables` : "";
  return { name: `${app.scope} - ${app.displayName}${suffix}`, value: app.scope, short: app.displayName };
}

async function showAppList(apps: SN.App[]): Promise<string | undefined> {
  const question = {
    type: "list" as const,
    name: "app",
    message: "Which app would you like to work with?",
    choices: apps.map(appChoice),
  };
  const { app } = await inquirer.prompt<Sync.AppSelectionAnswer>([question]);
  return app;
}

function renderProgressBar(current: number, total: number): string {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const width = 20;
  const filled = Math.round(width * ratio);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

/**
 * Builds the manifest for `scope`, downloads its files and writes
 * sync.manifest.json. `init --new` passes the sys_id of the application it just
 * created as `scopeId`, so the manifest records it and the first
 * `push --create` skips the sys_scope lookup, and sets `justCreated`, which is
 * the only way an EMPTY manifest is accepted: a scope that was created a moment
 * ago legitimately owns nothing, while an existing scope that yields nothing
 * points at a wrong scope code or missing access (see buildManifestFromTableAPI).
 */
export async function downloadApp(
  scope: string,
  client: SNClient = defaultClient(),
  options: { scopeId?: string; justCreated?: boolean } = {}
): Promise<SN.AppManifest> {
  // An empty manifest is only ever written for a just-created scope, and only
  // with that scope's sys_id: without one, nothing downstream could tell the
  // binding apart from a failed download.
  const allowEmpty =
    options.justCreated === true && typeof options.scopeId === "string" && options.scopeId !== "";
  // #48: the wizard lists apps via the explicit store-backed client built from
  // the just-saved credentials, so the download must use the SAME client.
  // Falling back to defaultClient() (which prefers ambient SN_* env vars) could
  // silently pull the scope from a different instance than the one listed.
  try {
    const config = ConfigManager.getConfig();
    let man = await buildManifestFromTableAPI(scope, client, config, { allowEmpty });
    if (options.scopeId) {
      man = { ...man, scopeId: options.scopeId };
    }

    // The build lists a column the record-level secret rule governs without
    // its content; re-read it so a non-secret value is written and a secret
    // one never is.
    await AppUtils.applyRecordSecretRulesToContent(
      man,
      client,
      applyDataModelTableOptions(config)
    );

    const totalFiles = countManifestFiles(man);
    logger.info(`Downloading scope ${scope}... ${totalFiles} files`);
    logger.info(`${renderProgressBar(0, totalFiles)} 0%`);
    await AppUtils.processManifest(man);
    logger.info(`${renderProgressBar(totalFiles, totalFiles)} 100% (${totalFiles}/${totalFiles})`);
    return man;
  } catch (e) {
    logger.error(e instanceof Error ? e.message : String(e));
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
