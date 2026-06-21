import { Sync } from "@syncro-now-ai/types";
import path from "path";
import inquirer from "inquirer";
import { logger } from "./Logger";
import {
  saveCredentials,
  listInstances,
  removeCredentials,
  removeAllCredentials,
  setActiveInstance,
  getActiveInstance,
} from "./auth";
import {
  preloadStoredCredentials,
  clearStoredCredentialsCache,
} from "./snClient";
import { writeDotEnv, ensureGitignored } from "./envFile";
import { setLogLevel, bootstrapWorkspaceOnLogin } from "./commandHelpers";

export async function loginCommand(args: Sync.SharedCmdArgs & { instance?: string }): Promise<void> {
  setLogLevel(args);

  const { instance: instanceArg } = args;

  let normalizedInstance: string;
  if (instanceArg) {
    normalizedInstance = instanceArg.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  } else {
    const { instance } = await inquirer.prompt<{ instance: string }>([
      {
        type: "input",
        name: "instance",
        message: "ServiceNow instance (e.g. dev12345.service-now.com):",
        validate: (v: string) =>
          v.trim().length > 0 ? true : "Instance URL is required.",
      },
    ]);
    normalizedInstance = instance.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  const { user } = await inquirer.prompt<{ user: string }>([
    {
      type: "input",
      name: "user",
      message: "Username:",
      validate: (v: string) => (v.trim().length > 0 ? true : "Username is required."),
    },
  ]);

  const { password } = await inquirer.prompt<{ password: string }>([
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
      validate: (v: string) => (v.trim().length > 0 ? true : "Password is required."),
    },
  ]);

  logger.info(`Connecting to ${normalizedInstance}...`);

  // Test connection before saving
  const { snClient: createClient } = await import("./snClient");
  const testClient = createClient(`https://${normalizedInstance}/`, user.trim(), password.trim());
  try {
    await testClient.checkConnection(8000);
  } catch (e) {
    logger.error(
      `Cannot reach ${normalizedInstance}. Check the instance URL, username, and password.`
    );
    process.exit(1);
  }

  await saveCredentials(normalizedInstance, user.trim(), password.trim());

  // Persist instance + credentials to a local .env for the workspace and keep
  // it out of version control.
  try {
    const envPath = path.join(process.cwd(), ".env");
    await writeDotEnv(envPath, {
      SN_INSTANCE: normalizedInstance,
      SN_USER: user.trim(),
      SN_PASSWORD: password.trim(),
    });
    await ensureGitignored(process.cwd(), ".env");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Logged in, but failed to write .env: ${message}`);
  }

  const existingActive = await getActiveInstance();
  if (!existingActive) {
    await setActiveInstance(normalizedInstance);
    logger.success(`Logged in to ${normalizedInstance} and set as active instance.`);
  } else {
    logger.success(`Logged in to ${normalizedInstance}.`);
    if (existingActive !== normalizedInstance) {
      const { switchActive } = await inquirer.prompt<{ switchActive: boolean }>([
        {
          type: "confirm",
          name: "switchActive",
          message: `Set ${normalizedInstance} as the active instance? (current: ${existingActive})`,
          default: true,
        },
      ]);
      if (switchActive) {
        await setActiveInstance(normalizedInstance);
        await preloadStoredCredentials();
        logger.success(`Active instance switched to ${normalizedInstance}.`);
      }
    }
  }

  await preloadStoredCredentials();

  try {
    const { createdConfig, sourcePath } = await bootstrapWorkspaceOnLogin();
    if (createdConfig) {
      logger.info(`Created default sync.config.js in ${process.cwd()}.`);
    }
    logger.info(`Workspace structure ready. Source directory: ${sourcePath}`);
  } catch (e) {
    let message = "Unknown error";
    if (e instanceof Error && e.message.trim()) {
      message = e.message;
    }
    logger.warn(`Logged in, but failed to prepare workspace structure: ${message}`);
  }

  logger.info("Run `syncro-now-ai init` to discover scope and generate sync.manifest.json.");
}

export async function logoutCommand(
  args: Sync.SharedCmdArgs & { instance?: string; all?: boolean }
): Promise<void> {
  setLogLevel(args);

  if (args.all) {
    const count = await removeAllCredentials();
    clearStoredCredentialsCache();
    logger.success(`Removed credentials for ${count} instance(s).`);
    return;
  }

  const targetInstance = args.instance;
  if (!targetInstance) {
    logger.error("Specify an instance to log out from, or use --all to remove all.");
    logger.info("Example: syncro-now-ai logout dev12345.service-now.com");
    process.exit(1);
  }

  const normalizedInstance = targetInstance
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  await removeCredentials(normalizedInstance);
  clearStoredCredentialsCache();

  const active = await getActiveInstance();
  if (active === normalizedInstance) {
    const remaining = await listInstances();
    if (remaining.length > 0) {
      await setActiveInstance(remaining[0]);
      logger.info(`Active instance reset to ${remaining[0]}.`);
    }
  }

  logger.success(`Logged out from ${normalizedInstance}.`);
}

export async function instancesCommand(args: Sync.SharedCmdArgs): Promise<void> {
  setLogLevel(args);

  const all = await listInstances();
  const active = await getActiveInstance();

  if (all.length === 0) {
    logger.info("No saved instances. Run `syncro-now-ai login` to add one.");
    return;
  }

  logger.info("Saved instances:");
  for (const inst of all) {
    const marker = inst === active ? " (active)" : "";
    logger.info(`  ${inst}${marker}`);
  }
}

export async function useCommand(
  args: Sync.SharedCmdArgs & { instance: string }
): Promise<void> {
  setLogLevel(args);

  const normalizedInstance = args.instance
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const all = await listInstances();
  if (!all.includes(normalizedInstance)) {
    logger.error(
      `No saved credentials for "${normalizedInstance}". Run: syncro-now-ai login ${normalizedInstance}`
    );
    process.exit(1);
  }

  await setActiveInstance(normalizedInstance);
  await preloadStoredCredentials();
  logger.success(`Active instance set to ${normalizedInstance}.`);
}
