// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
import * as ConfigManager from "./config.js";
import { startWatching, stopWatching } from "./Watcher.js";
import * as AppUtils from "./appUtils.js";
import { logger } from "./Logger.js";
import { devModeLog } from "./logMessages.js";
import { setLogLevel, scopeCheck } from "./commandHelpers.js";

export async function devCommand(
  args: Sync.SharedCmdArgs & { refreshInterval?: number }
) {
  setLogLevel(args);
  await scopeCheck(async () => {
    startWatching(ConfigManager.getSourcePath());
    devModeLog();

    // Skip a scheduled refresh while the previous one is still running so a
    // slow network cannot stack concurrent manifest syncs.
    let refreshInFlight = false;
    const refresher = async () => {
      if (refreshInFlight) {
        logger.debug("Skipping scheduled refresh: previous refresh still running.");
        return;
      }
      refreshInFlight = true;
      const startedAt = Date.now();
      try {
        await refreshCommand(args, false);
      } finally {
        refreshInFlight = false;
        // DX21: surface refresh cost at debug/verbose so a slow instance is visible.
        logger.debug(`Manifest refresh took ${Date.now() - startedAt}ms`);
      }
    };
    // DX16: --refresh-interval overrides sync.config.js refreshInterval; 0 disables polling.
    const interval =
      typeof args.refreshInterval === "number" && Number.isFinite(args.refreshInterval)
        ? Math.max(0, Math.floor(args.refreshInterval))
        : ConfigManager.getRefresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (interval && interval > 0) {
      logger.info(`Checking for new manifest files every ${interval} seconds`);
      timer = setInterval(() => {
        void refresher();
      }, interval * 1000);
      // Don't keep the process alive just for the refresh timer.
      timer.unref();
    }
    // Always stop the file watcher cleanly on Ctrl+C — even when polling is
    // disabled (interval 0), startWatching() above is still running and would
    // otherwise leak with no SIGINT handler to release it.
    process.once("SIGINT", () => {
      if (timer) {
        clearInterval(timer);
      }
      void stopWatching();
    });
  });
}

export async function refreshCommand(
  args: Sync.SharedCmdArgs,
  log: boolean = true
) {
  setLogLevel(args);
  // #1: quieting a background refresh must NOT reset the active instance
  // profile. setLogLevel() also calls setActiveInstanceProfile(), and the
  // dev refresher passes a bare { logLevel: "warn" } with no instanceProfile,
  // which would reset the session profile mid-run and silently target the
  // BASE instance. Drive the logger level directly so the profile that
  // setLogLevel(args) established above is preserved through the refresh.
  const previousLogLevel = logger.getLogLevel();
  await scopeCheck(async () => {
    if (!log) logger.setLogLevel("warn");
    try {
      const ok = await AppUtils.syncManifest();
      if (ok) {
        logger.success("Refresh complete! ✅");
      } else if (log) {
        // Interactive refresh: surface the failure as a real error exit.
        process.exitCode = 1;
      }
    } finally {
      if (!log) logger.setLogLevel(previousLogLevel);
    }
  });
}
