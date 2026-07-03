// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import path from "path";
import * as fUtils from "./FileUtils.js";
import * as ConfigManager from "./config.js";
import { PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./constants.js";
import PluginManager from "./PluginManager.js";
import {
  defaultClient,
  getErrorResponseStatus,
  isRetryableRequestError,
  processPushResponse,
  retryOnErr,
  SNClient,
} from "./snClient.js";
import { logger } from "./Logger.js";
import { aggregateErrorMessages, allSettled } from "./genericUtils.js";
import { getProgTick } from "./progress.js";

export const groupAppFiles = (fileCtxs: Sync.FileContext[]) => {
  // #47: mutate the accumulator instead of spreading it on every iteration.
  // The previous `{ ...groupMap, [key]: ... }` reduce copied the whole map per
  // file (O(n²) in file count). `cur` is always a defined FileContext here, so
  // the old `cur ?? ""` fallback was dead code (and the wrong type).
  const combinedFiles: Record<string, Sync.BuildableRecord> = {};
  for (const cur of fileCtxs) {
    const { tableName, targetField, sys_id } = cur;
    const key = `${tableName}-${sys_id}`;
    let entry = combinedFiles[key];
    if (!entry) {
      entry = { table: tableName, sysId: sys_id, fields: {} };
      combinedFiles[key] = entry;
    }
    entry.fields[targetField] = cur;
  }
  return Object.values(combinedFiles);
};

export const getAppFileList = async (
  paths: string | string[]
): Promise<Sync.BuildableRecord[]> => {
  const validPaths =
    typeof paths === "object"
      ? paths
      : await fUtils.encodedPathsToFilePaths(paths);
  const appFileCtxs = validPaths
    .map(fUtils.getFileContextFromPath)
    .filter((maybeCtx): maybeCtx is Sync.FileContext => !!maybeCtx);
  return groupAppFiles(appFileCtxs);
};

const buildRec = async (
  rec: Sync.BuildableRecord
): Promise<Sync.RecBuildRes> => {
  const fields = Object.keys(rec.fields);
  const buildPromises = fields.map((field) => {
    return PluginManager.getFinalFileContents(rec.fields[field]);
  });
  const builtFiles = await allSettled(buildPromises);
  const buildSuccess = !builtFiles.find(
    (buildRes) => buildRes.status === "rejected"
  );
  if (!buildSuccess) {
    const buildErrors = builtFiles
      .filter((b): b is Sync.FailPromiseResult => b.status === "rejected")
      .map((b) => (b.reason instanceof Error ? b.reason : new Error(String(b.reason))));

    return {
      success: false,
      message: aggregateErrorMessages(
        buildErrors,
        "Failed to build!",
        (_, index) => `${index}`
      ),
    };
  }
  const builtRec = builtFiles.reduce((acc, buildRes, index) => {
    const { value: content } = buildRes as Sync.SuccessPromiseResult<string>;
    const fieldName = fields[index];
    return { ...acc, [fieldName]: content };
  }, {} as Record<string, string>);
  return {
    success: true,
    builtRec,
  };
};

const pushRec = async (
  client: SNClient,
  table: string,
  sysId: string,
  builtRec: Record<string, string>,
  summary?: string
) => {
  const recSummary = summary ?? `${table} > ${sysId}`;
  try {
    const pushRes = await retryOnErr(
      () => client.updateRecord(table, sysId, builtRec),
      PUSH_RETRY_LIMIT,
      PUSH_RETRY_WAIT,
      (numTries: number) => {
        logger.debug(
          `Failed to push ${recSummary}! Retrying with ${numTries} left...`
        );
      },
      isRetryableRequestError
    );
    return processPushResponse(pushRes, recSummary);
  } catch (e) {
    if (getErrorResponseStatus(e) === 404) {
      return {
        success: false,
        message: `Could not find ${recSummary} on the server.`,
      };
    }
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    const errMsg = message || "Too many retries";
    return { success: false, message: `${recSummary} : ${errMsg}` };
  }
};

// CLI --push-concurrency wins over sync.config.js pushConcurrency, which wins
// over the default of 10; the result is always clamped to 1–50.
export const resolvePushConcurrency = (override?: number): number => {
  const candidate =
    typeof override === "number" && Number.isFinite(override)
      ? override
      : (ConfigManager.getConfig() as Sync.Config).pushConcurrency;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(candidate), 1), 50);
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
};

export const pushFiles = async (
  recs: Sync.BuildableRecord[],
  concurrencyOverride?: number
): Promise<Sync.PushResult[]> => {
  const client = defaultClient();
  const pushConcurrency = resolvePushConcurrency(concurrencyOverride);
  const tick = getProgTick(logger.getLogLevel(), recs.length * 2) || (() => {});
  return mapWithConcurrency(recs, pushConcurrency, async (rec) => {
    const fieldNames = Object.keys(rec.fields);
    const recSummary = summarizeRecord(
      rec.table,
      rec.fields[fieldNames[0]].name
    );
    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    const pushRes = await pushRec(
      client,
      rec.table,
      rec.sysId,
      buildRes.builtRec,
      recSummary
    );
    tick();
    return pushRes;
  });
};

export const summarizeRecord = (table: string, recDescriptor: string): string =>
  `${table} > ${recDescriptor}`;

const writeBuildFile = async (
  preBuild: Sync.BuildableRecord,
  buildRes: Sync.RecBuildSuccess,
  summary?: string
): Promise<Sync.BuildResult> => {
  const { fields, table, sysId } = preBuild;
  const recSummary = summary ?? `${table} > ${sysId}`;
  const sourcePath = ConfigManager.getSourcePath();
  const buildPath = ConfigManager.getBuildPath();
  const fieldNames = Object.keys(fields);
  const writePromises = fieldNames.map(async (field) => {
    const fieldCtx = fields[field];
    const srcFilePath = fieldCtx.filePath;
    const relativePath = path.relative(sourcePath, srcFilePath);
    const relExt = path.extname(relativePath);
    const relPathNoExt = relExt
      ? relativePath.slice(0, relativePath.length - relExt.length)
      : relativePath;
    const buildExt = fUtils.getBuildExt(
      fieldCtx.tableName,
      fieldCtx.name,
      fieldCtx.targetField
    );
    const relPathNewExt = `${relPathNoExt}.${buildExt}`;
    const buildFilePath = path.join(buildPath, relPathNewExt);
    await fUtils.createDirRecursively(path.dirname(buildFilePath));
    const writeResult = await fUtils.writeFileForce(
      buildFilePath,
      buildRes.builtRec[fieldCtx.targetField]
    );
    return writeResult;
  });
  try {
    await Promise.all(writePromises);
    return { success: true, message: `${recSummary} built successfully` };
  } catch (e) {
    return {
      success: false,
      message: `${recSummary} : ${e}`,
    };
  }
};

export const buildFiles = async (
  fileList: Sync.BuildableRecord[]
): Promise<Sync.BuildResult[]> => {
  const tick =
    getProgTick(logger.getLogLevel(), fileList.length * 2) || (() => {});
  const buildPromises = fileList.map(async (rec) => {
    const { fields, table } = rec;
    const fieldNames = Object.keys(fields);
    const recSummary = summarizeRecord(table, fields[fieldNames[0]].name);
    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    // writeFile
    const writeRes = await writeBuildFile(rec, buildRes, recSummary);
    tick();
    return writeRes;
  });
  return Promise.all(buildPromises);
};
