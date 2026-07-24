// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { createHash, randomUUID } from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import * as AppUtils from "./appUtils.js";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import { logPushResults } from "./logMessages.js";
import { defaultClient, resolveCredentials } from "./snClient.js";
import inquirer from "inquirer";
import { formatTable } from "./genericUtils.js";
import { gitDiffToEncodedPaths } from "./gitUtils.js";
import {
  setLogLevel,
  scopeCheck,
  logScopedEndpointCapability,
  getActiveStoreDecryptWarning,
  logErrorHint,
} from "./commandHelpers.js";

type PushCheckpoint = {
  attempted: string[];
  succeeded: string[];
  failed: string[];
  // The instance the checkpoint was written against. A checkpoint may only be
  // resumed against the same target — resuming instance A's failures against
  // instance B would push the wrong (partial) set of records. Optional so a
  // legacy checkpoint (written before this field existed) is treated as
  // "unknown instance" and safely discarded rather than misapplied.
  instance?: string;
  // Content fingerprint of every attempted record, keyed like `attempted`.
  // Record identity (table:sysId) alone cannot tell "already pushed" from
  // "pushed, then edited": resume would skip the edited record and still exit 0,
  // so the edit would never reach the instance. Optional so a legacy checkpoint
  // (written before this field existed) still resumes on identity alone.
  fingerprints?: Record<string, string>;
};

type CollaborationLock = {
  command: string;
  pid: number;
  createdAt: string;
  instanceProfile?: string;
};

const PUSH_CHECKPOINT_FILE = "sync.push.checkpoint.json";
const COLLABORATION_LOCK_FILE = "sync.collaboration.lock.json";
const COLLABORATION_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

// Lock/checkpoint live in the project root so runs from subdirectories share
// the same state; fall back to cwd when no config has been loaded yet.
const getStateBaseDir = (): string => {
  try {
    return ConfigManager.getRootDir();
  } catch (_) {
    return process.cwd();
  }
};

const getPushCheckpointPath = () => path.join(getStateBaseDir(), PUSH_CHECKPOINT_FILE);
const getCollaborationLockPath = () => path.join(getStateBaseDir(), COLLABORATION_LOCK_FILE);

const recToCheckpointKey = (rec: Sync.BuildableRecord): string =>
  `${rec.table}:${rec.sysId}`;

// Fingerprints the sources a record pushes, so a later resume can tell whether
// the record still holds the content that was pushed. Field order is normalized
// so the fingerprint depends on content only. A source that cannot be read
// hashes to a unique value on purpose: content we cannot read is content we
// cannot prove unchanged, so the record is always re-pushed rather than skipped.
async function fingerprintRecord(rec: Sync.BuildableRecord): Promise<string> {
  const hash = createHash("sha256");
  for (const field of Object.keys(rec.fields).sort()) {
    hash.update(`${field}\0`);
    try {
      hash.update(await fsp.readFile(rec.fields[field].filePath));
    } catch (_) {
      hash.update(randomUUID());
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fingerprintRecords(
  recs: Sync.BuildableRecord[]
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    recs.map(
      async (rec) => [recToCheckpointKey(rec), await fingerprintRecord(rec)] as const
    )
  );
  return Object.fromEntries(entries);
}

async function loadPushCheckpoint(): Promise<PushCheckpoint | null> {
  try {
    const raw = await fsp.readFile(getPushCheckpointPath(), "utf8");
    const parsed = JSON.parse(raw) as PushCheckpoint;
    if (!Array.isArray(parsed.attempted) || !Array.isArray(parsed.succeeded) || !Array.isArray(parsed.failed)) {
      return null;
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writePushCheckpoint(checkpoint: PushCheckpoint): Promise<void> {
  await fsp.writeFile(
    getPushCheckpointPath(),
    JSON.stringify(checkpoint, null, 2),
    "utf8"
  );
}

async function clearPushCheckpoint(): Promise<void> {
  try {
    await fsp.unlink(getPushCheckpointPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

async function loadCollaborationLock(): Promise<CollaborationLock | null> {
  try {
    const raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
    const parsed = JSON.parse(raw) as CollaborationLock;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.command !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

// process.kill(pid, 0) sends no signal but performs the permission/existence
// check: it throws ESRCH when no such process exists (owner crashed/exited) and
// EPERM when the process exists but is owned by another user. "Alive" therefore
// means "did not throw ESRCH". A non-finite/absent pid is treated as unknown →
// alive, so the age check stays the sole authority for legacy/foreign locks.
function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists (we just can't signal it) → still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isCollaborationLockStale(lock: CollaborationLock): boolean {
  const createdAtMs = Date.parse(lock.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }
  // A lock whose owning process is gone is stale immediately, even inside the
  // 30-minute window: a crashed push must not block collaborators for half an
  // hour. Age remains the backstop for locks whose owner is still alive (or
  // whose pid can't be checked, e.g. a lock written on another host).
  if (!isProcessAlive(lock.pid)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_LOCK_MAX_AGE_MS;
}

async function acquireCollaborationLock(
  command: string,
  instanceProfile?: string
): Promise<{ acquired: boolean; reason?: string }> {
  const lockPayload: CollaborationLock = {
    command,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    instanceProfile,
  };
  const payload = JSON.stringify(lockPayload, null, 2);

  // "wx" makes creation atomic: two concurrent runs cannot both win the race.
  // One retry after removing a stale/corrupt lock file.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(getCollaborationLockPath(), payload, { encoding: "utf8", flag: "wx" });
      return { acquired: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
      const existing = await loadCollaborationLock();
      if (existing && !isCollaborationLockStale(existing)) {
        const owner = typeof existing.pid === "number" ? `pid ${existing.pid}` : "unknown pid";
        return {
          acquired: false,
          reason: `Detected active ${existing.command} lock (${owner}) created at ${existing.createdAt}.`,
        };
      }
      // The lock is stale (or corrupt). Reclaim it atomically — a blind unlink
      // here would delete a *live* lock a racing push created after we observed
      // the stale one, letting both pushes proceed (see reclaimStaleLock).
      await reclaimStaleLock();
    }
  }

  return { acquired: false, reason: "Could not acquire collaboration lock." };
}

async function releaseCollaborationLock(): Promise<void> {
  try {
    await fsp.unlink(getCollaborationLockPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

// Atomically reclaim a lock we've judged stale, without ever removing a lock a
// concurrent push may have legitimately created. The old code blindly unlinked
// whatever file was at the lock path, so two pushes that both observed the same
// stale lock would each unlink it and create their own — breaking mutual
// exclusion. Instead we move the file aside with a single atomic rename: for a
// given path only one racer's rename can win (the loser sees ENOENT), and we
// then re-check what we actually moved. If it is stale we discard it, freeing
// the path for the caller's 'wx' create; if a racer had already replaced it
// with a live lock, we put that lock back and let the caller re-evaluate.
async function reclaimStaleLock(): Promise<void> {
  const lockPath = getCollaborationLockPath();
  const asidePath = `${lockPath}.${process.pid}.reclaim`;
  try {
    await fsp.rename(lockPath, asidePath);
  } catch (e) {
    // ENOENT: another racer already moved/removed the stale lock. Nothing to
    // reclaim — the retry loop re-reads whatever is at the path now.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw e;
  }
  const moved = await (async (): Promise<CollaborationLock | null> => {
    try {
      const parsed = JSON.parse(await fsp.readFile(asidePath, "utf8")) as CollaborationLock;
      return parsed && typeof parsed === "object" && typeof parsed.createdAt === "string"
        ? parsed
        : null;
    } catch {
      // Unparseable/unreadable content is junk by definition — safe to discard.
      return null;
    }
  })();

  if (moved === null || isCollaborationLockStale(moved)) {
    // Confirmed stale (or corrupt) — discard it; the path is now free.
    await fsp.unlink(asidePath).catch(() => undefined);
    return;
  }
  // We moved a live lock a racer created in the window before our rename.
  // Restore it so its owner keeps the lock, and abort the reclaim.
  await fsp.rename(asidePath, lockPath).catch(() => undefined);
}

// #18: the collaboration-lock primitives are otherwise reachable only through
// the full pushCommand flow (network client, inquirer prompts, config). This
// test-facing surface lets the lock lifecycle — atomic acquire, stale-pid
// reclaim, real-filesystem release — be exercised directly against a temp dir.
// Not part of the public CLI API; exported solely for coverage of the lock
// contract that guards concurrent pushes.
export const __lockInternals = {
  acquireCollaborationLock,
  releaseCollaborationLock,
  reclaimStaleLock,
  loadCollaborationLock,
  isCollaborationLockStale,
  isProcessAlive,
  getCollaborationLockPath,
};

export async function pushCommand(args: Sync.PushCmdArgs): Promise<void> {
  setLogLevel(args);
  await scopeCheck(async () => {
    let lockAcquired = false;
    try {
      const dryRun = args.dryRun === true;
      const credentials = resolveCredentials(args.instanceProfile);
      const targetServer = credentials.instance;
      if (!targetServer) {
        logger.error("No server configured for push!");
        // DX20b: a logged-in user with no env creds may have a stored instance
        // that won't decrypt — that's the real reason, not "no server".
        const decryptWarning = await getActiveStoreDecryptWarning();
        if (decryptWarning) {
          logger.warn(decryptWarning);
        }
        // #49: tailor the next step to how credentials are configured instead of
        // hardcoding SN_* advice, and route it through the DX19 taxonomy sink.
        // No instance resolved is a configuration problem (missing config/.env).
        logErrorHint(new Error("missing config: no instance configured for push"));
        // #3: a misconfigured push (including `push --ci`) must fail the shell.
        process.exitCode = 1;
        return;
      }

      const client = defaultClient(args.instanceProfile);
      try {
        await client.checkConnection(5000);
        logScopedEndpointCapability("push");
      } catch (e) {
        logger.error(
          `Unable to reach ServiceNow instance ${targetServer} before push. Check the instance URL and network connectivity.`
        );
        // #49: classify the real reason (network vs auth) via the DX19 taxonomy
        // rather than hardcoding SN_* env-var advice.
        logErrorHint(e);
        // #3: an unreachable instance must fail the shell, not report success.
        process.exitCode = 1;
        return;
      }

      const { updateSet, ci: skipPrompt, target, diff } = args;
      let encodedPaths;
      if (target !== undefined && target !== "") encodedPaths = target;
      else encodedPaths = await gitDiffToEncodedPaths(diff);

      let fileList = await AppUtils.getAppFileList(encodedPaths);

      // A dry run is a read-only preview, so it returns before any checkpoint
      // state is read, resumed or cleared: previewing must never consume or
      // destroy the resume state a later real push depends on. It also previews
      // the FULL current diff, since narrowing it to a checkpoint's failures
      // would describe a push this run is not the one to perform.
      if (dryRun) {
        logger.info(`${fileList.length} files to push.`);
        if (fileList.length > 0) {
          const rows = fileList.map((rec) => {
            const fieldNames = Object.keys(rec.fields);
            const recordName = rec.fields[fieldNames[0]]?.name || rec.sysId;
            return [rec.table, recordName, String(fieldNames.length), rec.sysId];
          });
          logger.info(
            "Dry run — records that would be pushed:\n" +
              formatTable(["Table", "Record", "Fields", "sys_id"], rows)
          );
        }
        logger.info("Dry run enabled: skipping push checkpoint writes and remote push operation.");
        return;
      }

      // The resume decision below and the checkpoint written further down must
      // describe the same content, so the sources are fingerprinted once and the
      // result reused. It is computed on demand: a run that aborts before it
      // pushes anything (a declined prompt, a lock conflict) must not read every
      // source to reach that abort.
      let fingerprintsPromise: Promise<Record<string, string>> | undefined;
      const getCurrentFingerprints = () => {
        // Memoized against the record set current at first call. Later lookups
        // are by checkpoint key and only ever ask about records still in
        // fileList, which resume can shrink but never extend.
        if (!fingerprintsPromise) {
          fingerprintsPromise = fingerprintRecords(fileList);
        }
        return fingerprintsPromise;
      };

      const existingCheckpoint = await loadPushCheckpoint();
      if (existingCheckpoint && existingCheckpoint.failed.length > 0) {
        // A checkpoint only belongs to *this* push when three things all hold.
        // Otherwise it is discarded and the FULL current diff is pushed — never
        // silently narrowed — because a partial push that still exits 0 hides a
        // broken deployment.
        const currentKeys = new Set(fileList.map(recToCheckpointKey));
        const attemptedSet = new Set(existingCheckpoint.attempted);

        // #7: the checkpoint must belong to the instance we are pushing to now.
        // A checkpoint written against another instance (or a legacy checkpoint
        // with no recorded instance) must not be resumed here.
        const sameInstance = (existingCheckpoint.instance ?? "") === targetServer;
        // Every record the checkpoint still needs to retry is part of this diff.
        // Guards against a stale checkpoint from an unrelated earlier commit.
        const failedInCurrent = existingCheckpoint.failed.every((key) =>
          currentKeys.has(key)
        );
        // #1: the current diff introduces no record the checkpoint never attempted.
        // If the diff GREW since the checkpoint (a new record appeared), resuming
        // "only failed" would silently drop the new record and still exit 0.
        const currentIsSubsetOfAttempted = fileList.every((rec) =>
          attemptedSet.has(recToCheckpointKey(rec))
        );

        const checkpointMatchesDiff =
          sameInstance && failedInCurrent && currentIsSubsetOfAttempted;

        if (!checkpointMatchesDiff) {
          logger.warn(
            "Ignoring an unrelated push checkpoint from a previous run — it targets a different instance or does not match the current changes. Pushing the full current diff."
          );
          await clearPushCheckpoint();
        } else {
          const shouldResume = skipPrompt
            ? true
            : (
                await inquirer.prompt<{ confirmed: boolean }>([
                  {
                    type: "confirm",
                    name: "confirmed",
                    message:
                      "Found unfinished push checkpoint. Resume only failed records from the previous run?",
                    default: true,
                  },
                ])
              ).confirmed;

          if (shouldResume) {
            const failedKeys = new Set(existingCheckpoint.failed);
            // A record is skipped only when it already succeeded AND still holds
            // the content that succeeded. A record edited after the checkpoint
            // was written is pushed again — skipping it on identity alone would
            // drop the edit while the run still exits 0. A checkpoint with no
            // fingerprints predates the field and can only resume on identity.
            const recordedFingerprints = existingCheckpoint.fingerprints;
            // Nothing to compare a legacy checkpoint against, so the sources are
            // not read at all in that case.
            const currentFingerprints = recordedFingerprints
              ? await getCurrentFingerprints()
              : undefined;
            fileList = fileList.filter((rec) => {
              const key = recToCheckpointKey(rec);
              if (failedKeys.has(key)) {
                return true;
              }
              if (!recordedFingerprints || !currentFingerprints) {
                return false;
              }
              return recordedFingerprints[key] !== currentFingerprints[key];
            });
            logger.info(`Resuming from checkpoint with ${fileList.length} records.`);
          } else {
            await clearPushCheckpoint();
          }
        }
      }

      logger.info(`${fileList.length} files to push.`);

      const lock = await acquireCollaborationLock("push", args.instanceProfile);
      if (!lock.acquired) {
        logger.warn(`Push aborted due to collaboration lock conflict. ${lock.reason || ""}`.trim());
        logger.warn(
          "If this lock is stale, delete sync.collaboration.lock.json or wait for the active push to complete."
        );
        // A lock conflict pushed nothing, so it must fail the shell like every
        // other non-success abort; exiting 0 reports a no-op deploy as green.
        process.exitCode = 1;
        return;
      }
      lockAcquired = true;

      if (!skipPrompt) {
        const answers: { confirmed: boolean } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmed",
            message:
              "Pushing will overwrite code in your instance. Are you sure?",
            default: false,
          },
        ]);
        if (!answers["confirmed"]) return;
      }

      // Does not create update set if updateSetName is blank
      if (updateSet) {
        if (!skipPrompt) {
          const answers: { confirmed: boolean } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmed",
              message: `A new Update Set "${updateSet}" will be created for these pushed changes. Do you want to proceed?`,
              default: false,
            },
          ]);
          if (!answers["confirmed"]) {
            return;
          }
        }

        const newUpdateSet = await AppUtils.createAndAssignUpdateSet(updateSet);
        logger.debug(
          `New Update Set Created(${newUpdateSet.name}) sys_id:${newUpdateSet.id}`
        );
      }

      // Write the checkpoint only after every confirmation has passed, so a
      // declined prompt leaves no fake "unfinished push" state behind.
      const attempted = fileList.map(recToCheckpointKey);
      const currentFingerprints = await getCurrentFingerprints();
      const fingerprints = Object.fromEntries(
        attempted.map((key) => [key, currentFingerprints[key]])
      );
      await writePushCheckpoint({
        attempted,
        succeeded: [],
        failed: attempted,
        instance: targetServer,
        fingerprints,
      });

      const pushResults = await AppUtils.pushFiles(fileList, args.pushConcurrency);

      const succeeded = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => item.res.success)
        .map((item) => item.key);

      const failed = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => !item.res.success)
        .map((item) => item.key);

      await writePushCheckpoint({
        attempted,
        succeeded,
        failed,
        instance: targetServer,
        fingerprints,
      });
      if (failed.length === 0) {
        await clearPushCheckpoint();
      } else {
        // #3: per-record push failures never reach the outer catch (pushFiles
        // converts them to { success: false } results), so `push --ci` used to
        // exit 0 on a broken deployment. Fail the shell whenever any record failed.
        process.exitCode = 1;
      }

      logPushResults(pushResults);
    } catch (e) {
      logger.getInternalLogger().error(e);
      logErrorHint(e); // DX19: actionable next step based on error category
      // exitCode instead of process.exit so the finally block can still
      // release the collaboration lock before the process ends.
      process.exitCode = 1;
    } finally {
      if (lockAcquired) {
        await releaseCollaborationLock();
      }
    }
  }, args.scopeSwap);
}
