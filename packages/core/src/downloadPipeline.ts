// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { createHash } from "crypto";
import path from "path";
import * as fUtils from "./FileUtils.js";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import * as ConfigManager from "./config.js";
import { defaultClient } from "./snClient.js";
import type { SNClient } from "./snClient.js";
import { withoutDotWalkedFieldFiles } from "./dotWalkedFieldFiles.js";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
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
import {
  isFlowPresetEnabled,
  isPlaybookPresetEnabled,
  isWorkflowPresetEnabled,
} from "./tablePresets.js";
import { unsafePathComponentReason } from "./genericUtils.js";
import {
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
  worker: (item: T, index: number) => Promise<R>,
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

// Default cap for filesystem-handle fan-out (writes, mkdirs and existence
// probes). Clamped to 1–50; an optional `writeConcurrency` config field can
// override it. 20 keeps a large scope well under typical descriptor limits
// (EMFILE) while staying parallel enough to be fast.
export const DEFAULT_WRITE_CONCURRENCY = 20;

export const resolveWriteConcurrency = (): number => {
  const candidate = (ConfigManager.getConfig() as { writeConcurrency?: unknown }).writeConcurrency;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_WRITE_CONCURRENCY;
  }
  return Math.min(Math.max(Math.floor(candidate), 1), 50);
};

// INJ-1: FOUR manifest-supplied strings reach path.join on the way to a local
// write — the table name (a key of the server- or manifest-supplied table map),
// the record name (a display value from the instance), and each file's
// `name` and `type`, which are interpolated together as `<name>.<type>`. A
// tampered manifest or a hostile Table API response can smuggle "..", ".",
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
// read-only probes (SNFileExists in scanRecordFields) still join manifest
// components without this check — a traversal there can only mis-report a file as
// present, and any manifest that could trigger it is rejected by this seam before
// a single byte is written.
//
// The predicate itself lives in genericUtils so every consumer that joins an
// instance-supplied name onto a local path uses the SAME rule (`init --ci`
// builds packages/<scope> directories from sys_app rows and used to skip this
// check entirely).
type UnsafeComponentKind = "table name" | "record name" | "field name" | "file type";

// What each component would escape if it were let through — table/record names
// leave the workspace entirely, per-file components leave only the record's own
// directory. Naming the right boundary keeps the error honest.
const CONTAINMENT_BOUNDARY: Record<UnsafeComponentKind, string> = {
  "table name": "the workspace source root",
  "record name": "the workspace source root",
  "field name": "its record's directory",
  "file type": "its record's directory",
};

const assertSafePathComponent = (component: string, kind: UnsafeComponentKind): void => {
  const unsafe = unsafePathComponentReason(component);
  if (unsafe) {
    // Only a traversal escapes anything; a control character or an overlong
    // segment is refused because no filesystem stores it as written.
    const consequence = unsafe.traversal ? ` and would escape ${CONTAINMENT_BOUNDARY[kind]}` : "";
    throw new Error(
      `Refusing to download: unsafe ${kind} ${JSON.stringify(component)}: ` +
        `${unsafe.reason}${consequence}.`,
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
export const processTablesInManifest = async (tables: SN.TableMap, forceWrite: boolean) => {
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
        compositeWrites.push({
          table: tableName,
          recordName,
          content: file.content,
        });
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
          fileTasks.push(() => fUtils.writeFlatSNFileCurry(!forceWrite)(file, tablePath, rec.name));
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
          fileTasks.push(() => fUtils.writeSNFileCurry(!forceWrite)(file, recPath));
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
  await mapWithConcurrency(dirTasks, concurrency, (dir) => fUtils.createDirRecursively(dir));
  await mapWithConcurrency(fileTasks, concurrency, (task) => task());
  await mergeCompositeWrites(sourcePath, compositeWrites, {
    force: forceWrite,
    flat,
  });

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
 * an existing checkout, moves the folders the naming rules renamed. Records are
 * named by display value, so without this two records whose names collide on
 * disk would share — and overwrite — one folder. In
 * place, and a no-op on a manifest already named by these rules.
 */
export const adoptRecordFolderNames = async (
  previous: SN.AppManifest | undefined,
  next: SN.AppManifest,
): Promise<void> => {
  assignManifestFolderNames(next);
  if (!previous) return;
  try {
    await migrateRenamedRecordFolders(
      previous,
      next,
      ConfigManager.getSourcePath(),
      ConfigManager.getConfig().flat === true,
    );
  } catch (e) {
    logger.warn(
      `Could not move renamed record folders: ${e instanceof Error ? e.message : String(e)}`,
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

/**
 * Lays a whole manifest out on disk — record folders adopted from the previous
 * manifest first, then every field file — and saves the manifest beside it.
 */
export const processManifest = async (
  manifest: SN.AppManifest,
  forceWrite = false,
): Promise<void> => {
  await adoptRecordFolderNames(await loadPreviousManifest(), manifest);
  await processTablesInManifest(manifest.tables, forceWrite);
  const manifestText = JSON.stringify(manifest, null, 2);
  await fUtils.writeFileForce(ConfigManager.getManifestPath(), manifestText);
};

/**
 * Fills the content of the columns the record-level secret rule
 * (META_RECORD_SECRET_RULES) governs — `sys_properties.value` — before `init`
 * writes a freshly built manifest.
 *
 * The manifest build lists such a column per record but never carries its
 * content, so the governed columns are re-read through
 * buildBulkDownloadFromTableAPI, the same reader refresh and download use: it
 * selects the classifier with each row and withholds the value of a
 * password-typed or unclassifiable record. A record the Table API did not
 * return keeps its manifest entry with no content, which the writer turns into
 * no file at all.
 *
 * Mutates `manifest` in place; a manifest without a governed column costs no
 * request.
 */
export const applyRecordSecretRulesToContent = async (
  manifest: SN.AppManifest,
  client: SNClient,
  tableOptions: Sync.ITableOptionsMap,
): Promise<void> => {
  const requested: SN.MissingFileTableMap = Object.create(null);
  for (const [table, tableConfig] of Object.entries(manifest.tables ?? {})) {
    for (const record of Object.values(tableConfig.records ?? {})) {
      const governed = (record.files ?? []).filter(
        (file) => classifyColumn(table, file.name) === "secret",
      );
      if (governed.length === 0) continue;
      for (const file of governed) {
        delete file.content;
      }
      if (!requested[table]) requested[table] = Object.create(null);
      requested[table][record.sys_id] = governed.map(({ name, type }) => ({
        name,
        type,
      }));
    }
  }
  if (Object.keys(requested).length === 0) {
    return;
  }

  const fetched = await buildBulkDownloadFromTableAPI(
    requested,
    client,
    tableOptions,
    buildManifestRecordNames(manifest),
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
        "through the Table API — no value was written for them; `syncrona refresh` retries them.",
    );
  }
};

// The manifest a refresh starts from; a refresh without one has nothing to refresh.
const requireCurrentManifest = async (): Promise<SN.AppManifest> => {
  const loaded = await ConfigManager.getManifest();
  if (!loaded) throw new Error("No manifest file loaded!");
  return loaded;
};

// Returns true on success so callers (refresh/dev) can report the real outcome.
export const syncManifest = async (): Promise<boolean> => {
  try {
    const curManifest = await requireCurrentManifest();
    logger.info("Downloading fresh manifest...");
    const [client, config] = [defaultClient(), ConfigManager.getConfig()];

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

    let newManifest = await buildManifestFromTableAPI(curManifest.scope, client, config, {
      allowEmpty: bindsEmptyScope,
    });
    // An empty build must still carry a `tables` key: the missing-file probe
    // iterates it right after the manifest is written.
    if (!newManifest.tables) {
      newManifest = { ...newManifest, tables: {} };
    }

    // The Table API build does not record the scope's
    // sys_id, so a refresh would silently drop the one `init --new` wrote (and
    // `push --create` would go back to looking it up). It is the same scope, so
    // its sys_id carries over.
    if (!newManifest.scopeId && curManifest.scopeId && newManifest.scope === curManifest.scope) {
      newManifest = { ...newManifest, scopeId: curManifest.scopeId };
    }

    if (bindsEmptyScope && Object.keys(newManifest.tables ?? {}).length === 0) {
      logger.info(`Scope "${newManifest.scope}" owns no records yet — keeping the empty manifest.`);
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
    // WP2: the `flow` preset's documents are rebuilt on every refresh. A flow
    // that could not be read fails the refresh the way a table does. Loaded only
    // when the preset is on, so the flow reader stays out of other runs.
    const flowsComplete = isFlowPresetEnabled(config)
      ? await (
          await import("./flow/flowFiles.js")
        ).syncFlowDocuments(client, newManifest.scope, ConfigManager.getSourcePath())
      : true;
    // WP2c: the `playbook` preset's documents, rebuilt and judged the same way.
    const playbooksComplete = isPlaybookPresetEnabled(config)
      ? await (
          await import("./flow/playbookFiles.js")
        ).syncPlaybookDocuments(client, newManifest.scope, ConfigManager.getSourcePath())
      : true;
    // WP2f: the `workflow` preset's documents, rebuilt and judged the same way.
    const workflowsComplete = isWorkflowPresetEnabled(config)
      ? await (
          await import("./flow/workflowFiles.js")
        ).syncWorkflowDocuments(client, newManifest.scope, ConfigManager.getSourcePath())
      : true;
    if (incompleteTables.length > 0) {
      logger.error(
        `Refresh incomplete: ${incompleteTables.length} table(s) could not be fully fetched: ${incompleteTables.join(
          ", ",
        )}. Check read access for the named field(s) and re-run.`,
      );
      return false;
    }
    return flowsComplete && playbooksComplete && workflowsComplete;
  } catch (failure) {
    // Refresh never throws to its caller: the failure is reported and the run
    // answers false, which the command turns into a non-zero exit.
    logger.error("Encountered error while refreshing! ❌");
    logger.error(failure instanceof Error ? failure.message : String(failure));
    return false;
  }
};

// ---------------------------------------------------------------------------
// Missing-file scan
// ---------------------------------------------------------------------------
//
// Walks the manifest top-down against the source tree and records every field
// with no local representation. A table or record whose directory is absent is
// recorded wholesale without probing its fields one by one.

/**
 * The scan's result being built: table -> sys_id -> fields to fetch. Only a
 * field's `name` and `type` are recorded, never its content.
 *
 * INJ-2: every level is a null-prototype map, so a manifest whose table key or
 * sys_id is "__proto__" cannot walk up to Object.prototype. With a plain {} the
 * read `entries["__proto__"]` returns Object.prototype (truthy, so no own slot
 * is created) and the following write lands on the shared prototype — global
 * prototype pollution. A null-proto object turns every key, including
 * "__proto__", into an ordinary own slot.
 */
interface MissingLedger {
  readonly entries: SN.MissingFileTableMap;
  field(table: string, sysId: string, file: SN.File): void;
  wholeRecord(table: string, record: SN.MetaRecord): void;
  wholeTable(table: string, tableConfig: SN.TableConfig): void;
}

const openMissingLedger = (): MissingLedger => {
  const entries: SN.MissingFileTableMap = Object.create(null);
  const field = (table: string, sysId: string, { name, type }: SN.File): void => {
    const byRecord = (entries[table] ??= Object.create(null) as Record<string, SN.File[]>);
    (byRecord[sysId] ??= []).push({ name, type });
  };
  const wholeRecord = (table: string, record: SN.MetaRecord): void => {
    for (const file of record.files) field(table, record.sys_id, file);
  };
  const wholeTable = (table: string, tableConfig: SN.TableConfig): void => {
    for (const key of Object.keys(tableConfig.records))
      wholeRecord(table, tableConfig.records[key]);
  };
  return { entries, field, wholeRecord, wholeTable };
};

// Probes each field of one record. `dir` is the record's own folder, or — in
// the DX17 flat layout — the table directory, where every field lives directly
// as `<record>~<field>.<ext>` (mirroring writeFlatSNFileCurry); `flatStem` is
// then the record name the probe prefixes. A missing field is recorded under
// its ORIGINAL name so the re-download targets the right column. Results are
// recorded in manifest order once every probe has answered.
const scanRecordFields = async (
  ledger: MissingLedger,
  table: string,
  record: SN.MetaRecord,
  dir: string,
  flatStem?: string,
): Promise<void> => {
  const probeOf = (file: SN.File): SN.File =>
    flatStem === undefined
      ? file
      : { ...file, name: `${flatStem}${FLAT_FIELD_SEPARATOR}${file.name}` };
  // PERF-4 (REV-97): the probe fan-out is bounded so a record with many field
  // files cannot open an unbounded number of stat handles at once.
  const onDisk = await mapWithConcurrency(record.files, resolveWriteConcurrency(), (file) =>
    fUtils.SNFileExists(dir)(probeOf(file)),
  );
  record.files.forEach((file, position) => {
    if (!onDisk[position]) ledger.field(table, record.sys_id, file);
  });
};

const scanTableRecords = async (
  ledger: MissingLedger,
  table: string,
  records: SN.TableConfigRecords,
  tableDir: string,
  flat: boolean,
): Promise<void> => {
  const keys = Object.keys(records);
  const width = resolveWriteConcurrency();
  if (flat) {
    // The flat layout has no per-record directory — probing one would report
    // every record missing and make `repair`/`refresh` re-download the entire
    // scope on every run — so each field file is probed under the table
    // directory itself.
    await mapWithConcurrency(keys, width, (key) =>
      scanRecordFields(ledger, table, records[key], tableDir, records[key].name),
    );
    return;
  }
  // The probed folder is the one the WRITER uses, `record.name`, not the
  // manifest key. The two agree in a manifest this CLI produced, but nothing
  // enforces it for a hand-edited or foreign manifest; where they diverged the
  // record was permanently stuck — never found at the key, re-downloaded under
  // its name on every run, then deleted as an orphan by `repair --prune`
  // (getFileContextFromPath resolves a path by the key). The key remains the
  // fallback for a record whose `name` the manifest omits.
  const folders = keys.map((key) => fUtils.appendToPath(tableDir)(records[key]?.name || key));
  const folderPresent = await mapWithConcurrency(folders, width, (folder) =>
    fUtils.pathExists(folder),
  );
  await mapWithConcurrency(keys, width, async (key, position) => {
    if (folderPresent[position]) {
      await scanRecordFields(ledger, table, records[key], folders[position]);
    } else {
      ledger.wholeRecord(table, records[key]);
    }
  });
};

const scanTables = async (
  ledger: MissingLedger,
  sourceRoot: string,
  tables: SN.TableMap,
  flat: boolean,
): Promise<void> => {
  const names = Object.keys(tables);
  const tableDirOf = fUtils.appendToPath(sourceRoot);
  const tableDirs = names.map((name) => tableDirOf(name));
  // PERF-4 (REV-97): table and record directory probes are bounded too.
  const width = resolveWriteConcurrency();
  const dirPresent = await mapWithConcurrency(tableDirs, width, (dir) => fUtils.pathExists(dir));
  await mapWithConcurrency(names, width, async (name, position) => {
    if (dirPresent[position]) {
      await scanTableRecords(ledger, name, tables[name].records, tableDirs[position], flat);
    } else {
      ledger.wholeTable(name, tables[name]);
    }
  });
};

/**
 * Every manifest field with no local file, as table -> sys_id -> fields. Fields
 * listed under a dot-walked name are left out: they are never fetched
 * (withoutDotWalkedFieldFiles), so they are never reported missing either.
 */
export const findMissingFiles = async (manifest: SN.AppManifest): Promise<SN.MissingFileTableMap> => {
  const ledger = openMissingLedger();
  // DX17: the layout comes straight off the loaded config, as on the write
  // path, so a consistent flat workspace is not misreported as entirely missing.
  const flat = ConfigManager.getConfig().flat === true;
  await scanTables(ledger, ConfigManager.getSourcePath(), manifest.tables, flat);
  await reconcileCompositeMissing(ledger, manifest.tables);
  return withoutDotWalkedFieldFiles(ledger.entries);
};

// SDK-F2: under dataModelLayout "composite" the sidecar of a sys_db_object,
// sys_dictionary or sys_choice record is present when a data-model document
// holds its entry — the per-record probe above cannot see that, and would
// otherwise report every such sidecar missing on every refresh.
const reconcileCompositeMissing = async (
  ledger: MissingLedger,
  tables: SN.TableMap,
): Promise<void> => {
  const missing = ledger.entries;
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
        ledger.field(table, record.sys_id, meta);
      }
    }
  }
};

// The manifest's own record names (table -> sys_id -> name). processTablesInManifest
// writes each record at `<table>/<rec.name>` and scanTableRecords probes the
// manifest key, so the Table-API download path must reuse these names instead of
// deriving its own — see the parity note in buildBulkDownloadFromTableAPI.
export const buildManifestRecordNames = (manifest: SN.AppManifest): ManifestRecordNames => {
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
// missing subset and never queries the dictionary. The Table API manifest build
// records them, so an empty map means the layer is genuinely off (`meta: false`,
// or no metadata columns on any table), not merely unbuilt.
export const buildManifestMetaFields = (manifest: SN.AppManifest): ManifestMetaFields => {
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

// Returns the tables the instance could not fully supply, so refresh/repair can
// report an incomplete run instead of a clean one. An empty array means success.
export const processMissingFiles = async (newManifest: SN.AppManifest): Promise<string[]> => {
  const missing = await findMissingFiles(newManifest);
  // DX21: surface how much work the refresh found (visible at --log-level debug).
  const missingRecords = Object.values(missing).reduce(
    (sum, recs) => sum + Object.keys(recs).length,
    0,
  );
  logger.debug(
    `Refresh: ${missingRecords} missing record(s) across ${Object.keys(missing).length} table(s) to fetch.`,
  );
  // R4: the effective options carry the data-model naming rule, so the Table
  // API fallback names a record exactly as the manifest build did.
  const tableOptions = applyDataModelTableOptions(ConfigManager.getConfig());
  const client = defaultClient();
  const recordNames = buildManifestRecordNames(newManifest);
  const metaFields = buildManifestMetaFields(newManifest);

  // PERF-3 (REV-91): stream the fetch/write one table at a time instead of
  // materializing every missing file body for the whole scope in memory at once.
  const fetchTable = (requested: SN.MissingFileTableMap): Promise<SN.TableMap> =>
    buildBulkDownloadFromTableAPI(requested, client, tableOptions, recordNames, metaFields);

  const incompleteTables: string[] = [];

  for (const table of Object.keys(missing)) {
    const filesToProcess = await fetchTable({
      [table]: missing[table],
    } as SN.MissingFileTableMap);
    await processTablesInManifest(filesToProcess, false);

    // A skippable 400/403/404 leaves the table out of the fetched map entirely,
    // and collectUnfetchedFields below only looks at records that did come back,
    // so a table the instance refused outright was reported as a clean refresh.
    // Same rule as downloadTablesWithResume: nothing fetched means incomplete.
    const fetchedRecordCount = Object.keys(filesToProcess[table]?.records ?? {}).length;
    if (Object.keys(missing[table]).length > 0 && fetchedRecordCount === 0) {
      incompleteTables.push(table);
      logger.warn(
        `Table ${table} could not be fetched (inaccessible or empty response) — its missing file(s) were not downloaded.`,
      );
      continue;
    }

    // REV-140 applied to the refresh/repair path. downloadTablesWithResume
    // already refuses to checkpoint a table whose field the instance withheld,
    // but this loop wrote whatever came back and its callers reported success.
    // The withheld field's file is never created, so findMissingFiles reports the
    // same records missing on the next run: `refresh` and `repair --apply`
    // printed "complete ✅" over a workspace that can never converge. Name the
    // gap and let the caller decide the exit status.
    const unfetchedFields = collectUnfetchedFields(table, missing[table], filesToProcess[table]);
    if (unfetchedFields.length > 0) {
      incompleteTables.push(table);
      logger.warn(
        `Table ${table} is still missing field(s) ${unfetchedFields.join(
          ", ",
        )} (no read access, or the instance returned no value) — the local file(s) were left untouched.`,
      );
    }
  }

  return incompleteTables;
};

// Build a missing-file map that covers every file in the manifest, used to
// fetch full file contents for a fresh download.
export const buildFullMissingMap = (manifest: SN.AppManifest): SN.MissingFileTableMap => {
  // INJ-2: null-proto at both levels so a "__proto__" table key or sys_id from a
  // crafted manifest cannot pollute Object.prototype (see MissingLedger).
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
export const computeMissingFingerprint = (missing: SN.MissingFileTableMap): string => {
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
  fetched: SN.TableConfig | undefined,
): string[] => {
  // A column a record-level secret rule governs is withheld ON PURPOSE for a
  // password-typed record (buildBulkDownloadFromTableAPI reports that itself),
  // and its absence is indistinguishable from a read gap here. Counting it would
  // make every refresh of a workspace that lists a password property's value
  // report itself incomplete, forever.
  const returnedBySysId = new Map<string, Set<string>>();
  for (const record of Object.values(fetched?.records ?? {})) {
    returnedBySysId.set(record.sys_id, new Set((record.files ?? []).map((file) => file.name)));
  }

  const unfetched = new Set<string>();
  for (const [sysId, files] of Object.entries(requested ?? {})) {
    const returned = returnedBySysId.get(sysId);
    if (!returned) continue;
    for (const file of files ?? []) {
      // DX22: the sidecar is not a column, so "the instance did not return it"
      // is not a read-access gap, and a withheld secret-rule value is withheld
      // on purpose; counting either here would make a refresh report itself
      // incomplete forever.
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
    fingerprint: string,
    instance?: string,
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
  deps: DownloadTableDeps,
  instance?: string,
): Promise<void> => {
  const allTables = Object.keys(missing);
  // DX21: report download volume so a slow pull is explainable.
  const totalRecords = allTables.reduce(
    (sum, table) => sum + Object.keys(missing[table]).length,
    0,
  );

  // G3: the checkpoint is only valid for the work it was recorded against.
  // Keyed on the scope alone, a checkpoint written before a `refresh` added
  // records made the next download skip those tables as "already done", so the
  // new files were never fetched while the run still reported success.
  const fingerprint = computeMissingFingerprint(missing);
  // The instance too: the same scope and manifest slice exist on every
  // instance, so a checkpoint from an interrupted pull of dev made a pull of
  // test skip the tables dev had already delivered.
  const checkpoint = await deps.readCheckpoint(scope, fingerprint, instance);
  const completed = new Set<string>(checkpoint?.completedTables ?? []);
  const pending = allTables.filter((table) => !completed.has(table));

  if (completed.size > 0) {
    logger.info(
      `Resuming download for ${scope}: ${completed.size} table(s) already done, ${pending.length} remaining.`,
    );
  } else {
    logger.info(`Downloading ${totalRecords} record(s) across ${allTables.length} table(s)...`);
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
        `  Table ${table} could not be downloaded (inaccessible or empty response) — its files are incomplete and it will be retried on the next run.`,
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
          ", ",
        )} (no read access, or the instance returned no value) — its files are incomplete and it will be retried on the next run.`,
      );
      continue;
    }

    completed.add(table);
    await deps.writeCheckpoint({
      scope,
      fingerprint,
      ...(instance !== undefined ? { instance } : {}),
      completedTables: [...completed],
    });
  }

  if (failedTables.length > 0) {
    logger.error(
      `Download incomplete: ${failedTables.length} table(s) could not be fetched: ${failedTables.join(
        ", ",
      )}. Re-run to retry — the completed tables are checkpointed.`,
    );
    // Signal partial failure to the shell and KEEP the checkpoint so a rerun
    // resumes at the failed tables instead of redoing the whole scope.
    process.exitCode = 1;
    return;
  }

  await deps.deleteCheckpoint();
};

// Fetch and write the contents for every file in the manifest, one table at a
// time so progress is visible and an interrupted pull can resume (G3). Each
// table is read through the Table API.
export const downloadAllFiles = async (
  manifest: SN.AppManifest,
  instanceProfile?: string,
  instance?: string,
): Promise<void> => {
  const missing = buildFullMissingMap(manifest);
  // R4: see processMissingFiles.
  const tableOptions = applyDataModelTableOptions(ConfigManager.getConfig());
  const client = defaultClient(instanceProfile);
  const recordNames = buildManifestRecordNames(manifest);
  const metaFields = buildManifestMetaFields(manifest);

  const fetchTable = (requested: SN.MissingFileTableMap): Promise<SN.TableMap> =>
    buildBulkDownloadFromTableAPI(requested, client, tableOptions, recordNames, metaFields);

  await downloadTablesWithResume(
    missing,
    manifest.scope,
    {
      fetchTable,
      writeTable: (files) => processTablesInManifest(files, true),
      readCheckpoint: readDownloadCheckpoint,
      writeCheckpoint: writeDownloadCheckpoint,
      deleteCheckpoint: deleteDownloadCheckpoint,
    },
    instance,
  );
};
