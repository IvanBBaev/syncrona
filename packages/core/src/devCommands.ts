import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config";
import { startWatching } from "./Watcher";
import * as AppUtils from "./appUtils";
import { logger } from "./Logger";
import { devModeLog } from "./logMessages";
import { setLogLevel, scopeCheck } from "./commandHelpers";

export async function devCommand(args: Sync.SharedCmdArgs) {
  setLogLevel(args);
  await scopeCheck(async () => {
    startWatching(ConfigManager.getSourcePath());
    devModeLog();

    let refresher = () => {
      refreshCommand(args, false);
    };
    let interval = ConfigManager.getRefresh();
    if (interval && interval > 0) {
      logger.info(`Checking for new manifest files every ${interval} seconds`);
      setInterval(refresher, interval * 1000);
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
    await AppUtils.syncManifest();
    logger.success("Refresh complete! ✅");
    setLogLevel(args);
  });
}
