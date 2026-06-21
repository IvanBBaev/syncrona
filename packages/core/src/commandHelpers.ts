import { Sync } from "@syncro-now-ai/types";
import { promises as fsp, readFileSync } from "fs";
import path from "path";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import { logger } from "./Logger";
import { scopeCheckMessage } from "./logMessages";
import { setActiveInstanceProfile, getScopedEndpointPrefix } from "./snClient";
import { getActiveInstance, loadCredentials } from "./auth";

export const LOGIN_DEFAULT_SOURCE_DIRECTORY = "src";

export type ActiveStoreHealth = { active: string | null; decrypts: boolean; error?: string };

// Health of the active stored instance: does its credential file decrypt?
// resolveCredentialsFromStore swallows decryption failures and returns null,
// so this is the single place that turns that silence into a clear signal
// (used by status, push, and download).
export async function activeStoreHealth(): Promise<ActiveStoreHealth> {
  let active: string | null = null;
  try {
    active = await getActiveInstance();
  } catch {
    return { active: null, decrypts: false };
  }
  if (!active) {
    return { active: null, decrypts: false };
  }
  try {
    await loadCredentials(active);
    return { active, decrypts: true };
  } catch (e) {
    return { active, decrypts: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// One actionable warning when a prior login left a stored instance that no
// longer decrypts (the silent cause of "credentials missing"); null otherwise.
export async function getActiveStoreDecryptWarning(): Promise<string | null> {
  const health = await activeStoreHealth();
  if (health.active && !health.decrypts) {
    return (
      `Stored credentials for "${health.active}" failed to decrypt` +
      (health.error ? ` (${health.error})` : "") +
      " — likely encrypted on a different machine or user. Re-run 'syncro-now-ai login'."
    );
  }
  return null;
}
export const LOCAL_CONFIG_FILE = ".syncrona-local";

// DX7: a gitignored .syncrona-local in the working directory can set a default
// instance profile so you don't pass --instance-profile on every command.
function readLocalInstanceProfile(): string | undefined {
  try {
    const raw = readFileSync(path.join(process.cwd(), LOCAL_CONFIG_FILE), "utf-8");
    const parsed = JSON.parse(raw) as { instanceProfile?: unknown };
    const profile = typeof parsed.instanceProfile === "string" ? parsed.instanceProfile.trim() : "";
    return profile || undefined;
  } catch (_) {
    // Missing or unparseable .syncrona-local → no local default.
    return undefined;
  }
}

// Explicit --instance-profile wins over .syncrona-local, which wins over none.
export function resolveInstanceProfile(args: { instanceProfile?: string }): string | undefined {
  if (args.instanceProfile) {
    return args.instanceProfile;
  }
  return readLocalInstanceProfile();
}

export function setLogLevel(args: Sync.SharedCmdArgs) {
  logger.setLogLevel(args.logLevel);
  const profile = resolveInstanceProfile(args);
  if (profile && !args.instanceProfile) {
    logger.debug(`Using instance profile "${profile}" from ${LOCAL_CONFIG_FILE}`);
  }
  setActiveInstanceProfile(profile);
}

export function logScopedEndpointCapability(context: string): void {
  const prefix = getScopedEndpointPrefix();
  if (prefix) {
    logger.info(`Capability check (${context}): using scoped endpoint prefix ${prefix}.`);
    return;
  }

  logger.info(
    `Capability check (${context}): scoped endpoint prefix not detected. Using standard Table API mode (no scoped app required).`
  );
}

export async function scopeCheck(
  successFunc: () => void | Promise<void>,
  swapScopes: boolean = false
) {
  // Keep the scope check and the command body in separate try blocks so a
  // command failure is never misreported as a scope-configuration problem.
  let scopeMatches: boolean;
  try {
    const scopeCheckResult = await AppUtils.checkScope(swapScopes);
    scopeMatches = scopeCheckResult.match;
    if (!scopeMatches) {
      scopeCheckMessage(scopeCheckResult);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message) {
      logger.error(message);
    }
    logger.error(
      "Failed to check your scope! You may want to make sure your project is configured correctly or run `npx syncro-now-ai init`"
    );
    process.exitCode = 1;
    return;
  }

  if (!scopeMatches) {
    process.exitCode = 1;
    return;
  }

  try {
    await successFunc();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message || "Command failed with an unknown error.");
    process.exitCode = 1;
  }
}

export async function bootstrapWorkspaceOnLogin(): Promise<{
  createdConfig: boolean;
  sourcePath: string;
}> {
  const workspaceRoot = process.cwd();
  const configPath = path.join(workspaceRoot, "sync.config.js");
  const sourcePath = path.join(workspaceRoot, LOGIN_DEFAULT_SOURCE_DIRECTORY);

  let createdConfig = false;
  try {
    await fsp.stat(configPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }

    await fsp.writeFile(
      configPath,
      ConfigManager.getDefaultConfigFile(LOGIN_DEFAULT_SOURCE_DIRECTORY),
      "utf8"
    );
    createdConfig = true;
  }

  await fsp.mkdir(sourcePath, { recursive: true });
  return { createdConfig, sourcePath };
}
