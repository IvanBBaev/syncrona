import { Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import * as AppUtils from "./appUtils";
import { logger } from "./Logger";
import { logPushResults } from "./logMessages";
import { defaultClient, resolveCredentials } from "./snClient";
import inquirer from "inquirer";
import { gitDiffToEncodedPaths } from "./gitUtils";
import {
  setLogLevel,
  scopeCheck,
  logScopedEndpointCapability,
} from "./commandHelpers";

type PushCheckpoint = {
  attempted: string[];
  succeeded: string[];
  failed: string[];
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

const getPushCheckpointPath = () => path.join(process.cwd(), PUSH_CHECKPOINT_FILE);
const getCollaborationLockPath = () => path.join(process.cwd(), COLLABORATION_LOCK_FILE);

const recToCheckpointKey = (rec: Sync.BuildableRecord): string =>
  `${rec.table}:${rec.sysId}`;

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

function isCollaborationLockStale(lock: CollaborationLock): boolean {
  const createdAtMs = Date.parse(lock.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_LOCK_MAX_AGE_MS;
}

async function acquireCollaborationLock(
  command: string,
  instanceProfile?: string
): Promise<{ acquired: boolean; reason?: string }> {
  const existing = await loadCollaborationLock();
  if (existing && !isCollaborationLockStale(existing)) {
    const owner = typeof existing.pid === "number" ? `pid ${existing.pid}` : "unknown pid";
    return {
      acquired: false,
      reason: `Detected active ${existing.command} lock (${owner}) created at ${existing.createdAt}.`,
    };
  }

  const lockPayload: CollaborationLock = {
    command,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    instanceProfile,
  };
  await fsp.writeFile(getCollaborationLockPath(), JSON.stringify(lockPayload, null, 2), "utf8");
  return { acquired: true };
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
        return;
      }

      const client = defaultClient(args.instanceProfile);
      try {
        await client.checkConnection(5000);
        logScopedEndpointCapability("push");
      } catch (e) {
        logger.error(
          "Unable to reach ServiceNow instance before push. Check SN_INSTANCE/SN_USER/SN_PASSWORD and network connectivity."
        );
        return;
      }

      const { updateSet, ci: skipPrompt, target, diff } = args;
      let encodedPaths;
      if (target !== undefined && target !== "") encodedPaths = target;
      else encodedPaths = await gitDiffToEncodedPaths(diff);

      let fileList = await AppUtils.getAppFileList(encodedPaths);

      const existingCheckpoint = await loadPushCheckpoint();
      if (existingCheckpoint && existingCheckpoint.failed.length > 0) {
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
          fileList = fileList.filter((rec) => failedKeys.has(recToCheckpointKey(rec)));
          logger.info(`Resuming from checkpoint with ${fileList.length} records.`);
        } else {
          await clearPushCheckpoint();
        }
      }

      logger.info(`${fileList.length} files to push.`);

      if (dryRun) {
        logger.info("Dry run enabled: skipping push checkpoint writes and remote push operation.");
        return;
      }

      const lock = await acquireCollaborationLock("push", args.instanceProfile);
      if (!lock.acquired) {
        logger.warn(`Push aborted due to collaboration lock conflict. ${lock.reason || ""}`.trim());
        logger.warn(
          "If this lock is stale, delete sync.collaboration.lock.json or wait for the active push to complete."
        );
        return;
      }
      lockAcquired = true;

      const attempted = fileList.map(recToCheckpointKey);
      await writePushCheckpoint({ attempted, succeeded: [], failed: attempted });

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
          let answers: { confirmed: boolean } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmed",
              message: `A new Update Set "${updateSet}" will be created for these pushed changes. Do you want to proceed?`,
              default: false,
            },
          ]);
          if (!answers["confirmed"]) {
            process.exit(0);
          }
        }

        const newUpdateSet = await AppUtils.createAndAssignUpdateSet(updateSet);
        logger.debug(
          `New Update Set Created(${newUpdateSet.name}) sys_id:${newUpdateSet.id}`
        );
      }
      const pushResults = await AppUtils.pushFiles(fileList);

      const succeeded = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => item.res.success)
        .map((item) => item.key);

      const failed = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => !item.res.success)
        .map((item) => item.key);

      await writePushCheckpoint({ attempted, succeeded, failed });
      if (failed.length === 0) {
        await clearPushCheckpoint();
      }

      logPushResults(pushResults);
    } catch (e) {
      logger.getInternalLogger().error(e);
      process.exit(1);
    } finally {
      if (lockAcquired) {
        await releaseCollaborationLock();
      }
    }
  }, args.scopeSwap);
}
