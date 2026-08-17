// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import path from "path";
import * as fUtils from "./FileUtils.js";
import * as ConfigManager from "./config.js";
import { PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./constants.js";
import PluginManager from "./PluginManager.js";
import {
  META_FILE_NAME,
  isMetaFieldName,
  resolveMetaUpdate,
} from "./metaFields.js";
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
    // Two distinct files resolving to the SAME record+field is ambiguous, and
    // the plain assignment silently kept whichever came last. That happens for
    // real when a workspace holds both layouts of one field (DX17 flat
    // `<record>~<field>.js` next to a leftover folder `<record>/<field>.js`):
    // the loser's edits were dropped and the winner depended on directory
    // iteration order, so the same push could upload different bytes on
    // different machines. Fail loudly instead of guessing.
    const existing = entry.fields[targetField];
    if (existing && existing.filePath !== cur.filePath) {
      throw new Error(
        `Ambiguous push: "${tableName}" record ${sys_id} field "${targetField}" is claimed by two local files:\n  ${existing.filePath}\n  ${cur.filePath}\nDelete the stale copy (they are the same field in different layouts) and retry.`
      );
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
    // The sidecar is read RAW. It is data, not source: a plugin rule matching
    // "*.json" (a formatter, a bundler, a template step) would rewrite the very
    // bytes resolveMetaUpdate has to parse, and any rule that emits something
    // other than an object of column values turns a metadata edit into a push
    // failure with no obvious cause. Field files keep the full plugin chain.
    return PluginManager.getFinalFileContents(
      rec.fields[field],
      !isMetaFieldName(field)
    );
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

/** A record's update body once its `.meta` pseudo-field has been expanded. */
interface MetaExpansion {
  /** Column → value, ready for the Table API. Never contains ".meta". */
  fields: Record<string, string>;
  /** Sidecar columns deliberately not sent (read-only, or `metaPush: false`). */
  skipped: string[];
}

/**
 * Turn the `.meta` pseudo-field into the real columns it stands for.
 *
 * Deliberately at PUSH time and not at build time. `build` writes whatever
 * buildRec produced into the build tree, so leaving the sidecar intact there
 * means the build tree holds a `.meta.json` that looks exactly like the source
 * one — and `deploy`, which re-reads that tree through the same path resolver,
 * expands it here by the same rules. Expanding during build would instead leave
 * the build tree holding files named after columns, which is neither layout.
 *
 * Field files win over sidecar columns on a name collision. Discovery already
 * removes file fields from `metaFields`, so this only bites when an explicit
 * `tableOptions.<table>.metaFields` re-adds one; the file is the value the user
 * edits, so it is the value that goes.
 */
export const expandMetaSidecar = (
  rec: Sync.BuildableRecord,
  builtRec: Record<string, string>
): MetaExpansion => {
  if (!(META_FILE_NAME in builtRec)) {
    return { fields: builtRec, skipped: [] };
  }
  const { [META_FILE_NAME]: content, ...fileFields } = builtRec;

  if ((ConfigManager.getConfig() as Sync.Config).metaPush === false) {
    // Not silent: dropping an edit the user made and saying nothing is the exact
    // failure this feature exists to remove. The record still pushes its files.
    logger.info(
      `${summarizeRecord(rec.table, rec.fields[META_FILE_NAME].name)} : ` +
        "metadata not pushed (`metaPush: false` in sync.config.js)."
    );
    return { fields: fileFields, skipped: [] };
  }

  const table = ConfigManager.getManifest()?.tables[rec.table];
  const update = resolveMetaUpdate(content, {
    metaFields: table?.metaFields,
    readOnlyFields: table?.metaReadOnlyFields,
  });
  return {
    fields: { ...update.fields, ...fileFields },
    skipped: update.skipped,
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
  // Abort on the first failure. Previously a rejecting worker only rejected the
  // Promise.all, while every other runner kept pulling items off the queue: the
  // caller had already unwound (releasing the collaboration lock, exiting)
  // while those workers were still pushing records to the instance, and all but
  // the first error were discarded. Collect the errors, stop scheduling new
  // work, and rethrow.
  const errors: unknown[] = [];

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length && errors.length === 0) {
      const current = nextIndex;
      nextIndex += 1;
      try {
        results[current] = await worker(items[current], current);
      } catch (e) {
        errors.push(e);
      }
    }
  });

  await Promise.all(runners);
  if (errors.length > 0) {
    // Rethrow a lone error unchanged so callers can still classify it
    // (retry predicates, status codes).
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${errors.length} concurrent operations failed.`);
  }
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
    let expanded: MetaExpansion;
    try {
      expanded = expandMetaSidecar(rec, buildRes.builtRec);
    } catch (e) {
      // An unusable sidecar is a per-record failure like any build failure: the
      // other records in the push still go, and the message names the columns.
      tick();
      return {
        success: false,
        message: `${recSummary} : ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (expanded.skipped.length > 0) {
      logger.info(
        `${recSummary} : skipping read-only metadata column(s) ` +
          `${expanded.skipped.join(", ")} — the instance would discard them.`
      );
    }
    if (Object.keys(expanded.fields).length === 0) {
      // Only reachable for a sidecar-only record whose every column was skipped.
      // PATCHing `{}` would answer 200 and report a push that changed nothing.
      tick();
      return { success: true, message: `${recSummary} : nothing to push.` };
    }
    const pushRes = await pushRec(
      client,
      rec.table,
      rec.sysId,
      expanded.fields,
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
  // REV-99 (PERF-6): route the build fan-out through the bounded
  // mapWithConcurrency helper (exactly like pushFiles) instead of an unbounded
  // Promise.all. Building every record at once opened one plugin build +
  // file-write chain per record simultaneously, so a large scope could exhaust
  // file descriptors and thrash the event loop. Cap the in-flight fan-out at
  // the same resolved push-concurrency limit; results stay in fileList order.
  return mapWithConcurrency(fileList, resolvePushConcurrency(), async (rec) => {
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
};
