// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { createHash } from "crypto";
import path from "path";
import * as fUtils from "./FileUtils.js";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import * as ConfigManager from "./config.js";
import { defaultClient, unwrapSNResponse } from "./snClient.js";
import { withoutDotWalkedFieldFiles } from "./dotWalkedFieldFiles.js";
import type { SNClient } from "./snClient.js";
import {
  applyIncludeTypeRulesToManifest,
  attachMetaFieldsToManifest,
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
  isScopedEndpointUnavailableError,
  ManifestMetaFields,
  ManifestRecordNames,
} from "./manifestBuilder.js";
import { classifyColumn, isMetaFile } from "./metaFields.js";
import { applyDataModelTableOptions } from "./dataModel.js";
import {
  COMPOSITE_TABLES,
  CompositeWrite,
  assertNoCompositeEntries,
  assertNoPerRecordSidecars,
  compositeIndexKey,
  getCompositeTables,
  loadCompositeIndex,
  mergeCompositeWrites,
} from "./dataModelComposite.js";
import { logger } from "./Logger.js";
import { unsafePathComponentReason } from "./genericUtils.js";
import {
  applyManifestFolderNames,
  assignManifestFolderNames,
  migrateRenamedRecordFolders,
} from "./recordFolderNames.js";
import {
  DownloadCheckpoint,
  readDownloadCheckpoint,
  writeDownloadCheckpoint,
  deleteDownloadCheckpoint,
} from "./downloadCheckpoint.js";
import { warnWithdrawnFieldFiles } from "./withdrawnFieldFiles.js";

// A bounded worker pool so the download/refresh writer and the missing-file
// probe never open more filesystem handles than `resolveWriteConcurrency()` at
// once. Kept local (copied from pushPipeline.ts, where the equivalent helper is
// not exported) to avoid a cross-module import between the pull and push seams.
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
  // caller had already unwound (releasing the push lock, deleting the
  // checkpoint, exiting) while those workers were still writing files and
  // issuing requests in the background, and all but the first error were
  // discarded. Collect the errors, stop scheduling new work, and rethrow.
  const errors: unknown[] = [];

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length && errors.length === 0) {
        const current = nextIndex;
        nextIndex += 1;
        try {
          results[current] = await worker(items[current], current);
        } catch (e) {
          errors.push(e);
        }
      }
    }
  );

  await Promise.all(runners);
  if (errors.length > 0) {
    // Rethrow a lone error unchanged so callers can still classify it
    // (isScopedEndpointUnavailableError, retry predicates, status codes).
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${errors.length} concurrent operations failed.`);
  }
  return results;
};

// Default cap for filesystem-handle fan-out (writes, mkdirs and existence
// probes). Clamped to 1–50; an optional `writeConcurrency` config field can
// override it. 20 keeps a large scope well under typical descriptor limits
// (EMFILE) while staying parallel enough to be fast.
export const DEFAULT_WRITE_CONCURRENCY = 20;

export const resolveWriteConcurrency = (): number => {
  const candidate = (ConfigManager.getConfig() as { writeConcurrency?: unknown })
    .writeConcurrency;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_WRITE_CONCURRENCY;
  }
  return Math.min(Math.max(Math.floor(candidate), 1), 50);
};

// INJ-1: FOUR manifest-supplied strings reach path.join on the way to a local
// write — the table name (a key of the server- or manifest-supplied table map),
// the record name (including scoped-endpoint `name` values), and each file's
// `name` and `type`, which are interpolated together as `<name>.<type>`. A
// tampered manifest or a hostile scoped-download response can smuggle "..", ".",
// an empty string, or an embedded path separator into any of them and walk the
// write somewhere it does not belong — a manifest-driven arbitrary-file-write.
//
// The two halves are NOT the same threat. Table and record names escape the
// workspace source root outright. The per-file components escape only as far as
// a sibling directory inside the source tree — which is why the containment
// guard in writeSNFileCurry, anchored at the source root, never caught them: a
// field named "../Bar/script" written from record Foo's folder lands on record
// Bar's real file, is skipped-as-present when Bar's own write follows (checkExists
// is on unless --force), and a later `syncrona push` uploads the payload into
// Bar's field. Staying inside the source root makes it quieter, not safer.
//
// So every one of the four is validated here, before it reaches path.join, and
// loudly rather than by silent rewriting (which would mask a compromised source).
// This seam is the single chokepoint every pull path (wizard, refresh, download)
// converges on; writeSNFileCurry re-checks the per-file components itself, so the
// guarantee holds for any caller that reaches the writer by another route.
// Legitimate names never trip this: buildRecordName already strips separators and
// falls back to sys_id for empty/all-dot names, ServiceNow table names are plain
// identifiers, and the predicate accepts dots inside a component so dot-walked
// field names ("inputs.script") keep working.
//
// Scope of the guarantee: no DOWNLOAD write escapes its intended directory. The
// read-only probes (SNFileExists in checkFilesForMissing) still join manifest
// components without this check — a traversal there can only mis-report a file as
// present, and any manifest that could trigger it is rejected by this seam before
// a single byte is written.
//
// The predicate itself lives in genericUtils so every consumer that joins an
// instance-supplied name onto a local path uses the SAME rule (`init --ci`
// builds packages/<scope> directories from sys_app rows and used to skip this
// check entirely).
type UnsafeComponentKind =
  | "table name"
  | "record name"
  | "field name"
  | "file type";

// What each component would escape if it were let through — table/record names
// leave the workspace entirely, per-file components leave only the record's own
// directory. Naming the right boundary keeps the error honest.
const CONTAINMENT_BOUNDARY: Record<UnsafeComponentKind, string> = {
  "table name": "the workspace source root",
  "record name": "the workspace source root",
  "field name": "its record's directory",
  "file type": "its record's directory",
};

const assertSafePathComponent = (
  component: string,
  kind: UnsafeComponentKind
): void => {
  const unsafe = unsafePathComponentReason(component);
  if (unsafe) {
    // Only a traversal escapes anything; a control character or an overlong
    // segment is refused because no filesystem stores it as written.
    const consequence = unsafe.traversal
      ? ` and would escape ${CONTAINMENT_BOUNDARY[kind]}`
      : "";
    throw new Error(
      `Refusing to download: unsafe ${kind} ${JSON.stringify(component)}: ` +
        `${unsafe.reason}${consequence}.`
    );
  }
};

// Both layouts interpolate these two into the same `<name>.<type>` file name, so
// both layouts validate them the same way.
const assertSafeFileComponents = (file: SN.File): void => {
  assertSafePathComponent(file.name, "field name");
  assertSafePathComponent(file.type, "file type");
};

// Shared by processManifest, processMissingFiles and downloadAllFiles — the
// single seam that governs every pull path (wizard, refresh and download).
export const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean
) => {
  // DX17: read flat mode straight off the loaded config (not getFlatMode()) so
  // this single seam governs every pull path — wizard, refresh and download.
  const config = ConfigManager.getConfig();
  const flat = config.flat === true;
  // SDK-F2: with dataModelLayout "composite" the sidecars of sys_db_object,
  // sys_dictionary and sys_choice are not written per record — they are merged
  // into one data-model document per table after the file pool drains.
  const compositeTables = new Set(getCompositeTables(config));
  const compositeWrites: CompositeWrite[] = [];
  // "records" layout: the per-record sidecars of those tables are refused while
  // a data-model document still holds the same record.
  const recordsLayoutSidecars: Array<{ table: string; recordName: string }> = [];
  const routeToDocument = (tableName: string, recordName: string, file: SN.File): boolean => {
    if (!isMetaFile(file) || !("content" in file)) return false;
    if (compositeTables.has(tableName)) {
      if (typeof file.content === "string" && file.content !== "") {
        compositeWrites.push({ table: tableName, recordName, content: file.content });
      }
      return true;
    }
    if (COMPOSITE_TABLES.includes(tableName)) {
      recordsLayoutSidecars.push({ table: tableName, recordName });
    }
    return false;
  };
  const sourcePath = ConfigManager.getSourcePath();
  const concurrency = resolveWriteConcurrency();
  const tableNames = Object.keys(tables);

  // PERF-1 (REV-89): flatten the tables×records×files tree into two flat work
  // lists — every directory to create, then every file to write — and drain each
  // through a single bounded pool. The previous three nested Promise.all layers
  // opened one handle per file across the whole scope at once, which could
  // exhaust the process's file-descriptor limit (EMFILE) on a large scope.
  const dirTasks: string[] = [];
  const fileTasks: Array<() => Promise<void>> = [];

  for (const tableName of tableNames) {
    assertSafePathComponent(tableName, "table name");
    const tablePath = path.join(sourcePath, tableName);
    const { records } = tables[tableName];
    const recKeys = Object.keys(records);

    if (flat) {
      // DX17: flat layout writes every field file directly under the table
      // directory as `<record>~<field>.<ext>`, so there are no per-record folders.
      let tableHasFiles = false;
      for (const recKey of recKeys) {
        const rec = records[recKey];
        // rec.name still flows into the flat file stem (`<record>~<field>`), so
        // an embedded separator would re-introduce a subpath — validate it here
        // too, not only in the nested layout.
        assertSafePathComponent(rec.name, "record name");
        for (const file of rec.files) {
          assertSafeFileComponents(file);
          if (routeToDocument(tableName, rec.name, file)) continue;
          if (compositeTables.has(tableName) && isMetaFile(file)) continue;
          tableHasFiles = true;
          fileTasks.push(() =>
            fUtils.writeFlatSNFileCurry(!forceWrite)(file, tablePath, rec.name)
          );
        }
      }
      // A composite table whose records carry nothing but metadata gets no
      // directory: its sidecars all live in the data-model documents.
      if (tableHasFiles || !compositeTables.has(tableName)) dirTasks.push(tablePath);
    } else {
      for (const recKey of recKeys) {
        const rec = records[recKey];
        assertSafePathComponent(rec.name, "record name");
        const recPath = path.join(tablePath, rec.name);
        let recordHasFiles = false;
        for (const file of rec.files) {
          assertSafeFileComponents(file);
          if (routeToDocument(tableName, rec.name, file)) continue;
          if (compositeTables.has(tableName) && isMetaFile(file)) continue;
          recordHasFiles = true;
          fileTasks.push(() =>
            fUtils.writeSNFileCurry(!forceWrite)(file, recPath)
          );
        }
        if (recordHasFiles || !compositeTables.has(tableName)) dirTasks.push(recPath);
      }
    }
  }

  // Both layout checks run before anything is written, so a refused pull
  // leaves the workspace as it was.
  await assertNoCompositeEntries(sourcePath, recordsLayoutSidecars);
  await assertNoPerRecordSidecars(sourcePath, compositeWrites, flat);

  // Every directory must exist before its files are written, so drain the dir
  // pool to completion first, then the file pool.
  await mapWithConcurrency(dirTasks, concurrency, (dir) =>
    fUtils.createDirRecursively(dir)
  );
  await mapWithConcurrency(fileTasks, concurrency, (task) => task());
  await mergeCompositeWrites(sourcePath, compositeWrites, { force: forceWrite, flat });

  // Side effect (unchanged): strip content from every file so the follow-up
  // manifest write doesn't persist file bodies. Done after all writes finish so
  // the write closures above still observe the content.
  for (const tableName of tableNames) {
    for (const rec of Object.values(tables[tableName].records)) {
      rec.files.forEach((file) => {
        delete file.content;
      });
    }
  }
};

/**
 * Gives a freshly fetched manifest its folder names (recordFolderNames) and, on
 * an existing checkout, moves the folders the naming rules renamed. The scoped
 * endpoint names records by display value alone, so without this two records
 * whose names collide on disk would share — and overwrite — one folder. In
 * place, and a no-op on a manifest already named by these rules.
 */
export const adoptRecordFolderNames = async (
  previous: SN.AppManifest | undefined,
  next: SN.AppManifest
): Promise<void> => {
  assignManifestFolderNames(next);
  if (!previous) return;
  try {
    await migrateRenamedRecordFolders(
      previous,
      next,
      ConfigManager.getSourcePath(),
      ConfigManager.getConfig().flat === true
    );
  } catch (e) {
    logger.warn(
      `Could not move renamed record folders: ${e instanceof Error ? e.message : String(e)}`
    );
  }
};

// The manifest on disk before this run, if the directory has one.
const loadPreviousManifest = async (): Promise<SN.AppManifest | undefined> => {
  try {
    return (await ConfigManager.getManifest()) ?? undefined;
  } catch {
    return undefined;
  }
};

export const processManifest = async (
  manifest: SN.AppManifest,
  forceWrite = false
): Promise<void> => {
  await adoptRecordFolderNames(await loadPreviousManifest(), manifest);
  await processTablesInManifest(manifest.tables, forceWrite);
  await fUtils.writeFileForce(
    ConfigManager.getManifestPath(),
    JSON.stringify(manifest, null, 2)
  );
};

/**
 * Applies the record-level secret rule (META_RECORD_SECRET_RULES) to a manifest
 * that ARRIVED WITH CONTENT — `init`'s scoped-endpoint answer — before it is
 * written. The scoped endpoint returns `sys_properties.value` whatever the
 * property's type, and its rows carry no classifier column to judge them by.
 *
 * Same mechanism as refresh and download (createTableFetcher): the governed
 * columns are re-read through buildBulkDownloadFromTableAPI, which selects the
 * classifier with each row and withholds the value of a password-typed or
 * unclassifiable record. The endpoint's content for those columns is discarded
 * in every case; a record the Table API did not return keeps its manifest entry
 * with no content, which the writer turns into no file at all. The manifest
 * still LISTS the column, exactly as a refresh from the same endpoint does.
 *
 * Mutates `manifest` in place; a manifest without a governed column costs no
 * request.
 */
export const applyRecordSecretRulesToContent = async (
  manifest: SN.AppManifest,
  client: SNClient,
  tableOptions: Sync.ITableOptionsMap
): Promise<void> => {
  const requested: SN.MissingFileTableMap = Object.create(null);
  for (const [table, tableConfig] of Object.entries(manifest.tables ?? {})) {
    for (const record of Object.values(tableConfig.records ?? {})) {
      const governed = (record.files ?? []).filter(
        (file) => classifyColumn(table, file.name) === "secret"
      );
      if (governed.length === 0) continue;
      for (const file of governed) {
        delete file.content;
      }
      if (!requested[table]) requested[table] = Object.create(null);
      requested[table][record.sys_id] = governed.map(({ name, type }) => ({ name, type }));
    }
  }
  if (isEmptyMissingMap(requested)) {
    return;
  }

  const fetched = await buildBulkDownloadFromTableAPI(
    requested,
    client,
    tableOptions,
    buildManifestRecordNames(manifest)
  );
  const unread: string[] = [];
  let unreadTotal = 0;
  for (const table of Object.keys(requested)) {
    const fetchedBySysId = new Map<string, SN.File[]>();
    for (const record of Object.values(fetched[table]?.records ?? {})) {
      fetchedBySysId.set(record.sys_id, record.files ?? []);
    }
    let unreadInTable = 0;
    for (const record of Object.values(manifest.tables[table].records)) {
      const values = fetchedBySysId.get(record.sys_id);
      if (!values) {
        if (requested[table][record.sys_id]) unreadInTable += 1;
        continue;
      }
      for (const file of record.files ?? []) {
        const value = values.find((candidate) => candidate.name === file.name);
        if (value && "content" in value) {
          file.content = value.content;
        }
      }
    }
    if (unreadInTable > 0) {
      unread.push(`${unreadInTable} in ${table}`);
      unreadTotal += unreadInTable;
    }
  }
  if (unread.length > 0) {
    // A 200 with fewer rows than asked for (a row-level read ACL, a record
    // deleted mid-run) leaves those records with no content, so init writes no
    // value file for them. That is the safe outcome, not a silent one.
    logger.warn(
      `Could not re-read the secret-governed value of ${unreadTotal} record(s) (${unread.join(", ")}) ` +
        "through the Table API — no value was written for them; `syncrona refresh` retries them."
    );
  }
};

// Returns true on success so callers (refresh/dev) can report the real outcome.
export const syncManifest = async (): Promise<boolean> => {
  try {
    const curManifest = await ConfigManager.getManifest();
    if (!curManifest) throw new Error("No manifest file loaded!");
    logger.info("Downloading fresh manifest...");
    const client = defaultClient();
    const config = ConfigManager.getConfig();

    // A manifest that already binds this scope by sys_id and lists no table is
    // what `init --new` writes for an application that owns nothing yet. For
    // that one shape an empty discovery is the truth, not a symptom of a wrong
    // scope or missing access, so the empty-manifest refusal is lifted. A
    // manifest without a scopeId, or one that lists tables, keeps the refusal:
    // emptying a previously populated manifest on a flaky read would make
    // `repair --prune` treat every local file as an orphan.
    const bindsEmptyScope =
      typeof curManifest.scopeId === "string" &&
      curManifest.scopeId.length > 0 &&
      Object.keys(curManifest.tables ?? {}).length === 0;

    let newManifest: SN.AppManifest;
    // Tracked rather than inferred from the result: only the scoped answer needs
    // enriching, and running the dictionary sweep over a Table-API build would
    // re-query every table it already decided has no metadata columns.
    let fromScopedEndpoint = true;
    try {
      newManifest = await unwrapSNResponse(
        client.getManifest(curManifest.scope, config)
      );
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — building manifest from Table API...");
        fromScopedEndpoint = false;
        newManifest = await buildManifestFromTableAPI(
          curManifest.scope,
          client,
          config,
          { allowEmpty: bindsEmptyScope }
        );
      } else {
        throw e;
      }
    }
    if (fromScopedEndpoint) {
      // The scoped endpoint lists an included column whatever its dictionary
      // type, and processMissingFiles would then ask it for the value. Filtered
      // before the manifest is written, so the request never names the column.
      await applyIncludeTypeRulesToManifest(newManifest, client, config);
      // DX22: the companion scoped app answers without a metadata layer, so
      // refresh used to write `.meta.json` only on the fallback path — that is,
      // only on instances WITHOUT the app the docs tell you to install.
      await attachMetaFieldsToManifest(newManifest, client, config);
    }

    // Neither the scoped endpoint nor the Table API build records the scope's
    // sys_id, so a refresh would silently drop the one `init --new` wrote (and
    // `push --create` would go back to looking it up). It is the same scope, so
    // its sys_id carries over.
    if (!newManifest.scopeId && curManifest.scopeId && newManifest.scope === curManifest.scope) {
      newManifest = { ...newManifest, scopeId: curManifest.scopeId };
    }

    if (bindsEmptyScope && Object.keys(newManifest.tables ?? {}).length === 0) {
      logger.info(
        `Scope "${newManifest.scope}" owns no records yet — keeping the empty manifest.`
      );
    }

    // Before the manifest is written: the missing-file probe below must look
    // for each record at its new folder, and an existing checkout's renamed
    // folders must already be there so nothing is downloaded twice.
    await adoptRecordFolderNames(curManifest, newManifest);
    // 17c: after the folders moved, so each record is looked up where it now
    // lives. A field the new manifest dropped keeps its file; say so, once.
    await warnWithdrawnFieldFiles(curManifest, newManifest, () => ({
      sourcePath: ConfigManager.getSourcePath(),
      flat: config.flat === true,
    }));

    logger.info("Writing new manifest file...");
    await fUtils.writeManifestFile(newManifest);

    logger.info("Finding and creating missing files...");
    const incompleteTables = await processMissingFiles(newManifest);
    // The manifest itself is fresh and valid, so persist it either way — the next
    // run then retries exactly the files this one could not fetch. But a run that
    // could not fetch every field is not a successful refresh.
    ConfigManager.updateManifest(newManifest);
    if (incompleteTables.length > 0) {
      logger.error(
        `Refresh incomplete: ${incompleteTables.length} table(s) could not be fully fetched: ${incompleteTables.join(
          ", "
        )}. Check read access for the named field(s) and re-run.`
      );
      return false;
    }
    return true;
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    logger.error("Encountered error while refreshing! ❌");
    logger.error(message.toString());
    return false;
  }
};

const markFileMissing = (missingObj: SN.MissingFileTableMap) => (
  table: string
) => (recordId: string) => (file: SN.File) => {
  if (!missingObj[table]) {
    // INJ-2: null-prototype sub-map so a manifest whose table key or sys_id is
    // "__proto__" cannot walk up to Object.prototype. With a plain {} the read
    // `missingObj["__proto__"]` returns Object.prototype (truthy, so no own slot
    // is created) and the subsequent `[recordId] = []` write lands on the shared
    // prototype — global prototype pollution. A null-proto object turns every key,
    // including "__proto__", into an ordinary own slot. (The parent `missingObj`
    // is likewise created null-proto by its owners.)
    missingObj[table] = Object.create(null);
  }
  if (!missingObj[table][recordId]) {
    missingObj[table][recordId] = [];
  }
  const { name, type } = file;
  missingObj[table][recordId].push({ name, type });
};
type MarkTableMissingFunc = ReturnType<typeof markFileMissing>;
type MarkRecordMissingFunc = ReturnType<MarkTableMissingFunc>;
type MarkFileMissingFunc = ReturnType<MarkRecordMissingFunc>;

const markRecordMissing = (
  record: SN.MetaRecord,
  missingFunc: MarkRecordMissingFunc
) => {
  record.files.forEach((file) => {
    missingFunc(record.sys_id)(file);
  });
};

const markTableMissing = (
  table: SN.TableConfig,
  tableName: string,
  missingFunc: MarkTableMissingFunc
) => {
  Object.keys(table.records).forEach((recName) => {
    markRecordMissing(table.records[recName], missingFunc(tableName));
  });
};

const checkFilesForMissing = async (
  // In folder mode this is the per-record directory; in flat mode it is the
  // table directory and the field lives under the flat `<record>~<field>` name.
  parentPath: string,
  files: SN.File[],
  missingFunc: MarkFileMissingFunc,
  flat: boolean,
  recordName?: string
) => {
  // PERF-4 (REV-97): bound the existence-probe fan-out so a record with many
  // field files can't open an unbounded number of stat handles at once.
  const checks = await mapWithConcurrency(
    files,
    resolveWriteConcurrency(),
    (file) => {
      // DX17: flat layout writes every field directly under the table directory
      // as `<record>~<field>.<ext>` (mirroring writeFlatSNFileCurry), so probe
      // for that exact file rather than a per-record folder. Report the missing
      // field with its ORIGINAL name so the re-download targets the right field.
      const probe: SN.File =
        flat && recordName !== undefined
          ? { ...file, name: `${recordName}${FLAT_FIELD_SEPARATOR}${file.name}` }
          : file;
      return fUtils.SNFileExists(parentPath)(probe);
    }
  );
  checks.forEach((check, index) => {
    if (!check) {
      missingFunc(files[index]);
    }
  });
};

const checkRecordsForMissing = async (
  tablePath: string,
  records: SN.TableConfigRecords,
  missingFunc: MarkRecordMissingFunc,
  flat: boolean
) => {
  const recNames = Object.keys(records);

  if (flat) {
    // Flat layout has no per-record directory — probing pathExists on one would
    // report every record as missing and make `repair`/`refresh` re-download the
    // entire scope on every run. Check each field file directly under the table
    // directory instead.
    // PERF-4 (REV-97): bound the per-record fan-out under a flat table directory.
    await mapWithConcurrency(recNames, resolveWriteConcurrency(), (recName) => {
      const record = records[recName];
      return checkFilesForMissing(
        tablePath,
        record.files,
        missingFunc(record.sys_id),
        true,
        record.name
      );
    });
    return;
  }

  // Probe the directory the WRITER uses, which is `rec.name` — not the manifest
  // key. The two are the same in a manifest this CLI produced (getRecordsForTable
  // stores each record under its own name), but nothing enforces it for a
  // hand-edited or foreign manifest, and the flat branch above already reads
  // `record.name`. Where they diverged the record was permanently stuck: the probe
  // found no directory at the key, so every run re-downloaded the record, the
  // writer put it back under `rec.name`, and `repair --prune` then deleted that
  // file as an orphan (getFileContextFromPath resolves a path by the key). Falling
  // back to the key keeps a record whose `name` a manifest omitted probeable.
  const recPaths = recNames.map((recName) =>
    fUtils.appendToPath(tablePath)(records[recName]?.name || recName)
  );
  // PERF-4 (REV-97): bound the directory-existence probe fan-out across records.
  const concurrency = resolveWriteConcurrency();
  const checks = await mapWithConcurrency(
    recNames,
    concurrency,
    (_recName, index) => fUtils.pathExists(recPaths[index])
  );
  await mapWithConcurrency(checks, concurrency, async (check, index) => {
    const recName = recNames[index];
    const record = records[recName];
    if (!check) {
      markRecordMissing(record, missingFunc);
      return;
    }
    await checkFilesForMissing(
      recPaths[index],
      record.files,
      missingFunc(record.sys_id),
      false
    );
  });
};

const checkTablesForMissing = async (
  topPath: string,
  tables: SN.TableMap,
  missingFunc: MarkTableMissingFunc,
  flat: boolean
) => {
  const tableNames = Object.keys(tables);
  const tablePaths = tableNames.map(fUtils.appendToPath(topPath));
  // PERF-4 (REV-97): bound the table-directory existence probe fan-out.
  const concurrency = resolveWriteConcurrency();
  const checks = await mapWithConcurrency(
    tableNames,
    concurrency,
    (_tableName, index) => fUtils.pathExists(tablePaths[index])
  );

  await mapWithConcurrency(checks, concurrency, async (check, index) => {
    const tableName = tableNames[index];
    if (!check) {
      markTableMissing(tables[tableName], tableName, missingFunc);
      return;
    }
    await checkRecordsForMissing(
      tablePaths[index],
      tables[tableName].records,
      missingFunc(tableName),
      flat
    );
  });
};

export const findMissingFiles = async (
  manifest: SN.AppManifest
): Promise<SN.MissingFileTableMap> => {
  // INJ-2: null-proto root so a "__proto__" table key stays an own slot (see markFileMissing).
  const missing: SN.MissingFileTableMap = Object.create(null);
  const { tables } = manifest;
  // DX17: honor flat layout so a consistent flat workspace isn't misreported as
  // entirely missing. Read straight off the loaded config, matching the write path.
  const flat = ConfigManager.getConfig().flat === true;
  const missingTableFunc = markFileMissing(missing);
  await checkTablesForMissing(
    ConfigManager.getSourcePath(),
    tables,
    missingTableFunc,
    flat
  );
  await reconcileCompositeMissing(missing, tables, missingTableFunc);
  // missing gets mutated along the way as things get processed. A field file
  // listed under a dot-walked name is never fetched (withoutDotWalkedFieldFiles),
  // so it is not reported missing either.
  return withoutDotWalkedFieldFiles(missing);
};

// SDK-F2: under dataModelLayout "composite" the sidecar of a sys_db_object,
// sys_dictionary or sys_choice record is present when a data-model document
// holds its entry — the per-record probe above cannot see that, and would
// otherwise report every such sidecar missing on every refresh.
const reconcileCompositeMissing = async (
  missing: SN.MissingFileTableMap,
  tables: SN.TableMap,
  markTable: MarkTableMissingFunc
): Promise<void> => {
  const compositeTables = getCompositeTables(ConfigManager.getConfig());
  if (compositeTables.length === 0) return;
  const index = await loadCompositeIndex(ConfigManager.getSourcePath());
  for (const table of compositeTables) {
    const tableConfig = Object.prototype.hasOwnProperty.call(tables, table)
      ? tables[table]
      : undefined;
    if (!tableConfig) continue;
    for (const [recordKey, record] of Object.entries(tableConfig.records)) {
      const meta = record.files.find((file) => isMetaFile(file));
      if (!meta) continue;
      const recordName = record.name || recordKey;
      const held = index.has(compositeIndexKey(table, recordName));
      const listed = missing[table]?.[record.sys_id];
      const listedMeta = listed?.some((file) => isMetaFile(file)) === true;
      if (held && listed && listedMeta) {
        const rest = listed.filter((file) => !isMetaFile(file));
        if (rest.length > 0) {
          missing[table][record.sys_id] = rest;
        } else {
          delete missing[table][record.sys_id];
          if (Object.keys(missing[table]).length === 0) delete missing[table];
        }
      } else if (!held && !listedMeta) {
        markTable(table)(record.sys_id)(meta);
      }
    }
  }
};

// The manifest's own record names (table -> sys_id -> name). processTablesInManifest
// writes each record at `<table>/<rec.name>` and checkRecordsForMissing probes the
// manifest key, so the Table-API download path must reuse these names instead of
// deriving its own — see the parity note in buildBulkDownloadFromTableAPI.
export const buildManifestRecordNames = (
  manifest: SN.AppManifest
): ManifestRecordNames => {
  // INJ-2: null-proto at both levels, matching buildFullMissingMap — a crafted
  // manifest whose table key or sys_id is "__proto__" must stay an own slot.
  const names: ManifestRecordNames = Object.create(null);
  for (const [tableName, tableConfig] of Object.entries(manifest.tables)) {
    const bySysId: Record<string, string> = Object.create(null);
    for (const [recordKey, record] of Object.entries(tableConfig.records)) {
      // The key and record.name are written identically by every manifest
      // producer; prefer the name (it is what the writer joins onto the path)
      // and fall back to the key for a hand-edited manifest missing one.
      bySysId[record.sys_id] = record.name || recordKey;
    }
    names[tableName] = bySysId;
  }
  return names;
};

// DX22: the manifest's sidecar columns per table (table -> metaFields). Read off
// the manifest rather than re-derived, because the download side holds only the
// missing subset and never queries the dictionary. A manifest from the scoped
// endpoint arrives without them and is enriched by attachMetaFieldsToManifest
// before it reaches here; an empty map therefore means the layer is genuinely
// off (`meta: false`, or no metadata columns on any table), not merely unbuilt.
export const buildManifestMetaFields = (
  manifest: SN.AppManifest
): ManifestMetaFields => {
  // INJ-2: null-proto for the same reason as buildManifestRecordNames.
  const metaFields: ManifestMetaFields = Object.create(null);
  for (const [tableName, tableConfig] of Object.entries(manifest.tables)) {
    const fields = tableConfig.metaFields;
    if (Array.isArray(fields) && fields.length > 0) {
      metaFields[tableName] = fields;
    }
  }
  return metaFields;
};

/**
 * DX22: split a missing-file request into the half the scoped bulk endpoint can
 * serve and the sidecar half it cannot.
 *
 * `.meta` names no column. The scoped app projects the requested names straight
 * onto a GlideRecord, so asking it for the sidecar yields a record with no
 * content for it — no file is written, and the next run finds the same record
 * missing again. Only buildBulkDownloadFromTableAPI knows how to read the
 * sidecar's columns and serialize them, so the two halves take different routes
 * and are merged back together for the writer.
 */
const partitionMetaRequests = (
  missing: SN.MissingFileTableMap
): { files: SN.MissingFileTableMap; meta: SN.MissingFileTableMap } => {
  // INJ-2: null-proto at both levels, as everywhere a table name or sys_id from
  // the manifest becomes a key (see markFileMissing).
  const files: SN.MissingFileTableMap = Object.create(null);
  const meta: SN.MissingFileTableMap = Object.create(null);
  for (const [tableName, recordMap] of Object.entries(missing)) {
    for (const [sysId, requested] of Object.entries(recordMap || {})) {
      const plain = (requested || []).filter((file) => !isMetaFile(file));
      const sidecar = (requested || []).filter((file) => isMetaFile(file));
      if (plain.length > 0) {
        if (!files[tableName]) files[tableName] = Object.create(null);
        files[tableName][sysId] = plain;
      }
      if (sidecar.length > 0) {
        if (!meta[tableName]) meta[tableName] = Object.create(null);
        meta[tableName][sysId] = sidecar;
      }
    }
  }
  return { files, meta };
};

const isEmptyMissingMap = (missing: SN.MissingFileTableMap): boolean =>
  Object.keys(missing).length === 0;

// Merge the two halves of one table's fetch. Records are keyed by name and both
// halves describe the same records, so a collision is the expected case rather
// than a conflict: keep one entry and concatenate its files. Record names stay
// in parity because buildBulkDownloadFromTableAPI is given the manifest's own
// names (see ManifestRecordNames).
// INJ-2: null-proto at both levels, matching partitionMetaRequests above and
// buildManifestRecordNames. Table and record names are instance data — a record
// name is the display value of a row somebody created — and both the lookup and
// the assignment here went through the prototype chain. A record present only in
// `extra` (the ordinary upgrade shape: the script is already on disk, so only
// the sidecar is missing) whose name is `constructor` found Object itself as its
// `prior` and was merged into it, producing an entry with no sys_id and no name;
// one named `__proto__` hit the setter, so the assignment created no own slot
// and the record vanished from the merge entirely. Either way the sidecar was
// never written while refresh reported a clean run, and the next run found the
// same record missing again — a workspace that cannot converge.
const mergeTableMaps = (base: SN.TableMap, extra: SN.TableMap): SN.TableMap => {
  const merged: SN.TableMap = Object.assign(Object.create(null), base);
  for (const [tableName, table] of Object.entries(extra)) {
    const existing = merged[tableName];
    if (!existing) {
      merged[tableName] = table;
      continue;
    }
    const records: SN.TableConfigRecords = Object.assign(
      Object.create(null),
      existing.records
    );
    for (const [recordName, record] of Object.entries(table.records || {})) {
      const prior = records[recordName];
      records[recordName] = prior
        ? { ...prior, files: [...(prior.files || []), ...(record.files || [])] }
        : record;
    }
    merged[tableName] = { ...existing, records };
  }
  return merged;
};

/**
 * The fetch strategy shared by refresh (processMissingFiles) and download
 * (downloadAllFiles): scoped bulk endpoint for the file fields, Table API for
 * the DX22 sidecar, behind a single "the scoped endpoint is gone" latch so a
 * missing scoped app is probed once per run rather than once per table.
 */
const createTableFetcher = (
  client: SNClient,
  tableOptions: Sync.ITableOptionsMap,
  recordNames: ManifestRecordNames,
  metaFields: ManifestMetaFields,
  onFallback: () => void
) => {
  let scopedEndpointUnavailable = false;
  const viaTableAPI = (tableMissing: SN.MissingFileTableMap): Promise<SN.TableMap> =>
    buildBulkDownloadFromTableAPI(
      tableMissing,
      client,
      tableOptions,
      recordNames,
      metaFields
    );

  // R4: a table named by a composite rule (`nameFields`) never goes to the
  // scoped endpoint. That endpoint names records by their display value, so
  // its answer would land in a folder the manifest does not know; the Table
  // API path takes the manifest's own names.
  const forcedTables = Object.keys(tableOptions).filter((table) => {
    const nameFields = tableOptions[table]?.nameFields;
    return Array.isArray(nameFields) && nameFields.length > 0;
  });

  // A field file a record-level secret rule governs (`sys_properties.value`)
  // never goes to the scoped endpoint either: it returns the value whatever the
  // record's type, so a password property would be written to disk. The Table
  // API path reads the classifier with the row and withholds the value.
  const requestsSecretRuleColumn = (table: string, records: SN.MissingFileRecord): boolean =>
    Object.values(records ?? {}).some((files) =>
      (files ?? []).some((file) => classifyColumn(table, file.name) === "secret")
    );

  return async (requested: SN.MissingFileTableMap): Promise<SN.TableMap> => {
    if (scopedEndpointUnavailable) {
      return viaTableAPI(requested);
    }

    let forcedResult: SN.TableMap = {};
    let tableMissing = requested;
    const forced = Object.keys(requested).filter(
      (table) => forcedTables.includes(table) || requestsSecretRuleColumn(table, requested[table])
    );
    if (forced.length > 0) {
      const viaApi: SN.MissingFileTableMap = Object.create(null);
      tableMissing = Object.create(null);
      for (const [table, records] of Object.entries(requested)) {
        (forced.includes(table) ? viaApi : tableMissing)[table] = records;
      }
      forcedResult = await viaTableAPI(viaApi);
      if (isEmptyMissingMap(tableMissing)) {
        return forcedResult;
      }
    }

    const { files, meta } = partitionMetaRequests(tableMissing);
    // The sidecar half never goes to the scoped endpoint, even while it is
    // perfectly healthy — see partitionMetaRequests.
    const metaResult = isEmptyMissingMap(meta) ? {} : await viaTableAPI(meta);
    if (isEmptyMissingMap(files)) {
      return mergeTableMaps(forcedResult, metaResult);
    }

    try {
      // The scoped endpoint names what it returns by display value; re-key it
      // onto the manifest's folder names so a disambiguated record is written
      // at its own folder, not at the colliding one.
      const fileResult = applyManifestFolderNames(
        await unwrapSNResponse(client.getMissingFiles(files, tableOptions)),
        recordNames
      );
      return mergeTableMaps(forcedResult, mergeTableMaps(fileResult, metaResult));
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        onFallback();
        scopedEndpointUnavailable = true;
        return mergeTableMaps(
          forcedResult,
          mergeTableMaps(await viaTableAPI(files), metaResult)
        );
      }
      throw e;
    }
  };
};

// Returns the tables the instance could not fully supply, so refresh/repair can
// report an incomplete run instead of a clean one. An empty array means success.
export const processMissingFiles = async (
  newManifest: SN.AppManifest
): Promise<string[]> => {
  const missing = await findMissingFiles(newManifest);
  // DX21: surface how much work the refresh found (visible at --log-level debug).
  const missingRecords = Object.values(missing).reduce(
    (sum, recs) => sum + Object.keys(recs).length,
    0
  );
  logger.debug(
    `Refresh: ${missingRecords} missing record(s) across ${Object.keys(missing).length} table(s) to fetch.`
  );
  // R4: the effective options carry the data-model naming rule, so the Table
  // API fallback names a record exactly as the manifest build did.
  const tableOptions = applyDataModelTableOptions(ConfigManager.getConfig());
  const client = defaultClient();
  const recordNames = buildManifestRecordNames(newManifest);
  const metaFields = buildManifestMetaFields(newManifest);

  // PERF-3 (REV-91): stream the fetch/write one table at a time instead of
  // materializing every missing file body for the whole scope in memory at once.
  const fetchTable = createTableFetcher(
    client,
    tableOptions,
    recordNames,
    metaFields,
    () => logger.info("Custom scope not found — fetching missing files from Table API...")
  );

  const incompleteTables: string[] = [];

  for (const table of Object.keys(missing)) {
    const filesToProcess = await fetchTable({
      [table]: missing[table],
    } as SN.MissingFileTableMap);
    await processTablesInManifest(filesToProcess, false);

    // REV-140 applied to the refresh/repair path. downloadTablesWithResume
    // already refuses to checkpoint a table whose field the instance withheld,
    // but this loop wrote whatever came back and its callers reported success.
    // The withheld field's file is never created, so findMissingFiles reports the
    // same records missing on the next run: `refresh` and `repair --apply`
    // printed "complete ✅" over a workspace that can never converge. Name the
    // gap and let the caller decide the exit status.
    const unfetchedFields = collectUnfetchedFields(
      table,
      missing[table],
      filesToProcess[table]
    );
    if (unfetchedFields.length > 0) {
      incompleteTables.push(table);
      logger.warn(
        `Table ${table} is still missing field(s) ${unfetchedFields.join(
          ", "
        )} (no read access, or the instance returned no value) — the local file(s) were left untouched.`
      );
    }
  }

  return incompleteTables;
};

// Build a missing-file map that covers every file in the manifest, used to
// fetch full file contents for a fresh download.
export const buildFullMissingMap = (
  manifest: SN.AppManifest
): SN.MissingFileTableMap => {
  // INJ-2: null-proto at both levels so a "__proto__" table key or sys_id from a
  // crafted manifest cannot pollute Object.prototype (see markFileMissing).
  const missing: SN.MissingFileTableMap = Object.create(null);
  for (const [tableName, tableConfig] of Object.entries(manifest.tables)) {
    missing[tableName] = Object.create(null);
    for (const record of Object.values(tableConfig.records)) {
      missing[tableName][record.sys_id] = record.files.map((f) => ({
        name: f.name,
        type: f.type,
      }));
    }
  }
  // Same rule as findMissingFiles: no fetch path is asked for a dot-walked field.
  return withoutDotWalkedFieldFiles(missing);
};

// Stable digest of the work a download run has to do: every table, every
// sys_id and every field name it expects to fetch, in sorted order so the
// digest does not depend on key iteration order. Any manifest change that adds,
// removes or re-fields a record changes the digest and invalidates the
// checkpoint.
export const computeMissingFingerprint = (
  missing: SN.MissingFileTableMap
): string => {
  const parts = Object.keys(missing)
    .sort()
    .map((table) => {
      const records = Object.keys(missing[table])
        .sort()
        .map((sysId) => {
          const fields = (missing[table][sysId] || [])
            .map((file) => `${file.name}.${file.type}`)
            .sort()
            .join(",");
          return `${sysId}:${fields}`;
        })
        .join(";");
      return `${table}|${records}`;
    });
  return createHash("sha1").update(parts.join("\n")).digest("hex");
};

// REV-140: fields this run ASKED for that the instance did not return for a
// record it DID return. A column-level read ACL hides the field from the Table
// API response, and buildBulkDownloadFromTableAPI now omits the file entirely
// rather than fabricating an empty one (manifestBuilder.ts), so nothing is ever
// written for it. Honest limit: records the instance did not return at all are
// deliberately not judged here — a record deleted server-side between the
// manifest build and the download is not a field-level gap.
const collectUnfetchedFields = (
  table: string,
  requested: SN.MissingFileRecord | undefined,
  fetched: SN.TableConfig | undefined
): string[] => {
  // A column a record-level secret rule governs is withheld ON PURPOSE for a
  // password-typed record (buildBulkDownloadFromTableAPI reports that itself),
  // and its absence is indistinguishable from a read gap here. Counting it would
  // make every refresh of a workspace that lists a password property's value
  // report itself incomplete, forever.
  const returnedBySysId = new Map<string, Set<string>>();
  for (const record of Object.values(fetched?.records ?? {})) {
    returnedBySysId.set(
      record.sys_id,
      new Set((record.files ?? []).map((file) => file.name))
    );
  }

  const unfetched = new Set<string>();
  for (const [sysId, files] of Object.entries(requested ?? {})) {
    const returned = returnedBySysId.get(sysId);
    if (!returned) continue;
    for (const file of files ?? []) {
      // DX22: the sidecar is not a column, so "the instance did not return it"
      // is not a read-access gap. The scoped bulk endpoint never produces one,
      // and counting its absence here would make every refresh against an
      // instance that HAS that endpoint report itself incomplete forever.
      if (isMetaFile(file) || classifyColumn(table, file.name) === "secret") continue;
      if (!returned.has(file.name)) unfetched.add(file.name);
    }
  }
  return [...unfetched].sort();
};

// Injected dependencies for the resumable download loop, so the
// progress/checkpoint/skip logic can be tested without a network or the disk.
export interface DownloadTableDeps {
  /** Fetch the file contents for a single-table missing map. */
  fetchTable: (tableMissing: SN.MissingFileTableMap) => Promise<SN.TableMap>;
  /** Write a fetched table's files to disk. */
  writeTable: (files: SN.TableMap) => Promise<void>;
  readCheckpoint: (
    scope: string,
    fingerprint: string
  ) => Promise<DownloadCheckpoint | null>;
  writeCheckpoint: (checkpoint: DownloadCheckpoint) => Promise<void>;
  deleteCheckpoint: () => Promise<void>;
}

// G3: download one table at a time, recording each completed table in a
// checkpoint so an interrupted run resumes instead of starting over, and
// reporting per-table progress. On full success the checkpoint is cleared.
export const downloadTablesWithResume = async (
  missing: SN.MissingFileTableMap,
  scope: string,
  deps: DownloadTableDeps
): Promise<void> => {
  const allTables = Object.keys(missing);
  // DX21: report download volume so a slow pull is explainable.
  const totalRecords = allTables.reduce(
    (sum, table) => sum + Object.keys(missing[table]).length,
    0
  );

  // G3: the checkpoint is only valid for the work it was recorded against.
  // Keyed on the scope alone, a checkpoint written before a `refresh` added
  // records made the next download skip those tables as "already done", so the
  // new files were never fetched while the run still reported success.
  const fingerprint = computeMissingFingerprint(missing);
  const checkpoint = await deps.readCheckpoint(scope, fingerprint);
  const completed = new Set<string>(checkpoint?.completedTables ?? []);
  const pending = allTables.filter((table) => !completed.has(table));

  if (completed.size > 0) {
    logger.info(
      `Resuming download for ${scope}: ${completed.size} table(s) already done, ${pending.length} remaining.`
    );
  } else {
    logger.info(
      `Downloading ${totalRecords} record(s) across ${allTables.length} table(s)...`
    );
  }

  const failedTables: string[] = [];

  for (let i = 0; i < pending.length; i += 1) {
    const table = pending[i];
    const recordCount = Object.keys(missing[table]).length;
    logger.info(`  [${i + 1}/${pending.length}] ${table} (${recordCount} record(s))`);

    // A non-skippable error here propagates with the checkpoint intact, so the
    // next run resumes at this table instead of redoing the earlier ones.
    const files = await deps.fetchTable({
      [table]: missing[table],
    } as SN.MissingFileTableMap);
    await deps.writeTable(files);

    // A skippable 400/403/404 (e.g. Table-API ACL denial) leaves the table absent
    // from the fetched map — buildBulkDownloadFromTableAPI swallows it — so its
    // skeleton files stay empty. Marking it complete would checkpoint it as done,
    // delete the checkpoint on loop exit, and report a clean "Download complete"
    // over a partial pull. Instead record it as failed so the checkpoint survives
    // and the next run retries it.
    const fetchedRecordCount = Object.keys(files[table]?.records ?? {}).length;
    if (recordCount > 0 && fetchedRecordCount === 0) {
      failedTables.push(table);
      logger.warn(
        `  Table ${table} could not be downloaded (inaccessible or empty response) — its files are incomplete and it will be retried on the next run.`
      );
      continue;
    }

    // REV-140: the guard above only sees a table that returned NOTHING. A
    // column-level read ACL fails differently — the rows come back, only the
    // withheld field is absent, so its file is never fetched or written. This
    // completeness check counted records alone, so such a table was checkpointed
    // as done, the checkpoint was dropped on loop exit and the run printed
    // "Download complete" over files that were never downloaded. Treat a
    // field-level gap exactly like an inaccessible table: keep the checkpoint,
    // name the fields, and retry on the next run.
    const unfetchedFields = collectUnfetchedFields(table, missing[table], files[table]);
    if (unfetchedFields.length > 0) {
      failedTables.push(table);
      logger.warn(
        `  Table ${table} was downloaded without field(s) ${unfetchedFields.join(
          ", "
        )} (no read access, or the instance returned no value) — its files are incomplete and it will be retried on the next run.`
      );
      continue;
    }

    completed.add(table);
    await deps.writeCheckpoint({
      scope,
      fingerprint,
      completedTables: [...completed],
    });
  }

  if (failedTables.length > 0) {
    logger.error(
      `Download incomplete: ${failedTables.length} table(s) could not be fetched: ${failedTables.join(
        ", "
      )}. Re-run to retry — the completed tables are checkpointed.`
    );
    // Signal partial failure to the shell and KEEP the checkpoint so a rerun
    // resumes at the failed tables instead of redoing the whole scope.
    process.exitCode = 1;
    return;
  }

  await deps.deleteCheckpoint();
};

// Fetch and write the contents for every file in the manifest, one table at a
// time so progress is visible and an interrupted pull can resume (G3). Uses the
// bulk download endpoint per table, falling back to the Table API once the
// scoped endpoint is found to be unavailable.
export const downloadAllFiles = async (
  manifest: SN.AppManifest,
  instanceProfile?: string
): Promise<void> => {
  const missing = buildFullMissingMap(manifest);
  // R4: see processMissingFiles.
  const tableOptions = applyDataModelTableOptions(ConfigManager.getConfig());
  const client = defaultClient(instanceProfile);
  const recordNames = buildManifestRecordNames(manifest);
  const metaFields = buildManifestMetaFields(manifest);

  const fetchTable = createTableFetcher(
    client,
    tableOptions,
    recordNames,
    metaFields,
    () => logger.info("Custom scope not found — fetching files from Table API...")
  );

  await downloadTablesWithResume(missing, manifest.scope, {
    fetchTable,
    writeTable: (files) => processTablesInManifest(files, true),
    readCheckpoint: readDownloadCheckpoint,
    writeCheckpoint: writeDownloadCheckpoint,
    deleteCheckpoint: deleteDownloadCheckpoint,
  });
};
