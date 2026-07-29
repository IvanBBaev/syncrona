// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import { createHash } from "crypto";
import path from "path";
import * as fUtils from "./FileUtils.js";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import * as ConfigManager from "./config.js";
import { defaultClient, unwrapSNResponse } from "./snClient.js";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
  isScopedEndpointUnavailableError,
  ManifestRecordNames,
} from "./manifestBuilder.js";
import { logger } from "./Logger.js";
import { isSafePathComponent } from "./genericUtils.js";
import {
  DownloadCheckpoint,
  readDownloadCheckpoint,
  writeDownloadCheckpoint,
  deleteDownloadCheckpoint,
} from "./downloadCheckpoint.js";

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

// INJ-1: table names (the keys of the server- or manifest-supplied table map)
// and record names (including scoped-endpoint `name` values) both flow into
// path.join under the workspace source root below. A tampered manifest or a
// hostile scoped-download response could smuggle "..", ".", an empty string, or
// an embedded path separator into a component and walk the write out of the
// source tree — a manifest-driven arbitrary-file-write. This seam is the single
// chokepoint every pull path (wizard, refresh, download) converges on, so
// rejecting an unsafe component here — loudly, before it ever reaches path.join,
// rather than silently rewriting it (which would mask a compromised source) —
// guarantees no write escapes regardless of what upstream produced. Legitimate
// names never trip this: buildRecordName already strips separators and falls
// back to sys_id for empty/all-dot names, and ServiceNow table names are plain
// identifiers.
// The predicate itself lives in genericUtils so every consumer that joins an
// instance-supplied name onto a local path uses the SAME rule (`init --ci`
// builds packages/<scope> directories from sys_app rows and used to skip this
// check entirely).
const assertSafePathComponent = (
  component: string,
  kind: "table name" | "record name"
): void => {
  if (!isSafePathComponent(component)) {
    throw new Error(
      `Refusing to download: unsafe ${kind} ${JSON.stringify(component)} ` +
        `would escape the workspace source root.`
    );
  }
};

// Two records whose names differ only by case or Unicode normal form occupy the
// SAME path on macOS/Windows volumes, so one silently overwrites the other's
// files and a later push uploads the wrong content. The Table-API builder now
// disambiguates such names, but a manifest produced by the scoped endpoint is
// server-owned and cannot be renamed here — so at least make the collision
// visible instead of letting it surface as mysteriously missing content.
const warnOnRecordNameCollisions = (
  tableName: string,
  records: Record<string, { name: string }>
): void => {
  const seen = new Map<string, string>();
  for (const rec of Object.values(records)) {
    const name = String(rec?.name ?? "");
    const normalized = name.normalize("NFC").toLowerCase();
    const prior = seen.get(normalized);
    if (prior !== undefined && prior !== name) {
      logger.warn(
        `Record name collision in ${tableName}: "${name}" and "${prior}" resolve to the same path on case-insensitive or Unicode-normalizing filesystems; one will overwrite the other.`
      );
    }
    seen.set(normalized, name);
  }
};

// Shared by processManifest, processMissingFiles and downloadAllFiles — the
// single seam that governs every pull path (wizard, refresh and download).
export const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean
) => {
  // DX17: read flat mode straight off the loaded config (not getFlatMode()) so
  // this single seam governs every pull path — wizard, refresh and download.
  const flat = ConfigManager.getConfig().flat === true;
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
    warnOnRecordNameCollisions(tableName, records);

    if (flat) {
      // DX17: flat layout writes every field file directly under the table
      // directory as `<record>~<field>.<ext>`, so there are no per-record folders.
      dirTasks.push(tablePath);
      for (const recKey of recKeys) {
        const rec = records[recKey];
        // rec.name still flows into the flat file stem (`<record>~<field>`), so
        // an embedded separator would re-introduce a subpath — validate it here
        // too, not only in the nested layout.
        assertSafePathComponent(rec.name, "record name");
        for (const file of rec.files) {
          fileTasks.push(() =>
            fUtils.writeFlatSNFileCurry(!forceWrite)(file, tablePath, rec.name)
          );
        }
      }
    } else {
      for (const recKey of recKeys) {
        const rec = records[recKey];
        assertSafePathComponent(rec.name, "record name");
        const recPath = path.join(tablePath, rec.name);
        dirTasks.push(recPath);
        for (const file of rec.files) {
          fileTasks.push(() =>
            fUtils.writeSNFileCurry(!forceWrite)(file, recPath)
          );
        }
      }
    }
  }

  // Every directory must exist before its files are written, so drain the dir
  // pool to completion first, then the file pool.
  await mapWithConcurrency(dirTasks, concurrency, (dir) =>
    fUtils.createDirRecursively(dir)
  );
  await mapWithConcurrency(fileTasks, concurrency, (task) => task());

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

export const processManifest = async (
  manifest: SN.AppManifest,
  forceWrite = false
): Promise<void> => {
  await processTablesInManifest(manifest.tables, forceWrite);
  await fUtils.writeFileForce(
    ConfigManager.getManifestPath(),
    JSON.stringify(manifest, null, 2)
  );
};

// Returns true on success so callers (refresh/dev) can report the real outcome.
export const syncManifest = async (): Promise<boolean> => {
  try {
    const curManifest = await ConfigManager.getManifest();
    if (!curManifest) throw new Error("No manifest file loaded!");
    logger.info("Downloading fresh manifest...");
    const client = defaultClient();
    const config = ConfigManager.getConfig();

    let newManifest: SN.AppManifest;
    try {
      newManifest = await unwrapSNResponse(
        client.getManifest(curManifest.scope, config)
      );
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — building manifest from Table API...");
        newManifest = await buildManifestFromTableAPI(
          curManifest.scope,
          client,
          config
        );
      } else {
        throw e;
      }
    }

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

  const recPaths = recNames.map(fUtils.appendToPath(tablePath));
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
  // missing gets mutated along the way as things get processed
  return missing;
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
  const { tableOptions = {} } = ConfigManager.getConfig();
  const client = defaultClient();
  const recordNames = buildManifestRecordNames(newManifest);

  // PERF-3 (REV-91): stream the fetch/write one table at a time instead of
  // materializing every missing file body for the whole scope in memory at once.
  // Probe the scoped bulk endpoint once; after the first "unavailable" go
  // straight to the Table API for the remaining tables — mirroring the fetchTable
  // closure in downloadAllFiles so refresh keeps only one table's bodies live.
  let scopedEndpointUnavailable = false;
  const fetchTable = async (
    tableMissing: SN.MissingFileTableMap
  ): Promise<SN.TableMap> => {
    if (scopedEndpointUnavailable) {
      return buildBulkDownloadFromTableAPI(
        tableMissing,
        client,
        tableOptions,
        recordNames
      );
    }
    try {
      return await unwrapSNResponse(
        client.getMissingFiles(tableMissing, tableOptions)
      );
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — fetching missing files from Table API...");
        scopedEndpointUnavailable = true;
        return buildBulkDownloadFromTableAPI(
          tableMissing,
          client,
          tableOptions,
          recordNames
        );
      }
      throw e;
    }
  };

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
  return missing;
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
  requested: SN.MissingFileRecord | undefined,
  fetched: SN.TableConfig | undefined
): string[] => {
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
    const unfetchedFields = collectUnfetchedFields(missing[table], files[table]);
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
  const { tableOptions = {} } = ConfigManager.getConfig();
  const client = defaultClient(instanceProfile);
  const recordNames = buildManifestRecordNames(manifest);

  // Probe the scoped endpoint once; after the first "unavailable" go straight to
  // the Table API for the remaining tables instead of re-probing each time.
  let scopedEndpointUnavailable = false;
  const fetchTable = async (
    tableMissing: SN.MissingFileTableMap
  ): Promise<SN.TableMap> => {
    if (scopedEndpointUnavailable) {
      return buildBulkDownloadFromTableAPI(
        tableMissing,
        client,
        tableOptions,
        recordNames
      );
    }
    try {
      return await unwrapSNResponse(
        client.getMissingFiles(tableMissing, tableOptions)
      );
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — fetching files from Table API...");
        scopedEndpointUnavailable = true;
        return buildBulkDownloadFromTableAPI(
          tableMissing,
          client,
          tableOptions,
          recordNames
        );
      }
      throw e;
    }
  };

  await downloadTablesWithResume(missing, manifest.scope, {
    fetchTable,
    writeTable: (files) => processTablesInManifest(files, true),
    readCheckpoint: readDownloadCheckpoint,
    writeCheckpoint: writeDownloadCheckpoint,
    deleteCheckpoint: deleteDownloadCheckpoint,
  });
};
