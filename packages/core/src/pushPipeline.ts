// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import {
  classifyCreateTable,
  describeDeniedCreateTable,
  describeUnlistedCreateTable,
  escapeQueryValue,
  isDeniedCreateTable,
} from "@syncrona/sn-transport";
import { promises as fsp } from "fs";
import path from "path";
import * as fUtils from "./FileUtils.js";
import * as ConfigManager from "./config.js";
import { PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./constants.js";
import { excludes as defaultExcludedTables } from "./defaultOptions.js";
import { findMissingFiles } from "./downloadPipeline.js";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import PluginManager from "./PluginManager.js";
import { getDisplayField } from "./fieldMap.js";
import {
  META_FILE_NAME,
  META_FILE_TYPE,
  META_SIDECAR_FILE_NAME,
  isMetaFieldName,
  metaValueText,
  resolveMetaUpdate,
  stripBOM,
} from "./metaFields.js";
import {
  applyDataModelTableOptions,
  getDataModelTables,
  isDataModelTable,
  isPruneDeniedTable,
  nameFieldColumn,
} from "./dataModel.js";
import {
  defaultClient,
  getErrorResponseStatus,
  isRetryableRequestError,
  processPushResponse,
  retryOnErr,
  SNClient,
  unwrapSNResponse,
  unwrapTableAPIFirstItem,
} from "./snClient.js";
import { logger } from "./Logger.js";
import { aggregateErrorMessages, allSettled, wait } from "./genericUtils.js";
import { getProgTick } from "./progress.js";
import {
  COMPOSITE_TABLES,
  LAYOUT_CONFLICT_HINT,
  compositeTier,
  getCompositeTables,
  getDataModelLayout,
  isCompositeDocumentPath,
  pathExistsPlain,
  perRecordSidecarPath,
  readCompositeDocument,
  serializeCompositeEntry,
  strayCompositeSidecarMessage,
  strayCompositeSidecarTable,
} from "./dataModelComposite.js";

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

/** One local file of a record `push --create` would create or adopt. */
export interface CreateCandidateFile {
  filePath: string;
  field: string;
  ext: string;
  isSidecar: boolean;
  /**
   * SDK-F2: the sidecar text of an entry expanded from a data-model document.
   * `filePath` then names the per-record sidecar the entry stands for, which
   * does not exist on disk.
   */
  contents?: string;
}

/** A record the manifest does not know, with every local file naming it. */
export interface CreateCandidate {
  table: string;
  recordName: string;
  files: CreateCandidateFile[];
  /** Set when two local files claim the same field; the record is not created. */
  conflict?: string;
}

export interface AppFileListWithCandidates {
  records: Sync.BuildableRecord[];
  candidates: CreateCandidate[];
}

/**
 * getAppFileList, plus — with `create` — the unmapped paths that name a record
 * the manifest does not have yet (R1, `push --create`), grouped per record.
 * Without `create` the candidates list is always empty and the behaviour is
 * exactly getAppFileList's.
 */
export const getAppFileListWithCandidates = async (
  paths: string | string[],
  options: { create: boolean }
): Promise<AppFileListWithCandidates> => {
  const validPaths =
    typeof paths === "object"
      ? paths
      : await fUtils.encodedPathsToFilePaths(paths);
  const appFileCtxs: Sync.FileContext[] = [];
  const unresolved: string[] = [];
  const candidates = new Map<string, CreateCandidate>();
  const items = await expandCompositeDocuments(validPaths);
  const misresolved: string[] = [];
  for (const { filePath, contents, label, entry } of items) {
    const ctx = fUtils.getFileContextFromPath(filePath);
    if (ctx) {
      if (entry && (ctx.tableName !== entry.table || ctx.name !== entry.recordName)) {
        misresolved.push(`${label ?? filePath} resolves to ${ctx.tableName} "${ctx.name}"`);
        continue;
      }
      if (contents !== undefined) ctx.fileContents = contents;
      appFileCtxs.push(ctx);
      continue;
    }
    const unmapped = options.create ? fUtils.parseUnmappedPath(filePath) : undefined;
    if (!unmapped) {
      unresolved.push(label ?? filePath);
      continue;
    }
    if (entry && (unmapped.table !== entry.table || unmapped.recordName !== entry.recordName)) {
      misresolved.push(
        `${label ?? filePath} resolves to ${unmapped.table} "${unmapped.recordName}"`
      );
      continue;
    }
    const key = `${unmapped.table}:${unmapped.recordName}`;
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = { table: unmapped.table, recordName: unmapped.recordName, files: [] };
      candidates.set(key, candidate);
    }
    const clash = candidate.files.find(
      (file) => file.field === unmapped.field && file.filePath !== filePath
    );
    if (clash) {
      // The same rule groupAppFiles applies to known records: a field comes from
      // exactly one file, and guessing which would make the created record
      // depend on directory iteration order.
      candidate.conflict =
        `field "${unmapped.field}" is claimed by more than one local file ` +
        `(${clash.filePath}, ${filePath}). Delete the stale copy and retry.`;
      continue;
    }
    if (!candidate.files.some((file) => file.filePath === filePath)) {
      candidate.files.push({
        filePath,
        field: unmapped.field,
        ext: unmapped.ext,
        isSidecar: unmapped.isSidecar,
        ...(contents !== undefined ? { contents } : {}),
      });
    }
  }
  if (misresolved.length > 0) {
    // Defence in depth behind parseCompositeDocument's key check: a document
    // entry is pushed only to the record it names. Any other answer means its
    // virtual path escaped its own table, and pushing it would write a record
    // the document's section never covered.
    throw new Error(
      `Refusing to push data-model document entries that do not resolve to their own ` +
        `record:\n  ${misresolved.join("\n  ")}`
    );
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
        "leftovers from a scope or a layout this workspace no longer tracks." +
        (options.create
          ? " `push --create` only creates records from <table>/<record>/<field>.<ext> " +
            "or <table>/<record>~<field>.<ext> paths under the source directory."
          : "")
    );
  }
  return {
    records: groupAppFiles(appFileCtxs),
    candidates: orderCreateCandidates([...candidates.values()]),
  };
};

/**
 * SDK-F2: under the composite layout a table is created before its columns,
 * and a column before its choices — a dictionary row naming a table the
 * instance does not have yet is refused. Stable, so every other record keeps
 * the order the paths were listed in.
 */
const orderCreateCandidates = (candidates: CreateCandidate[]): CreateCandidate[] => {
  let layout: string;
  try {
    layout = getDataModelLayout(ConfigManager.getConfig());
  } catch (_e) {
    return candidates;
  }
  if (layout !== "composite") return candidates;
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        compositeTier(a.candidate.table) - compositeTier(b.candidate.table) || a.index - b.index
    )
    .map(({ candidate }) => candidate);
};

/** One path to push: a file on disk, or an entry of a data-model document. */
interface PushPathItem {
  filePath: string;
  /** In-memory sidecar text; set only for a document entry. */
  contents?: string;
  /** How an unresolved document entry is named in the warning. */
  label?: string;
  /** The section and key a document entry came from; set only for an entry. */
  entry?: { table: string; recordName: string };
}

/**
 * SDK-F2: replace every data-model document among `paths` by one virtual
 * per-record sidecar per entry, so the rest of the push — resolution, the
 * diff-only metadata update, create-or-adopt — sees exactly what the
 * `records` layout would have handed it. Every other path passes through.
 *
 * Refused, before anything is pushed:
 * - a document under the `records` layout (it would silently not be pushed);
 * - a document section for a table the composite layout does not cover;
 * - a record held both by a document and by a per-record sidecar on disk;
 * - a per-record sidecar of a composite table under the `composite` layout.
 */
const expandCompositeDocuments = async (paths: string[]): Promise<PushPathItem[]> => {
  let sourcePath: string;
  let config: Sync.Config;
  try {
    sourcePath = ConfigManager.getSourcePath();
    config = ConfigManager.getConfig();
  } catch (_e) {
    return paths.map((filePath) => ({ filePath }));
  }
  const layout = getDataModelLayout(config);
  const compositeTables = getCompositeTables(config);
  const flat = config.flat === true;
  const items: PushPathItem[] = [];
  const errors: string[] = [];
  for (const filePath of paths) {
    if (!isCompositeDocumentPath(filePath, sourcePath)) {
      const strayTable = strayCompositeSidecarTable(filePath, sourcePath, config);
      if (strayTable !== undefined) {
        errors.push(strayCompositeSidecarMessage(filePath, strayTable));
        continue;
      }
      items.push({ filePath });
      continue;
    }
    if (layout !== "composite") {
      errors.push(
        `${filePath} is a data-model document, but dataModelLayout is "records": ` +
          "it would not be pushed."
      );
      continue;
    }
    const doc = await readCompositeDocument(filePath);
    for (const table of COMPOSITE_TABLES) {
      const section = Object.prototype.hasOwnProperty.call(doc.sections, table)
        ? doc.sections[table]
        : undefined;
      if (!section) continue;
      if (!compositeTables.includes(table)) {
        errors.push(
          `${filePath} holds a ${table} section, but ${table} is not in dataModelTables.`
        );
        continue;
      }
      for (const recordName of Object.keys(section)) {
        const virtual = perRecordSidecarPath(sourcePath, table, recordName, flat);
        if (await pathExistsPlain(virtual)) {
          errors.push(`${table} "${recordName}" is in both ${filePath} and ${virtual}.`);
          continue;
        }
        items.push({
          filePath: virtual,
          contents: serializeCompositeEntry(section[recordName]),
          label: `${filePath}#${table}/${recordName}`,
          entry: { table, recordName },
        });
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Ambiguous data-model layout:\n  ${errors.join("\n  ")}\n${LAYOUT_CONFLICT_HINT}`
    );
  }
  return items;
};

export const getAppFileList = async (
  paths: string | string[]
): Promise<Sync.BuildableRecord[]> =>
  (await getAppFileListWithCandidates(paths, { create: false })).records;

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
  builtRec: Record<string, string>,
  // R4: the columns of a table the manifest does not know yet, discovered by
  // `push --create` for a sidecar-only data-model record. Used only when the
  // manifest has no metaFields of its own for the table.
  discovered?: { metaFields: readonly string[]; readOnlyFields: readonly string[] }
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
  const useDiscovered = discovered !== undefined && !(table?.metaFields?.length);
  const update = resolveMetaUpdate(content, {
    metaFields: useDiscovered ? discovered.metaFields : table?.metaFields,
    readOnlyFields: useDiscovered ? discovered.readOnlyFields : table?.metaReadOnlyFields,
  });
  return {
    fields: { ...update.fields, ...fileFields },
    skipped: update.skipped,
  };
};

/**
 * R4: drop the sidecar columns of a data-model record whose value already
 * matches the CURRENT instance value, so the update carries only the columns
 * that differ.
 *
 * A data-model sidecar holds every column of the record, and an ordinary
 * sidecar push sends them all. For a dictionary entry that is not harmless:
 * re-sending an unchanged `internal_type`, `reference` or `max_length` runs the
 * dictionary business rules again (and can alter the physical table). One GET
 * of the columns the push would send drops the ones that already match.
 *
 * This is a two-way compare (local sidecar vs current row), not a three-way
 * merge: no pulled baseline is kept. A column someone changed on the instance
 * since the last pull still differs from the local sidecar, so it IS sent and
 * overwrites that change. DATA_MODEL.md "Editing and pushing" says so.
 *
 * Field files are always sent as they are. Throws when the record cannot be
 * read: sending every column blind is the behaviour this exists to avoid.
 */
const withoutUnchangedMetaColumns = async (
  client: SNClient,
  rec: Sync.BuildableRecord,
  fields: Record<string, string>
): Promise<{ fields: Record<string, string>; unchanged: string[] }> => {
  const metaColumns = Object.keys(fields).filter(
    (column) => !Object.prototype.hasOwnProperty.call(rec.fields, column)
  );
  if (metaColumns.length === 0) return { fields, unchanged: [] };
  const rows = await unwrapSNResponse<Record<string, unknown>[]>(
    client.tableAPIGet(
      rec.table,
      `sys_id=${escapeQueryValue(rec.sysId)}`,
      metaColumns.join(","),
      1
    )
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row !== "object") {
    throw new Error(
      "could not read the record from the instance to compare its metadata " +
        "columns; nothing was sent. Check that the record still exists and is readable."
    );
  }
  const changed: Record<string, string> = Object.create(null);
  const unchanged: string[] = [];
  for (const [column, value] of Object.entries(fields)) {
    const isMeta = metaColumns.includes(column);
    // A column the response omitted (a column-level read ACL) is sent: there is
    // no current value to prove the edit redundant.
    if (isMeta && column in row && metaValueText(row[column]) === value) {
      unchanged.push(column);
    } else {
      changed[column] = value;
    }
  }
  return { fields: changed, unchanged };
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
  const pushOne = async (rec: Sync.BuildableRecord): Promise<Sync.PushResult> => {
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
    if (
      META_FILE_NAME in rec.fields &&
      getDataModelTables(ConfigManager.getConfig() as Sync.Config).includes(rec.table)
    ) {
      try {
        const diff = await withoutUnchangedMetaColumns(client, rec, expanded.fields);
        if (diff.unchanged.length > 0) {
          logger.debug(
            `${recSummary} : ${diff.unchanged.length} metadata column(s) already match ` +
              "the instance and are not sent."
          );
        }
        expanded = { ...expanded, fields: diff.fields };
      } catch (e) {
        tick();
        return {
          success: false,
          message: `${recSummary} : ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    if (Object.keys(expanded.fields).length === 0) {
      // A sidecar-only record whose every column was skipped, or (R4) whose
      // every column already matches the instance. PATCHing `{}` would answer
      // 200 and report a push that changed nothing.
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
  };
  return mapInCompositeTiers(recs, pushConcurrency, pushOne);
};

/**
 * SDK-F2: under the composite layout, push every table definition before any
 * column and every column before any choice — a choice set on a column the
 * instance has not saved yet is rejected, and the order must not depend on
 * which request answers first. Each tier keeps the full concurrency. Results
 * come back in input order, as callers match them to `recs` by position.
 * Under the `records` layout this is exactly one mapWithConcurrency.
 */
const mapInCompositeTiers = async <R>(
  recs: Sync.BuildableRecord[],
  concurrency: number,
  worker: (rec: Sync.BuildableRecord) => Promise<R>
): Promise<R[]> => {
  let layout: string;
  try {
    layout = getDataModelLayout(ConfigManager.getConfig());
  } catch (_e) {
    layout = "records";
  }
  if (layout !== "composite") return mapWithConcurrency(recs, concurrency, (rec) => worker(rec));
  const tiers = new Map<number, number[]>();
  recs.forEach((rec, index) => {
    const tier = compositeTier(rec.table);
    const list = tiers.get(tier);
    if (list) list.push(index);
    else tiers.set(tier, [index]);
  });
  const results: R[] = new Array(recs.length);
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    const indexes = tiers.get(tier) as number[];
    const tierResults = await mapWithConcurrency(
      indexes.map((index) => recs[index]),
      concurrency,
      (rec) => worker(rec)
    );
    indexes.forEach((index, position) => {
      results[index] = tierResults[position];
    });
  }
  return results;
};

// ---------------------------------------------------------------------------
// R1 — `push --create`: create (or adopt) records for files not in the manifest
// ---------------------------------------------------------------------------

const CREATE_CONSUMER = "push --create";
const SYS_METADATA_TABLE = "sys_metadata";
// The deepest real hierarchies under sys_metadata are well under ten levels; the
// bound only stops a cyclic or corrupt sys_db_object chain from looping.
const MAX_CREATE_HIERARCHY_DEPTH = 16;

/**
 * The natural key of a table outside the sys_metadata hierarchy, where records
 * carry no sys_scope column. The instance ignores a query term or a body column
 * it does not know, so `sys_scope=<id>` neither narrows the idempotency lookup
 * nor gets stored: the lookup would match records across the whole instance.
 * These columns identify the record instead. A column the sidecar leaves empty
 * takes the value the instance itself defaults it to; an empty default is
 * matched with ISEMPTY, so an absent and an empty `dependent_value` are the
 * same key (a choice list that depends on another field repeats a `value` once
 * per dependent value, and without the column the lookup would adopt the wrong one).
 */
const UNSCOPED_NATURAL_KEYS: Readonly<
  Record<string, { columns: readonly string[]; defaults: Readonly<Record<string, string>> }>
> = Object.freeze({
  sys_choice: {
    columns: ["name", "element", "value", "language", "dependent_value"],
    defaults: { language: "en", dependent_value: "" },
  },
});
// manifestBuilder writes a "/" in a display value as this look-alike, because
// the name becomes a path component. Creating from that path reverses it.
const PATH_SEPARATOR_STAND_IN = "〳";

const MANIFEST_FILE_TYPES: readonly SN.FileType[] = [
  "js",
  "css",
  "xml",
  "html",
  "scss",
  "txt",
  "json",
];

/**
 * The manifest `type` for a field first seen as a local file. A known extension
 * is its own type; the TypeScript and module flavours of JavaScript build to
 * `js` (getBuildExt compiles a local file to the manifest type on the way out);
 * anything else is stored as text until a `refresh` reads the dictionary.
 */
export const manifestTypeForExt = (ext: string, isSidecar = false): SN.FileType => {
  if (isSidecar) return META_FILE_TYPE;
  const bare = ext.replace(/^\./, "").toLowerCase();
  if ((MANIFEST_FILE_TYPES as readonly string[]).includes(bare)) {
    return bare as SN.FileType;
  }
  if (["ts", "tsx", "jsx", "mjs", "cjs", "mts", "cts"].includes(bare)) {
    return "js";
  }
  return "txt";
};

export type CreatePolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * True when `table` extends sys_metadata, walked through sys_db_object one
 * `super_class` at a time. Every table visited is cached with the answer, so a
 * push creating many records in sibling tables walks each chain once.
 *
 * A table the instance answers no sys_db_object row for is added to `missing`
 * when the caller passes one: "not a sys_metadata descendant" and "no such
 * table" are both a false here, and only the caller can tell them apart. Keep
 * one `missing` set alongside one `cache`, since a cached answer skips the read.
 * A reply without a result list throws: it is neither answer.
 */
export const extendsSysMetadata = async (
  client: SNClient,
  table: string,
  cache: Map<string, boolean> = new Map(),
  missing?: Set<string>
): Promise<boolean> => {
  // sys_metadata itself is not a "descendant": raw sys_metadata rows are not
  // application files any tool round-trips.
  if (table === SYS_METADATA_TABLE) return false;
  const visited: string[] = [];
  let current = table;
  let result = false;
  for (let depth = 0; depth < MAX_CREATE_HIERARCHY_DEPTH; depth += 1) {
    if (depth > 0 && current === SYS_METADATA_TABLE) {
      result = true;
      break;
    }
    const cached = cache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    if (visited.includes(current)) break;
    visited.push(current);
    const rows = await unwrapSNResponse<Record<string, unknown>[]>(
      client.tableAPIGet(
        "sys_db_object",
        `name=${escapeQueryValue(current)}`,
        "name,super_class.name",
        1
      )
    );
    // A reply with no result list says nothing about the table. Reading it as
    // "not a sys_metadata descendant" planned an allowlisted table as a create
    // on no evidence; it fails closed like an unreadable reply instead.
    if (!Array.isArray(rows)) {
      throw new Error(
        `sys_db_object answered without a result list for table "${current}", so its hierarchy ` +
          "cannot be checked; refusing to plan a create in it."
      );
    }
    if (rows.length === 0) missing?.add(current);
    const parent = rows[0]?.["super_class.name"];
    if (typeof parent !== "string" || parent === "") break;
    current = parent;
  }
  for (const name of visited) cache.set(name, result);
  return result;
};

/**
 * AD-4 for the CLI. The shared deny list wins over everything and costs no
 * request; a table named in SYNCRONA_CREATE_TABLE_ALLOWLIST or in
 * `createTables` is allowed; every other table must extend sys_metadata.
 */
export const checkCreateTablePolicy = async (
  client: SNClient,
  table: string,
  cache: Map<string, boolean> = new Map(),
  missing?: Set<string>
): Promise<CreatePolicyResult> => {
  const config = ConfigManager.getConfig() as Sync.Config;
  const extraAllowed = Array.isArray(config.createTables) ? config.createTables : [];
  const classification = classifyCreateTable(table, {
    env: process.env,
    extraAllowed,
  });
  if (classification === "denied") {
    return {
      allowed: false,
      reason: describeDeniedCreateTable(table, { consumer: CREATE_CONSUMER }),
    };
  }
  if (classification === "allowlisted") return { allowed: true };
  if (await extendsSysMetadata(client, table, cache, missing)) return { allowed: true };
  return {
    allowed: false,
    reason: describeUnlistedCreateTable(
      table,
      "only tables that extend sys_metadata (application files) are allowed",
      {
        consumer: CREATE_CONSUMER,
        extraRemedy: "Or list the table under createTables in sync.config.js.",
      }
    ),
  };
};

const readManifest = (): SN.AppManifest => {
  const manifest = ConfigManager.getManifest();
  if (!manifest) throw new Error("No manifest has been loaded!");
  return manifest;
};

const saveManifest = async (manifest: SN.AppManifest): Promise<void> => {
  ConfigManager.updateManifest(manifest);
  await fUtils.writeManifestFile(manifest);
};

/**
 * AD-10: the application's sys_id, from the manifest when it is recorded there
 * and from sys_scope otherwise. `persist` writes a looked-up value back so later
 * pushes skip the request; a dry run passes false and leaves the manifest alone.
 */
export const resolveScopeId = async (
  client: SNClient,
  persist: boolean
): Promise<string> => {
  const manifest = readManifest();
  if (manifest.scopeId) return manifest.scopeId;
  const scopeId = await unwrapTableAPIFirstItem<SN.ScopeRecord>(
    client.getScopeId(manifest.scope),
    "sys_id"
  );
  if (typeof scopeId !== "string" || scopeId === "") {
    throw new Error(`Could not resolve the sys_id of scope "${manifest.scope}".`);
  }
  if (persist) {
    await saveManifest({ ...readManifest(), scopeId });
  }
  return scopeId;
};

const candidateKey = (candidate: { table: string; recordName: string }): string =>
  `${candidate.table}:${candidate.recordName}`;

const candidateManifestFiles = (candidate: CreateCandidate): SN.File[] =>
  candidate.files.map((file) => ({
    name: file.field,
    type: manifestTypeForExt(file.ext, file.isSidecar),
  }));

const addRecordToManifest = async (
  candidate: CreateCandidate,
  sysId: string,
  discovered?: DiscoveredMeta
): Promise<void> => {
  const manifest = readManifest();
  const existingTable = Object.prototype.hasOwnProperty.call(manifest.tables, candidate.table)
    ? manifest.tables[candidate.table]
    : undefined;
  // R4: a table first seen through a created sidecar-only record keeps the
  // columns discovered for it, so the next push of that sidecar resolves
  // without waiting for a refresh. A table that already has its own list keeps it.
  const metaColumns: Partial<SN.TableConfig> =
    discovered && !(existingTable?.metaFields?.length)
      ? discovered.readOnlyFields.length > 0
        ? {
            metaFields: [...discovered.metaFields],
            metaReadOnlyFields: [...discovered.readOnlyFields],
          }
        : { metaFields: [...discovered.metaFields] }
      : {};
  const tableConfig: SN.TableConfig = {
    ...(existingTable ?? {}),
    ...metaColumns,
    records: {
      ...(existingTable?.records ?? {}),
      [candidate.recordName]: {
        name: candidate.recordName,
        sys_id: sysId,
        files: candidateManifestFiles(candidate),
      },
    },
  };
  await saveManifest({
    ...manifest,
    tables: { ...manifest.tables, [candidate.table]: tableConfig },
  });
};

/** Every sys_id the manifest tracks, with the record that owns it. */
const manifestOwners = (): Map<
  string,
  { table: string; recordKey: string; recordName: string }
> => {
  const owners = new Map<string, { table: string; recordKey: string; recordName: string }>();
  for (const [table, tableConfig] of Object.entries(readManifest().tables ?? {})) {
    for (const [recordKey, record] of Object.entries(tableConfig?.records ?? {})) {
      if (typeof record?.sys_id !== "string" || record.sys_id === "") continue;
      owners.set(record.sys_id, { table, recordKey, recordName: record.name || recordKey });
    }
  }
  return owners;
};

export type CreateAction = "create" | "adopt";

/** Sidecar columns discovered at create time for a table the manifest lacks. */
export interface DiscoveredMeta {
  metaFields: string[];
  readOnlyFields: string[];
}

export interface PlannedCreation {
  candidate: CreateCandidate;
  action: CreateAction | "error";
  /** The column holding the record name (the manifest's display field). */
  nameField: string;
  /** The value written to `nameField`: the record name as the instance shows it. */
  nameValue: string;
  /**
   * Set for `adopt`: the existing record's sys_id. Also set on the `error` of
   * an adoption refused because the manifest already tracks that sys_id, so
   * `push --prune` can hold back a DELETE of the same record.
   */
  sysId?: string;
  /** Set for `error`: why the record is neither created nor adopted. */
  message?: string;
  /**
   * R4: set for a table named by a composite rule (`tableOptions.nameFields`).
   * The record name is not one column, so the idempotency lookup matches these
   * column values from the sidecar instead, and nothing is written from the
   * name: the sidecar already carries every column.
   */
  lookup?: Record<string, string>;
  /**
   * False for a table outside the sys_metadata hierarchy. Its records have no
   * sys_scope column, so neither the idempotency lookup nor the POST body names
   * the application scope.
   */
  scoped?: boolean;
}

export interface CreationPlan {
  scopeId: string;
  plans: PlannedCreation[];
}

/**
 * Whether a sys_id an interrupted run recorded as created may be adopted:
 * "adopt" when the instance has the record in this scope (or the table carries
 * no scope column), "missing" on a 404, otherwise the refusal message.
 */
const verifyKnownRecord = async (
  client: SNClient,
  table: string,
  sysId: string,
  scopeId: string
): Promise<string> => {
  if (!/^[0-9a-f]{32}$/i.test(sysId)) {
    return `the push checkpoint names "${sysId}", which is not a sys_id; refusing to adopt it.`;
  }
  try {
    const remote = await client.getRecordScope(table, sysId);
    if (!remote) return "missing";
    if (remote.sys_scope !== "" && remote.sys_scope !== scopeId) {
      return (
        `the push checkpoint names ${sysId}, which belongs to scope "${remote.sys_scope}", ` +
        `not to this application (${scopeId}); refusing to adopt it.`
      );
    }
    return "adopt";
  } catch (e) {
    return `could not verify the record ${sysId} the push checkpoint names: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
};

/**
 * Decide, per candidate, whether `push --create` creates it, adopts an existing
 * record of the same name in the same scope, or refuses it. Read-only: the only
 * requests are GETs (the scope sys_id, the sys_db_object hierarchy walk and the
 * idempotency lookup), so a dry run calls it too. `known` maps
 * `table:recordName` to a sys_id an interrupted earlier run already created —
 * those are adopted after one GET confirms the record exists in this scope.
 */
export const planRecordCreation = async (
  candidates: CreateCandidate[],
  options: {
    persistScopeId: boolean;
    known?: Record<string, string>;
    client?: SNClient;
  }
): Promise<CreationPlan> => {
  if (candidates.length === 0) return { scopeId: "", plans: [] };
  const client = options.client ?? defaultClient();
  const scopeId = await resolveScopeId(client, options.persistScopeId);
  const config = ConfigManager.getConfig() as Sync.Config;
  // R4: the effective options carry the data-model naming rules, so a record
  // is matched by the same columns its name was built from.
  const allTableOptions = applyDataModelTableOptions(config);
  const hierarchyCache = new Map<string, boolean>();
  const missingTables = new Set<string>();
  const plans: PlannedCreation[] = [];
  const owners = manifestOwners();
  // An adoption is refused when the sys_id already belongs to a manifest
  // record or to another adoption of this run: two entries for one instance
  // record would PATCH it from two sets of files, and a `push --prune` of the
  // first entry would DELETE the record the second one just adopted.
  const adoptOrRefuse = (
    plan: (action: PlannedCreation["action"], extra?: Partial<PlannedCreation>) => PlannedCreation,
    candidate: CreateCandidate,
    sysId: string,
    extra: Partial<PlannedCreation> = {}
  ): PlannedCreation => {
    const owner = owners.get(sysId);
    if (owner && !(owner.table === candidate.table && owner.recordKey === candidate.recordName)) {
      return plan("error", {
        ...extra,
        sysId,
        message:
          `the matching instance record ${sysId} is already tracked in the manifest as ` +
          `${summarizeRecord(owner.table, owner.recordName)}; refusing to adopt it a second time. ` +
          "If the record was renamed on the instance, keep the local files under the name the " +
          "manifest tracks and run `syncrona refresh` to pick up the new name.",
      });
    }
    owners.set(sysId, {
      table: candidate.table,
      recordKey: candidate.recordName,
      recordName: candidate.recordName,
    });
    return plan("adopt", { ...extra, sysId });
  };
  // Sequential on purpose: the lookups are cheap, and creation order must not
  // depend on which request happened to answer first.
  for (const candidate of candidates) {
    const tableOptions = Object.prototype.hasOwnProperty.call(allTableOptions, candidate.table)
      ? allTableOptions[candidate.table]
      : undefined;
    const nameField = tableOptions?.displayField || getDisplayField(candidate.table);
    const nameValue = candidate.recordName.split(PATH_SEPARATOR_STAND_IN).join("/");
    const plan = (
      action: PlannedCreation["action"],
      extra: Partial<PlannedCreation> = {}
    ): PlannedCreation => ({ candidate, action, nameField, nameValue, ...extra });

    if (candidate.conflict) {
      plans.push(plan("error", { message: candidate.conflict }));
      continue;
    }
    const knownSysId = options.known?.[candidateKey(candidate)];
    if (typeof knownSysId === "string" && knownSysId !== "") {
      // The checkpoint is a local file: its sys_id is adopted only once the
      // instance confirms the record exists in this scope. A record that is
      // gone (deleted since, or the checkpoint is stale) falls through to the
      // ordinary lookup below.
      const verdict = await verifyKnownRecord(client, candidate.table, knownSysId, scopeId);
      if (verdict === "adopt") {
        plans.push(adoptOrRefuse(plan, candidate, knownSysId));
        continue;
      }
      if (verdict !== "missing") {
        plans.push(plan("error", { message: verdict }));
        continue;
      }
    }
    if (tableOptions?.differentiatorField) {
      // The manifest name of such a record carries a " (value)" suffix the
      // instance never stores, so the name column cannot be derived from it.
      plans.push(
        plan("error", {
          message:
            `tableOptions.${candidate.table}.differentiatorField is set, so the ` +
            "record name cannot be mapped back to a single column. Create the " +
            "record on the instance and run `syncrona refresh`.",
        })
      );
      continue;
    }
    let lookup: Record<string, string> | undefined;
    const nameFields = tableOptions?.displayField ? undefined : tableOptions?.nameFields;
    if (Array.isArray(nameFields) && nameFields.length > 0) {
      const resolved = await compositeLookupValues(candidate, nameFields);
      if (typeof resolved === "string") {
        plans.push(plan("error", { message: resolved }));
        continue;
      }
      lookup = resolved;
    }
    try {
      const policy = await checkCreateTablePolicy(
        client,
        candidate.table,
        hierarchyCache,
        missingTables
      );
      // A denied table is refused before any request, so it never reaches the
      // walk. Every other table is walked here (a no-op when the policy already
      // did), which is what tells a missing table from an unscoped one: an
      // allowlisted name the instance does not have would otherwise be planned
      // as a create of a record in no table at all.
      const scoped = policy.allowed
        ? await extendsSysMetadata(client, candidate.table, hierarchyCache, missingTables)
        : false;
      if (missingTables.has(candidate.table)) {
        plans.push(
          plan("error", {
            message:
              `table ${candidate.table} does not exist on the instance (no sys_db_object ` +
              `record is named "${candidate.table}"), so no record can be created in it. ` +
              "Check the table folder name, and that this user can read sys_db_object.",
          })
        );
        continue;
      }
      if (!policy.allowed) {
        plans.push(plan("error", { message: policy.reason }));
        continue;
      }
      const natural = scoped ? undefined : UNSCOPED_NATURAL_KEYS[candidate.table];
      if (natural) {
        const resolved = await compositeLookupValues(
          candidate,
          [...(nameFields ?? []), ...natural.columns],
          natural.defaults
        );
        if (typeof resolved === "string") {
          plans.push(plan("error", { message: resolved }));
          continue;
        }
        lookup = resolved;
      }
      const extra: Partial<PlannedCreation> = {
        ...(lookup ? { lookup } : {}),
        ...(scoped ? {} : { scoped: false }),
      };
      const hits = await findExisting(client, { candidate, nameField, nameValue, ...extra }, scopeId);
      const foreign = hits.length === 1 ? hits[0].scope : undefined;
      if (foreign !== undefined && foreign !== "" && foreign !== scopeId) {
        // The lookup of a table outside sys_metadata carries no sys_scope
        // term, so the row's own scope is checked here: adopting another
        // application's record would PATCH it from this one's files.
        plans.push(
          plan("error", {
            ...extra,
            message:
              `the matching ${candidate.table} record ${hits[0].sysId} belongs to scope ` +
              `"${foreign}", not to this application (${scopeId}); refusing to adopt it. ` +
              "Rename the local record, or change it in its own application.",
          })
        );
      } else if (hits.length === 0) {
        plans.push(plan("create", extra));
      } else if (hits.length === 1) {
        plans.push(adoptOrRefuse(plan, candidate, hits[0].sysId, extra));
      } else {
        plans.push(
          plan("error", {
            message:
              `more than one ${candidate.table} record ${describeTarget(lookup, nameValue)} exists ` +
              `${scoped ? "in this scope" : "on the instance"}; refusing to guess which one ` +
              "the local files belong to.",
          })
        );
      }
    } catch (e) {
      plans.push(plan("error", { message: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { scopeId, plans };
};

/**
 * R4: the column values a composite-named record is matched by, read from its
 * sidecar. Returns an error message when the record cannot be matched: no
 * sidecar, an unreadable one, or a naming column it leaves empty. Matching on
 * fewer columns than the name was built from could adopt a different record.
 */
const compositeLookupValues = async (
  candidate: CreateCandidate,
  nameFields: readonly string[],
  defaults: Readonly<Record<string, string>> = {}
): Promise<Record<string, string> | string> => {
  const columns = [...new Set(nameFields.map(nameFieldColumn))];
  const sidecar = candidate.files.find((file) => file.isSidecar);
  const needs =
    `the columns its name is built from (${columns.join(", ")}) must be set in ` +
    "its .meta.json sidecar";
  if (!sidecar) {
    return `this table names records by several columns, so ${needs}.`;
  }
  let parsed: unknown;
  try {
    // SDK-F2: an entry expanded from a data-model document carries its text.
    const text = sidecar.contents ?? (await fsp.readFile(sidecar.filePath, "utf8"));
    parsed = JSON.parse(stripBOM(text));
  } catch (e) {
    return `could not read ${sidecar.filePath}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${sidecar.filePath} must be a JSON object of "column": "value" pairs.`;
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const column of columns) {
    const raw = (parsed as Record<string, unknown>)[column];
    const value =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : "";
    if (value.trim() !== "") values[column] = value;
    else if (defaults[column] !== undefined) values[column] = defaults[column];
    else missing.push(column);
  }
  if (missing.length > 0) {
    return `this table names records by several columns, so ${needs}; missing: ${missing.join(", ")}.`;
  }
  return values;
};

/**
 * A column value as the Table API returns it: a plain string, a reference as
 * `{ link, value }`, or undefined when the row does not carry the column at
 * all — which is what a column the table does not have looks like.
 */
const returnedColumnValue = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
    return (raw as { value: string }).value;
  }
  return undefined;
};

/**
 * The records whose columns equal `values`, in `scopeId` when one is given
 * (undefined for a table outside the sys_metadata hierarchy). Without a scope
 * term each hit also carries its `sys_scope` (undefined when the table has no
 * such column), for the caller to refuse another application's record.
 *
 * The instance drops a query term on a column the table does not have, so the
 * lookup alone cannot be trusted: a wrong naming column would match unrelated
 * records. Every lookup column is read back and compared with the value looked
 * for, and a row that does not carry the column or holds another value fails
 * the lookup instead of being adopted. A value holding `^`, the encoded-query
 * condition separator, has no escape, so it fails the lookup too rather than
 * being looked up as something else.
 */
interface LookupHit {
  sysId: string;
  /** The row's sys_scope, read only for a lookup without a scope term. */
  scope?: string;
}

const findRecordByColumns = async (
  client: SNClient,
  table: string,
  values: Record<string, string>,
  scopeId: string | undefined
): Promise<LookupHit[]> => {
  const entries = Object.entries(values);
  for (const [column, value] of entries) {
    if (column.includes("^") || value.includes("^")) {
      throw new Error(
        `the ${table} lookup on ${column}="${value}" contains "^", which separates ` +
          "conditions in a ServiceNow encoded query and cannot be escaped, so the record " +
          "cannot be matched safely. Create or link it on the instance and run `syncrona refresh`."
      );
    }
  }
  const query = [
    ...entries.map(([column, value]) =>
      value === ""
        ? `${escapeQueryValue(column)}ISEMPTY`
        : `${escapeQueryValue(column)}=${escapeQueryValue(value)}`
    ),
    ...(scopeId === undefined ? [] : [`sys_scope=${escapeQueryValue(scopeId)}`]),
  ].join("^");
  const fields = [
    ...new Set([
      "sys_id",
      ...entries.map(([column]) => column),
      ...(scopeId === undefined ? ["sys_scope"] : []),
    ]),
  ].join(",");
  const records = await unwrapSNResponse<Record<string, unknown>[]>(
    client.tableAPIGet(table, query, fields, 2)
  );
  const hits: LookupHit[] = [];
  for (const record of Array.isArray(records) ? records : []) {
    const sysId = record?.sys_id;
    if (typeof sysId !== "string" || sysId === "") continue;
    for (const [column, expected] of entries) {
      const actual = returnedColumnValue(record[column]);
      if (actual === undefined) {
        throw new Error(
          `the ${table} lookup matched record ${sysId}, which carries no "${column}" column. ` +
            "The instance ignores a query term on a column the table does not have, so the " +
            `match cannot be trusted; check the naming columns configured for ${table}. ` +
            "Nothing was adopted or created."
        );
      }
      if (actual !== expected) {
        throw new Error(
          `the ${table} lookup for ${column}="${expected}" matched record ${sysId}, whose ` +
            `${column} is "${actual}". Refusing to adopt a record whose key differs from the ` +
            "local one; nothing was adopted or created."
        );
      }
    }
    hits.push(
      scopeId === undefined
        ? { sysId, scope: returnedColumnValue(record.sys_scope) }
        : { sysId }
    );
  }
  return hits;
};

/**
 * The idempotency lookup: the records a planned creation would duplicate. A
 * table outside the sys_metadata hierarchy is matched without a sys_scope term,
 * which the instance would ignore anyway, on its natural key when one is known.
 */
const findExisting = (
  client: SNClient,
  plan: Pick<PlannedCreation, "candidate" | "nameField" | "nameValue" | "lookup" | "scoped">,
  scopeId: string
): Promise<LookupHit[]> => {
  const { table } = plan.candidate;
  const scope = plan.scoped === false ? undefined : scopeId;
  return findRecordByColumns(
    client,
    table,
    plan.lookup ?? { [plan.nameField]: plan.nameValue },
    scope
  );
};

/** How a record is identified in a message: by its name, or by its lookup columns. */
const describeTarget = (
  lookup: Record<string, string> | undefined,
  nameValue: string
): string =>
  lookup
    ? `with ${Object.entries(lookup)
        .map(([column, value]) => `${column}=${value}`)
        .join(", ")}`
    : `named "${nameValue}"`;

export interface CreationOutcome {
  /** One result per created or refused record. Adopted records report through pushFiles. */
  results: Sync.PushResult[];
  /** Adopted records, resolved through the updated manifest, for pushFiles to PATCH. */
  records: Sync.BuildableRecord[];
  /**
   * Tables with at least one refused or failed creation. `push --prune` holds
   * back deletions on these tables: a rename is a delete plus a create, and
   * deleting the old record when the new one was never created would lose it.
   */
  failedTables: string[];
}

/**
 * R4: discover the sidecar columns of a data-model table the manifest does not
 * know yet. Undefined when discovery does not apply: no sidecar, a table the
 * manifest already describes, or a table that is not a data-model table (whose
 * sidecar keeps failing on the degraded-manifest check, as before).
 */
const discoverCreateMeta = async (
  client: SNClient,
  candidate: CreateCandidate
): Promise<DiscoveredMeta | undefined> => {
  if (!candidate.files.some((file) => file.isSidecar)) return undefined;
  const config = ConfigManager.getConfig() as Sync.Config;
  if (config.meta === false || config.metaPush === false) return undefined;
  if (!isDataModelTable(candidate.table, config)) return undefined;
  const known = readManifest().tables?.[candidate.table];
  if (known?.metaFields?.length) return undefined;
  // Loaded on demand: the manifest builder is a large module, and this branch
  // runs only for a sidecar-only create on a table new to the workspace.
  const { discoverTableMetaFields } = await import("./manifestBuilder.js");
  const meta = await discoverTableMetaFields(client, candidate.table, config);
  if (meta.fields.length === 0) {
    throw new Error(
      `could not read the columns of ${candidate.table} from the dictionary, so ` +
        "its .meta.json cannot be checked. Check read access to sys_dictionary and retry."
    );
  }
  return { metaFields: meta.fields, readOnlyFields: meta.readOnly };
};

const buildCreateFields = async (
  plan: PlannedCreation,
  scopeId: string,
  discovered?: DiscoveredMeta
): Promise<Record<string, string>> => {
  const { candidate } = plan;
  const manifest = readManifest();
  const rec: Sync.BuildableRecord = { table: candidate.table, sysId: "", fields: {} };
  for (const file of candidate.files) {
    rec.fields[file.field] = {
      filePath: file.filePath,
      ext: file.ext,
      sys_id: "",
      name: candidate.recordName,
      scope: manifest.scope,
      tableName: candidate.table,
      targetField: file.field,
      ...(file.contents !== undefined ? { fileContents: file.contents } : {}),
    };
  }
  const buildRes = await buildRec(rec);
  if (!buildRes.success) throw new Error(buildRes.message);
  const expanded = expandMetaSidecar(rec, buildRes.builtRec, discovered);
  return {
    ...expanded.fields,
    // A composite name is not one column; the sidecar carries the columns.
    ...(plan.lookup ? {} : { [plan.nameField]: plan.nameValue }),
    // A record outside the sys_metadata hierarchy has no sys_scope column.
    ...(plan.scoped === false ? {} : { sys_scope: scopeId }),
  };
};

/**
 * POST one record. The client never retries a POST (it is not idempotent), so
 * the retry lives here, and every retry is preceded by the idempotency lookup:
 * a timeout can arrive after the instance inserted the row, and posting again
 * would create a duplicate.
 */
const postWithLookup = async (
  client: SNClient,
  plan: PlannedCreation,
  scopeId: string,
  body: Record<string, string>,
  retryWaitMs: number
): Promise<string> => {
  const { table } = plan.candidate;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await client.createRecord(table, body)).sys_id;
    } catch (e) {
      if (!isRetryableRequestError(e) || attempt >= PUSH_RETRY_LIMIT) throw e;
      logger.debug(
        `Creating ${summarizeRecord(table, plan.candidate.recordName)} failed; ` +
          "checking whether it exists before retrying..."
      );
      await wait(retryWaitMs);
      const hits = await findExisting(client, plan, scopeId);
      // No scope check here: the record found may be the one the failed POST
      // created, which the instance files under the session's scope.
      if (hits.length === 1) return hits[0].sysId;
      if (hits.length > 1) {
        throw new Error(
          `more than one ${table} record ${describeTarget(plan.lookup, plan.nameValue)} exists after a failed create.`
        );
      }
    }
  }
};

/**
 * Carry out a creation plan, one record at a time.
 *
 * - `create`: build the files (plugins and sidecar expansion as for any push),
 *   POST them with the name column and `sys_scope`, report the sys_id through
 *   `onCreated` (the push checkpoint) and add the record to the manifest.
 * - `adopt`: add the existing record to the manifest and hand its files back as
 *   ordinary records, so pushFiles PATCHes them like any other update.
 * - `error`: a failed result, nothing sent.
 */
export const createRecords = async (
  creation: CreationPlan,
  options: {
    client?: SNClient;
    onCreated?: (key: string, sysId: string) => Promise<void> | void;
    retryWaitMs?: number;
  } = {}
): Promise<CreationOutcome> => {
  const results: Sync.PushResult[] = [];
  const adoptedPaths: string[] = [];
  const failedTables = new Set<string>();
  // SDK-F2: the in-memory text of adopted document entries, by virtual path.
  const adoptedContents = new Map<string, string>();
  if (creation.plans.length === 0) return { results, records: [], failedTables: [] };
  const client = options.client ?? defaultClient();
  const retryWaitMs = options.retryWaitMs ?? PUSH_RETRY_WAIT;
  for (const plan of creation.plans) {
    const { candidate } = plan;
    const summary = summarizeRecord(candidate.table, candidate.recordName);
    try {
      if (plan.action === "error") {
        failedTables.add(candidate.table);
        results.push({ success: false, message: `${summary} : ${plan.message}` });
        continue;
      }
      if (plan.action === "adopt") {
        await addRecordToManifest(candidate, plan.sysId as string);
        logger.info(`${summary} : adopted existing record ${plan.sysId}.`);
        for (const file of candidate.files) {
          adoptedPaths.push(file.filePath);
          if (file.contents !== undefined) adoptedContents.set(file.filePath, file.contents);
        }
        continue;
      }
      const discovered = await discoverCreateMeta(client, candidate);
      const body = await buildCreateFields(plan, creation.scopeId, discovered);
      const sysId = await postWithLookup(client, plan, creation.scopeId, body, retryWaitMs);
      await options.onCreated?.(candidateKey(candidate), sysId);
      await addRecordToManifest(candidate, sysId, discovered);
      results.push({ success: true, message: `${summary} : created (${sysId}).` });
    } catch (e) {
      failedTables.add(candidate.table);
      results.push({
        success: false,
        message: `${summary} : ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const contexts = adoptedPaths
    .map((filePath) => {
      const ctx = fUtils.getFileContextFromPath(filePath);
      const contents = adoptedContents.get(filePath);
      if (ctx && contents !== undefined) ctx.fileContents = contents;
      return ctx;
    })
    .filter((ctx): ctx is Sync.FileContext => ctx !== undefined);
  return { results, records: groupAppFiles(contexts), failedTables: [...failedTables] };
};

// ---------------------------------------------------------------------------
// R2, `push --prune`: delete instance records whose local files are all gone.
// ---------------------------------------------------------------------------

/** A manifest record every local file of which (sidecar included) is missing. */
export interface PruneCandidate {
  table: string;
  /** The record's key in `manifest.tables[table].records`. */
  recordKey: string;
  /** The record name as written to disk (`record.name`, falling back to the key). */
  recordName: string;
  sysId: string;
  /** The manifest's file entries for the record (all missing locally). */
  files: SN.File[];
}

export interface PruneCandidateOptions {
  /**
   * The git evidence of the deletion: absolute paths the `--diff` range
   * deleted (D lines, renamed-from paths), or — without `--diff` — the files
   * tracked in HEAD that are missing from the working tree. Only records one
   * of these paths belongs to stay candidates. `push --prune` always passes
   * it: a manifest file that is merely absent locally (an interrupted
   * download, a never-committed record) is not a deletion.
   */
  diffDeleted?: string[];
  /**
   * An explicit push target (encoded paths). Only records at or under one of
   * the targets — or containing one — stay candidates, so `push <dir> --prune`
   * never reaches outside `<dir>`.
   */
  targets?: string;
}

const isWithin = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Where the record lives on disk: its folder, or the flat `<record>~` stem. */
const recordBasePath = (table: string, recordName: string, flat: boolean): string =>
  path.join(
    ConfigManager.getSourcePath(),
    table,
    flat ? `${recordName}${FLAT_FIELD_SEPARATOR}` : recordName
  );

const sidecarPath = (table: string, recordName: string, flat: boolean): string =>
  flat
    ? path.join(
        ConfigManager.getSourcePath(),
        table,
        `${recordName}${FLAT_FIELD_SEPARATOR}${META_SIDECAR_FILE_NAME}`
      )
    : path.join(ConfigManager.getSourcePath(), table, recordName, META_SIDECAR_FILE_NAME);

const targetCoversRecord = (
  target: string,
  table: string,
  recordName: string,
  flat: boolean
): boolean => {
  const resolved = path.resolve(target);
  const base = recordBasePath(table, recordName, flat);
  if (flat) {
    const tableDir = path.dirname(base);
    // A target at or above the table directory covers every record in it; a
    // target inside the table directory covers the record whose stem it names.
    // The rest of the file name after the stem is one field file, which holds
    // no separator: `Foo~Bar~script.js` belongs to record `Foo~Bar`, not to `Foo`.
    if (isWithin(resolved, tableDir)) return true;
    const stem = path.basename(base);
    const fileName = path.basename(resolved);
    return (
      path.dirname(resolved) === tableDir &&
      fileName.startsWith(stem) &&
      !fileName.slice(stem.length).includes(FLAT_FIELD_SEPARATOR)
    );
  }
  return isWithin(resolved, base) || isWithin(base, resolved);
};

/**
 * Manifest records whose local files are ALL missing — every field file and the
 * metadata sidecar. A record with even one file left is an edit in progress, not
 * a deletion, and is never a candidate. Read-only: local stats only.
 */
export const findPruneCandidates = async (
  options: PruneCandidateOptions = {}
): Promise<PruneCandidate[]> => {
  const manifest = readManifest();
  const flat = ConfigManager.getConfig().flat === true;
  const missing = await findMissingFiles(manifest);
  let deletedRecords: Set<string> | undefined;
  if (options.diffDeleted) {
    deletedRecords = new Set<string>();
    for (const deletedPath of options.diffDeleted) {
      const ctx = fUtils.getFileContextFromPath(deletedPath);
      if (ctx) deletedRecords.add(`${ctx.tableName}\u0000${ctx.sys_id}`);
    }
  }
  const targets =
    options.targets !== undefined ? fUtils.splitEncodedPaths(options.targets) : undefined;
  const candidates: PruneCandidate[] = [];
  for (const [table, tableConfig] of Object.entries(manifest.tables)) {
    const missingInTable = Object.prototype.hasOwnProperty.call(missing, table)
      ? missing[table]
      : undefined;
    if (!missingInTable) continue;
    for (const [recordKey, record] of Object.entries(tableConfig.records ?? {})) {
      const files = Array.isArray(record?.files) ? record.files : [];
      if (files.length === 0 || typeof record.sys_id !== "string") continue;
      const missingFiles = Object.prototype.hasOwnProperty.call(missingInTable, record.sys_id)
        ? missingInTable[record.sys_id]
        : [];
      if (missingFiles.length < files.length) continue;
      const recordName = record.name || recordKey;
      if (deletedRecords && !deletedRecords.has(`${table}\u0000${record.sys_id}`)) continue;
      if (targets && !targets.some((t) => targetCoversRecord(t, table, recordName, flat))) {
        continue;
      }
      // A sidecar on disk the manifest does not list still belongs to the record.
      if (await fUtils.pathExists(sidecarPath(table, recordName, flat))) continue;
      candidates.push({ table, recordKey, recordName, sysId: record.sys_id, files });
    }
  }
  return candidates;
};

/** Above this many candidates `push --prune` needs `--allow-mass-delete`. */
export const PRUNE_MASS_DELETE_COUNT = 25;
/**
 * Above this share of the manifest's records (and more than
 * PRUNE_MASS_DELETE_FLOOR candidates) `push --prune` needs `--allow-mass-delete`.
 */
export const PRUNE_MASS_DELETE_SHARE = 0.2;
const PRUNE_MASS_DELETE_FLOOR = 5;

/**
 * The mass-delete guard of `push --prune`: a message when the candidates are
 * more than PRUNE_MASS_DELETE_COUNT records, or more than
 * PRUNE_MASS_DELETE_FLOOR records and over PRUNE_MASS_DELETE_SHARE of every
 * record the manifest tracks — the shape of a wrong source tree or a wiped
 * checkout rather than of a cleanup. Undefined when the run may proceed.
 */
export const pruneVolumeRefusal = (candidateCount: number): string | undefined => {
  const manifest = readManifest();
  let total = 0;
  for (const tableConfig of Object.values(manifest.tables ?? {})) {
    total += Object.keys(tableConfig?.records ?? {}).length;
  }
  const share = total > 0 ? candidateCount / total : 1;
  const tooMany = candidateCount > PRUNE_MASS_DELETE_COUNT;
  const tooLarge = candidateCount > PRUNE_MASS_DELETE_FLOOR && share > PRUNE_MASS_DELETE_SHARE;
  if (!tooMany && !tooLarge) return undefined;
  return (
    `${candidateCount} of the ${total} record(s) the manifest tracks would be deleted ` +
    `(${Math.round(share * 100)}%), above the mass-delete limit of ${PRUNE_MASS_DELETE_COUNT} ` +
    `records or ${Math.round(PRUNE_MASS_DELETE_SHARE * 100)}% of the manifest. ` +
    "Check the source directory and the git state; pass --allow-mass-delete if the deletion is intended."
  );
};

/**
 * Store the scope sys_id a prune plan resolved, once the run is past its
 * confirmation. No-op when the manifest already holds one.
 */
export const persistScopeId = async (scopeId: string): Promise<void> => {
  if (scopeId === "" || readManifest().scopeId) return;
  await saveManifest({ ...readManifest(), scopeId });
};

const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Tables `push --prune` never deletes from: the shared create-policy deny list
 * (users, roles, groups, system properties, CMDB), the data-model tables (a
 * DELETE there drops a column, table, role or ACL), and every table the default
 * download configuration excludes — unless the project opted that table in
 * through `tableOptions`. Returns the refusal reason, or undefined when allowed.
 */
export const checkPruneTablePolicy = (table: string): string | undefined => {
  if (isDeniedCreateTable(table)) {
    return (
      `refusing to delete from "${table}": the table is on the deny list ` +
      "(users, roles, groups, system properties, CMDB). Delete it on the instance by hand."
    );
  }
  if (isPruneDeniedTable(table)) {
    return (
      `refusing to delete from "${table}": it is a data-model table, and deleting its ` +
      "records drops schema or access on the instance. Delete it on the instance by hand."
    );
  }
  if (Object.prototype.hasOwnProperty.call(defaultExcludedTables, table)) {
    const { tableOptions = {} } = ConfigManager.getConfig() as Sync.Config;
    if (!Object.prototype.hasOwnProperty.call(tableOptions, table)) {
      return (
        `refusing to delete from "${table}": the table is excluded by default. ` +
        `Opt in with a tableOptions["${table}"] entry in sync.config.js to prune it.`
      );
    }
  }
  return undefined;
};

/**
 * `delete`: in scope, sent as a DELETE. `unverified`: the instance answers 404,
 * which is also what a read ACL that hides the record looks like, so nothing is
 * sent and the manifest entry stays. `error`: refused, nothing sent.
 */
export type PruneAction = "delete" | "unverified" | "error";

export interface PlannedPrune {
  candidate: PruneCandidate;
  action: PruneAction;
  message?: string;
}

export interface PrunePlan {
  scopeId: string;
  plans: PlannedPrune[];
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Decide, per candidate, whether it may be deleted. Read-only — GETs only (the
 * scope sys_id when the manifest lacks it, and one `sys_id,sys_scope` read per
 * record) — so a dry run calls it too. A record is deleted only when the
 * instance confirms it belongs to the manifest's scope.
 */
export const planRecordPrune = async (
  candidates: PruneCandidate[],
  options: { persistScopeId: boolean; client?: SNClient }
): Promise<PrunePlan> => {
  if (candidates.length === 0) return { scopeId: "", plans: [] };
  const client = options.client ?? defaultClient();
  let scopeId: string;
  try {
    scopeId = await resolveScopeId(client, options.persistScopeId);
  } catch (e) {
    const message = `the application scope is unknown, so no record can be checked: ${errorMessage(e)}`;
    return {
      scopeId: "",
      plans: candidates.map((candidate) => ({ candidate, action: "error", message })),
    };
  }
  const plans: PlannedPrune[] = [];
  for (const candidate of candidates) {
    const refusal = checkPruneTablePolicy(candidate.table);
    if (refusal) {
      plans.push({ candidate, action: "error", message: refusal });
      continue;
    }
    if (!SYS_ID_PATTERN.test(candidate.sysId)) {
      plans.push({
        candidate,
        action: "error",
        message: `refusing to delete: "${candidate.sysId}" is not a sys_id.`,
      });
      continue;
    }
    try {
      const remote = await client.getRecordScope(candidate.table, candidate.sysId);
      if (!remote) {
        plans.push({
          candidate,
          action: "unverified",
          message:
            "skipped: the instance answers 404 — the record is already deleted, or a read ACL " +
            "hides it from this user. Nothing was sent and the manifest entry is kept; " +
            "`syncrona refresh` drops it once the record is really gone.",
        });
      } else if (remote.sys_scope !== scopeId) {
        plans.push({
          candidate,
          action: "error",
          message:
            `refusing to delete: the record belongs to scope "${remote.sys_scope || "unknown"}", ` +
            `not to this application (${scopeId}).`,
        });
      } else {
        plans.push({ candidate, action: "delete" });
      }
    } catch (e) {
      plans.push({
        candidate,
        action: "error",
        message: `could not verify the record's scope: ${errorMessage(e)}`,
      });
    }
  }
  return { scopeId, plans };
};

const removeRecordFromManifest = async (candidate: PruneCandidate): Promise<void> => {
  const manifest = readManifest();
  if (!Object.prototype.hasOwnProperty.call(manifest.tables, candidate.table)) return;
  const tableConfig = manifest.tables[candidate.table];
  const records = { ...(tableConfig.records ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(records, candidate.recordKey)) return;
  delete records[candidate.recordKey];
  await saveManifest({
    ...manifest,
    tables: { ...manifest.tables, [candidate.table]: { ...tableConfig, records } },
  });
};

/**
 * Carry out a prune plan, one record at a time: DELETE each `delete` record
 * (retried on transient failures; a 404 means an earlier attempt landed) and
 * drop it from the manifest. `unverified` records are reported and kept, with
 * nothing sent; `error` records report a failure and nothing is sent.
 */
export const pruneRecords = async (
  plan: PrunePlan,
  options: { client?: SNClient; retryWaitMs?: number } = {}
): Promise<Sync.PushResult[]> => {
  const results: Sync.PushResult[] = [];
  if (plan.plans.length === 0) return results;
  const client = options.client ?? defaultClient();
  const retryWaitMs = options.retryWaitMs ?? PUSH_RETRY_WAIT;
  for (const { candidate, action, message } of plan.plans) {
    const summary = summarizeRecord(candidate.table, candidate.recordName);
    if (action === "error") {
      results.push({ success: false, message: `${summary} : ${message}` });
      continue;
    }
    if (action === "unverified") {
      results.push({ success: true, message: `${summary} : ${message}` });
      continue;
    }
    try {
      try {
        await retryOnErr(
          () => client.deleteRecord(candidate.table, candidate.sysId),
          PUSH_RETRY_LIMIT,
          retryWaitMs,
          (retriesLeft: number) =>
            logger.debug(`Retrying delete of ${summary}; ${retriesLeft} attempt(s) left.`),
          isRetryableRequestError
        );
      } catch (e) {
        // The GET just confirmed the record, so a 404 here means an earlier
        // attempt of this DELETE landed.
        if (getErrorResponseStatus(e) !== 404) throw e;
      }
      await removeRecordFromManifest(candidate);
      results.push({ success: true, message: `${summary} : deleted (${candidate.sysId}).` });
    } catch (e) {
      results.push({ success: false, message: `${summary} : ${errorMessage(e)}` });
    }
  }
  return results;
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
