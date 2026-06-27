// SPDX-License-Identifier: GPL-3.0-or-later
import chokidar from "chokidar";
import { logFilePush } from "./logMessages";
import { debounce } from "lodash";
import { getFileContextFromPath } from "./FileUtils";
import { Sync } from "@syncro-now-ai/types";
import { groupAppFiles, pushFiles } from "./appUtils";
import { logger } from "./Logger";
const DEBOUNCE_MS = 300;
let pushQueue: string[] = [];
let watcher: chokidar.FSWatcher | undefined = undefined;
// Serializes queue processing: changes arriving while a push is in flight are
// queued and handled in one follow-up run instead of a concurrent push.
let processing = false;

const drainQueue = async (): Promise<void> => {
  if (processing) {
    return;
  }
  processing = true;
  // Tracks the batch currently being pushed so it can be requeued if the push
  // throws — the queue is cleared before the push runs, so without this those
  // file changes would be silently dropped and never retried.
  let inFlight: string[] = [];
  try {
    while (pushQueue.length > 0) {
      // dedupe pushes
      const toProcess = Array.from(new Set([...pushQueue]));
      pushQueue = [];
      inFlight = toProcess;
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
      // Batch pushed successfully — nothing to requeue if a later batch fails.
      inFlight = [];
    }
  } catch (e) {
    // Requeue the in-flight batch (ahead of anything that arrived since) so the
    // failed changes are retried on the next drain instead of being lost.
    if (inFlight.length > 0) {
      pushQueue = Array.from(new Set([...inFlight, ...pushQueue]));
    }
    let message;
    if (e instanceof Error) {
      message = e.message;
    } else {
      message = String(e);
    }
    logger.error("Watcher queue processing failed");
    logger.error(message);
  } finally {
    processing = false;
  }
};

const processQueue = debounce(() => {
  void drainQueue();
}, DEBOUNCE_MS);

export function startWatching(directory: string) {
  watcher = chokidar.watch(directory);
  watcher.on("change", fileChanged);
}

async function fileChanged(path: string) {
  pushQueue.push(path);
  processQueue();
}

export async function stopWatching(): Promise<void> {
  if (watcher) {
    const current = watcher;
    watcher = undefined;
    await current.close();
  }
}
