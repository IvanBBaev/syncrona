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
  // Two distinct files resolving to the SAME record+field is ambiguous, and the
  // plain assignment silently kept whichever came last. That happens for real
  // when a workspace holds both layouts of one field (DX17 flat
  // `<record>~<field>.js` next to a leftover folder `<record>/<field>.js`), and
  // it happened wholesale to workspaces refreshed before the download side
  // learned that a field's local file is not tied to the manifest's `type` —
  // every TypeScript-backed field got a downloaded `.js` copy written beside the
  // `.ts` the workspace edits. Either way the loser's edits were dropped and the
  // winner depended on directory iteration order, so the same push could upload
  // different bytes on different machines. Fail loudly instead of guessing.
  //
  // Every conflict is collected before throwing, rather than throwing on the
  // first pair. A workspace that acquired these in bulk has one per affected
  // field, and a message naming only the first turns the cleanup into one failed
  // push per file. Distinct paths only: getAppFileList can legitimately hand the
  // same path twice (two globs, one file), which is not a conflict.
  const claimants = new Map<string, string[]>();
  const fieldOrder: string[] = [];
  for (const cur of fileCtxs) {
    const { tableName, targetField, sys_id } = cur;
    const key = `${tableName}-${sys_id}`;
    let entry = combinedFiles[key];
    if (!entry) {
      entry = { table: tableName, sysId: sys_id, fields: {} };
      combinedFiles[key] = entry;
    }
    const fieldKey = `${key}-${targetField}`;
    let paths = claimants.get(fieldKey);
    if (!paths) {
      paths = [];
      claimants.set(fieldKey, paths);
      // First-seen order, so the report reads in the order the caller supplied.
      fieldOrder.push(fieldKey);
    }
    if (!paths.includes(cur.filePath)) {
      paths.push(cur.filePath);
    }
    entry.fields[targetField] = cur;
  }

  const ambiguous = fieldOrder
    .map((fieldKey) => ({ fieldKey, paths: claimants.get(fieldKey) as string[] }))
    .filter(({ paths }) => paths.length > 1);
  if (ambiguous.length > 0) {
    // Re-derive the human parts from the contexts rather than by splitting the
    // key: a table name or field name containing "-" would split wrongly.
    const describe = ({ fieldKey, paths }: { fieldKey: string; paths: string[] }) => {
      const ctx = fileCtxs.find(
        (c) => `${c.tableName}-${c.sys_id}-${c.targetField}` === fieldKey
      ) as Sync.FileContext;
      return (
        `  "${ctx.tableName}" record ${ctx.sys_id} field "${ctx.targetField}":\n` +
        paths.map((p) => `    ${p}`).join("\n")
      );
    };
    throw new Error(
      `Ambiguous push: ${ambiguous.length} record field(s) are claimed by more than one local file.\n` +
        ambiguous.map(describe).join("\n") +
        "\nEach field can be pushed from exactly one file. Delete the stale copies — " +
        "they are the same field in two layouts, or a downloaded copy sitting next to " +
        "the source you actually edit — and retry."
    );
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
  const appFileCtxs: Sync.FileContext[] = [];
  const unresolved: string[] = [];
  for (const filePath of validPaths) {
    const ctx = fUtils.getFileContextFromPath(filePath);
    if (ctx) {
      appFileCtxs.push(ctx);
    } else {
      unresolved.push(filePath);
    }
  }
  if (unresolved.length > 0) {
    // A path the manifest cannot place is dropped — the alternative, failing the
    // whole push, would make one stray file block every good one. But it is said
    // out loud: "N files to push" over a list the user handed in themselves,
    // silently shortened, is indistinguishable from success and was how an
    // unmapped sidecar used to disappear.
    logger.warn(
      `${unresolved.length} file(s) are not in the manifest and will not be ` +
        `pushed:\n  ${unresolved.join("\n  ")}\n` +
        "Run `syncrona refresh` if these are real records; otherwise they are " +
        "leftovers from a scope or a layout this workspace no longer tracks."
    );
  }
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
  const config = ConfigManager.getConfig() as Sync.Config;

  // `meta: false` turns the whole layer off, so a sidecar reaching this point is
  // a leftover from before the opt-out. Treating it as `metaPush: false` is the
  // only reading that is not user-hostile: the manifest deliberately carries no
  // metaFields under that flag, so resolving the file would raise the
  // degraded-manifest error on a workspace whose configuration is exactly as its
  // owner intends. Still logged — a file that is not being pushed is worth a
  // line either way.
  if (config.meta === false || config.metaPush === false) {
    // Not silent: dropping an edit the user made and saying nothing is the exact
    // failure this feature exists to remove. The record still pushes its files.
    const flag = config.meta === false ? "meta" : "metaPush";
    logger.info(
      `${summarizeRecord(rec.table, rec.fields[META_FILE_NAME].name)} : ` +
        `metadata not pushed (\`${flag}: false\` in sync.config.js).`
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

// Where one field's artifact lands in the build tree. Extracted so the diff
// manifest `build --diff` records lists the exact paths the build wrote: deploy
// re-reads that list, and a second copy of this arithmetic would drift the
// moment either on-disk layout or getBuildExt changed — the build would write
// `<record>/.meta.json` while the manifest pointed at `<record>/.meta.js`, and
// deploy would report "0 files" for a record it had just built.
const buildFilePathFor = (fieldCtx: Sync.FileContext): string => {
  const relativePath = path.relative(
    ConfigManager.getSourcePath(),
    fieldCtx.filePath
  );
  const relExt = path.extname(relativePath);
  const relPathNoExt = relExt
    ? relativePath.slice(0, relativePath.length - relExt.length)
    : relativePath;
  const buildExt = fUtils.getBuildExt(
    fieldCtx.tableName,
    fieldCtx.name,
    fieldCtx.targetField
  );
  return path.join(
    ConfigManager.getBuildPath(),
    `${relPathNoExt}.${buildExt}`
  );
};

// Every build-tree path the given records own, in field order — what buildFiles
// wrote for them, and what a deploy driven by the diff manifest must read.
export const buildFilePaths = (recs: Sync.BuildableRecord[]): string[] =>
  recs.flatMap((rec) => Object.values(rec.fields).map(buildFilePathFor));

const writeBuildFile = async (
  preBuild: Sync.BuildableRecord,
  buildRes: Sync.RecBuildSuccess,
  summary?: string
): Promise<Sync.BuildResult> => {
  const { fields, table, sysId } = preBuild;
  const recSummary = summary ?? `${table} > ${sysId}`;
  const fieldNames = Object.keys(fields);
  const writePromises = fieldNames.map(async (field) => {
    const fieldCtx = fields[field];
    const buildFilePath = buildFilePathFor(fieldCtx);
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
