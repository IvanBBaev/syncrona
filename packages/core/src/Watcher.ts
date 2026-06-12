import chokidar from "chokidar";
import { logFilePush } from "./logMessages";
import { debounce } from "lodash";
import { getFileContextFromPath } from "./FileUtils";
import { Sync } from "@syncrona/types";
import { groupAppFiles, pushFiles } from "./appUtils";
import { logger } from "./Logger";
const DEBOUNCE_MS = 300;
let pushQueue: string[] = [];
let watcher: chokidar.FSWatcher | undefined = undefined;

const processQueue = debounce(async () => {
  if (pushQueue.length > 0) {
    try {
      // dedupe pushes
      const toProcess = Array.from(new Set([...pushQueue]));
      pushQueue = [];
      const fileContexts = toProcess
        .map(getFileContextFromPath)
        .filter((ctx): ctx is Sync.FileContext => !!ctx);
      const buildables = groupAppFiles(fileContexts);
      const contextByBuildable = new Map<string, Sync.FileContext>();
      for (const ctx of fileContexts) {
        const key = `${ctx.tableName}-${ctx.sys_id}`;
        if (!contextByBuildable.has(key)) {
          contextByBuildable.set(key, ctx);
        }
      }

      const updateResults = await pushFiles(buildables);
      updateResults.forEach((res, index) => {
        const buildable = buildables[index];
        if (!buildable) {
          return;
        }

        const ctx = contextByBuildable.get(`${buildable.table}-${buildable.sysId}`);
        if (ctx) {
          logFilePush(ctx, res);
        }
      });
    } catch (e) {
      let message;
      if (e instanceof Error) {
        message = e.message;
      } else {
        message = String(e);
      }
      logger.error("Watcher queue processing failed");
      logger.error(message);
    }
  }
}, DEBOUNCE_MS);

export function startWatching(directory: string) {
  watcher = chokidar.watch(directory);
  watcher.on("change", fileChanged);
}

async function fileChanged(path: string) {
  pushQueue.push(path);
  processQueue();
}

export function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = undefined;
  }
}
