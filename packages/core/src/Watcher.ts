// SPDX-License-Identifier: GPL-3.0-or-later
import chokidar from "chokidar";
import { logFilePush } from "./logMessages.js";
// lodash is CommonJS; under ESM its named exports are not statically detectable
// by Node, so import the default and destructure the method we need.
import lodash from "lodash";
import { getFileContextFromPath } from "./FileUtils.js";
import { Sync } from "@syncrona/types";
import { groupAppFiles, pushFiles } from "./appUtils.js";
import { logger } from "./Logger.js";
const { debounce } = lodash;
const DEBOUNCE_MS = 300;
// Self-driving retry backoff for a failed batch. A rejected push requeues its
// files, but nothing guarantees another fs event will ever arrive to drive the
// next drain — so the requeued changes would strand indefinitely. Instead the
// drain schedules its own retry on a capped exponential backoff.
const RETRY_BASE_MS = 500;
const MAX_RETRY_MS = 30_000;
let pushQueue: string[] = [];
let watcher: chokidar.FSWatcher | undefined = undefined;
// Serializes queue processing: changes arriving while a push is in flight are
// queued and handled in one follow-up run instead of a concurrent push.
let processing = false;
// Pending self-driving retry and its backoff step. Both are cleared on any
// full, failure-free drain and on stopWatching so a recovered watcher does not
// keep firing retries or carry a stale backoff into the next failure.
let retryTimer: NodeJS.Timeout | undefined = undefined;
let retryAttempt = 0;

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
      // Queue-depth visibility: a mass update (e.g. a 50-file git checkout)
      // lands here as one batch — surface its size so the user can tell a
      // flood apart from a normal save. Single-file drains stay quiet.
      if (toProcess.length > 1) {
        logger.info(`Pushing ${toProcess.length} queued file changes.`);
      }
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
    // Full, failure-free drain: reset the backoff ladder and cancel any pending
    // self-driving retry — the queue is empty, so there is nothing left to
    // retry and the next failure should start the backoff from scratch.
    retryAttempt = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
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
    // Drive the next drain ourselves: without a guaranteed future fs event the
    // requeued batch would otherwise never be retried. Guard against stacking
    // so overlapping failures schedule at most one pending retry.
    if (!retryTimer) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, MAX_RETRY_MS);
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void drainQueue();
      }, delay);
      // A pending retry must not by itself keep the Node process alive.
      retryTimer.unref();
    }
  } finally {
    processing = false;
  }
};

const processQueue = debounce(() => {
  void drainQueue();
}, DEBOUNCE_MS);

export function startWatching(directory: string) {
  watcher = chokidar.watch(directory, {
    // Chokidar fires "add" for every pre-existing file during its initial
    // scan; without this flag a fresh watch session would flood the push
    // queue with the entire source tree on startup.
    ignoreInitial: true,
    // Editors commonly save atomically (write a temp file, then rename over
    // the target) or flush in several chunks. Waiting until the file size has
    // been stable avoids pushing half-written content. Conservative values:
    // 200ms of stability polled every 50ms adds imperceptible latency to a
    // manual save while covering slow multi-chunk writes.
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });
  watcher.on("change", fileChanged);
  watcher.on("add", fileAdded);
  watcher.on("unlink", fileUnlinked);
  watcher.on("error", watcherError);
}

async function fileChanged(path: string) {
  pushQueue.push(path);
  processQueue();
}

function fileAdded(path: string): void {
  // With ignoreInitial enabled this only fires for files that appear after
  // startup. A new file is only pushable when the manifest already tracks it
  // (e.g. a tracked file restored via `git checkout` or re-created after a
  // local delete): getFileContextFromPath resolves paths through the manifest
  // and returns undefined for unknown files, which drainQueue would then
  // silently drop. Surface the untracked case instead of pretending to sync.
  let tracked = false;
  try {
    tracked = Boolean(getFileContextFromPath(path));
  } catch {
    // No manifest loaded — treat the file as untracked and log guidance.
  }
  if (tracked) {
    pushQueue.push(path);
    processQueue();
    return;
  }
  logger.warn(
    `New file detected: ${path} — it is not tracked by the manifest, so it will not be pushed. Run "syncrona refresh" (or "syncrona repair") to register it.`
  );
}

function fileUnlinked(path: string): void {
  logger.warn(
    `File deleted locally: ${path} — delete propagation is not supported, so the instance record is unchanged. Run "syncrona repair" to reconcile the manifest.`
  );
}

function watcherError(error: unknown): void {
  // A failed watcher means local edits silently stop syncing — make that
  // failure mode explicit but keep the process alive so an in-flight push
  // (and a possible watcher recovery) can still complete.
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`File watcher error: ${message}`);
  logger.error(
    'Watching may be degraded — local changes may silently stop syncing. If pushes stop appearing, restart "syncrona dev".'
  );
}

export async function stopWatching(): Promise<void> {
  // Cancel any pending self-driving retry and reset the backoff so a restarted
  // watcher does not inherit a stale timer or backoff step.
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  retryAttempt = 0;
  if (watcher) {
    const current = watcher;
    watcher = undefined;
    await current.close();
  }
}
