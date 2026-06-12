import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config";
import { startWatching, stopWatching } from "./Watcher";
import * as AppUtils from "./appUtils";
import { logger } from "./Logger";
import { devModeLog } from "./logMessages";
import { setLogLevel, scopeCheck } from "./commandHelpers";

export async function devCommand(args: Sync.SharedCmdArgs) {
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
      try {
        await refreshCommand(args, false);
      } finally {
        refreshInFlight = false;
      }
    };
    const interval = ConfigManager.getRefresh();
    if (interval && interval > 0) {
      logger.info(`Checking for new manifest files every ${interval} seconds`);
      const timer = setInterval(() => {
        void refresher();
      }, interval * 1000);
      // Don't keep the process alive just for the refresh timer, and stop
      // cleanly on Ctrl+C.
      timer.unref();
      process.once("SIGINT", () => {
        clearInterval(timer);
        void stopWatching();
      });
    }
  });
}

export async function refreshCommand(
  args: Sync.SharedCmdArgs,
  log: boolean = true
) {
  setLogLevel(args);
  await scopeCheck(async () => {
    if (!log) setLogLevel({ logLevel: "warn" });
    const ok = await AppUtils.syncManifest();
    if (ok) {
      logger.success("Refresh complete! ✅");
    } else if (log) {
      // Interactive refresh: surface the failure as a real error exit.
      process.exitCode = 1;
    }
    setLogLevel(args);
  });
}
