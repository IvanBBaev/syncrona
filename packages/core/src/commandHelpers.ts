import { Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import { logger } from "./Logger";
import { scopeCheckMessage } from "./logMessages";
import { setActiveInstanceProfile, getScopedEndpointPrefix } from "./snClient";

export const LOGIN_DEFAULT_SOURCE_DIRECTORY = "src";

export function setLogLevel(args: Sync.SharedCmdArgs) {
  logger.setLogLevel(args.logLevel);
  setActiveInstanceProfile(args.instanceProfile);
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
  try {
    const scopeCheck = await AppUtils.checkScope(swapScopes);
    if (!scopeCheck.match) {
      scopeCheckMessage(scopeCheck);
      // Throw exception to register this as an error
      throw new Error();
    } else {
      await successFunc();
    }
  } catch (e) {
    logger.error(
      "Failed to check your scope! You may want to make sure your project is configured correctly or run `npx syncrona init`"
    );
    // Throw exception to register this as an error
    process.exit(1);
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
