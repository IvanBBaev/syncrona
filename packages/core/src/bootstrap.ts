import dotenv from "dotenv";
import * as ConfigManager from "./config";
import { preloadStoredCredentials } from "./snClient";
import { runUpdateNotifier } from "./updateNotifier";

export async function init() {
  try {
    await ConfigManager.loadConfigs();
  } catch (e) {
    console.log(e);
  }

  let path = ConfigManager.getEnvPath();
  dotenv.config({
    path,
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

  (await import("./commander")).initCommands();
}
