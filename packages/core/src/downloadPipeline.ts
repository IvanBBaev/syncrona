// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncro-now-ai/types";
import path from "path";
import * as fUtils from "./FileUtils.js";
import * as ConfigManager from "./config.js";
import { defaultClient, unwrapSNResponse } from "./snClient.js";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
  isScopedEndpointUnavailableError,
} from "./manifestBuilder.js";
import { logger } from "./Logger.js";
import {
  DownloadCheckpoint,
  readDownloadCheckpoint,
  writeDownloadCheckpoint,
  deleteDownloadCheckpoint,
} from "./downloadCheckpoint.js";

const processFilesInManRec = async (
  // In folder mode this is the per-record directory; in flat mode it is the
  // table directory and the record name is encoded into each file name (DX17).
  dirPath: string,
  rec: SN.MetaRecord,
  forceWrite: boolean,
  flat: boolean
) => {
  const fileWrite = flat
    ? (file: SN.File) =>
        fUtils.writeFlatSNFileCurry(!forceWrite)(file, dirPath, rec.name)
    : (file: SN.File) => fUtils.writeSNFileCurry(!forceWrite)(file, dirPath);
  const filePromises = rec.files.map(fileWrite);
  await Promise.all(filePromises);
  // Side effect, remove content from files so it doesn't get written to manifest
  rec.files.forEach((file) => {
    delete file.content;
  });
};

const processRecsInManTable = async (
  tablePath: string,
  table: SN.TableConfig,
  forceWrite: boolean,
  flat: boolean
) => {
  const { records } = table;
  const recKeys = Object.keys(records);

  if (flat) {
    // DX17: flat layout writes every field file directly under the table
    // directory as `<record>~<field>.<ext>`, so there are no per-record folders.
    await fUtils.createDirRecursively(tablePath);
    return Promise.all(
      recKeys.map((recKey) =>
        processFilesInManRec(tablePath, records[recKey], forceWrite, true)
      )
    );
  }

  const recKeyToPath = (key: string) => path.join(tablePath, records[key].name);
  const recPathPromises = recKeys
    .map(recKeyToPath)
    .map(fUtils.createDirRecursively);
  await Promise.all(recPathPromises);

  const filePromises = recKeys.reduce(
    (acc: Promise<void>[], recKey: string) => {
      return [
        ...acc,
        processFilesInManRec(
          recKeyToPath(recKey),
          records[recKey],
          forceWrite,
          false
        ),
      ];
    },
    [] as Promise<void>[]
  );
  return Promise.all(filePromises);
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
  const tableNames = Object.keys(tables);
  const tablePromises = tableNames.map((tableName) => {
    return processRecsInManTable(
      path.join(ConfigManager.getSourcePath(), tableName),
      tables[tableName],
      forceWrite,
      flat
    );
  });
  await Promise.all(tablePromises);
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
    await processMissingFiles(newManifest);
    ConfigManager.updateManifest(newManifest);
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
    missingObj[table] = {};
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
  recPath: string,
  files: SN.File[],
  missingFunc: MarkFileMissingFunc
) => {
  const checkPromises = files.map(fUtils.SNFileExists(recPath));
  const checks = await Promise.all(checkPromises);
  checks.forEach((check, index) => {
    if (!check) {
      missingFunc(files[index]);
    }
  });
};

const checkRecordsForMissing = async (
  tablePath: string,
  records: SN.TableConfigRecords,
  missingFunc: MarkRecordMissingFunc
) => {
  const recNames = Object.keys(records);
  const recPaths = recNames.map(fUtils.appendToPath(tablePath));
  const checkPromises = recNames.map((recName, index) =>
    fUtils.pathExists(recPaths[index])
  );
  const checks = await Promise.all(checkPromises);
  const fileCheckPromises = checks.map(async (check, index) => {
    const recName = recNames[index];
    const record = records[recName];
    if (!check) {
      markRecordMissing(record, missingFunc);
      return;
    }
    await checkFilesForMissing(
      recPaths[index],
      record.files,
      missingFunc(record.sys_id)
    );
  });
  await Promise.all(fileCheckPromises);
};

const checkTablesForMissing = async (
  topPath: string,
  tables: SN.TableMap,
  missingFunc: MarkTableMissingFunc
) => {
  const tableNames = Object.keys(tables);
  const tablePaths = tableNames.map(fUtils.appendToPath(topPath));
  const checkPromises = tableNames.map((tableName, index) =>
    fUtils.pathExists(tablePaths[index])
  );
  const checks = await Promise.all(checkPromises);

  const recCheckPromises = checks.map(async (check, index) => {
    const tableName = tableNames[index];
    if (!check) {
      markTableMissing(tables[tableName], tableName, missingFunc);
      return;
    }
    await checkRecordsForMissing(
      tablePaths[index],
      tables[tableName].records,
      missingFunc(tableName)
    );
  });
  await Promise.all(recCheckPromises);
};

export const findMissingFiles = async (
  manifest: SN.AppManifest
): Promise<SN.MissingFileTableMap> => {
  const missing: SN.MissingFileTableMap = {};
  const { tables } = manifest;
  const missingTableFunc = markFileMissing(missing);
  await checkTablesForMissing(
    ConfigManager.getSourcePath(),
    tables,
    missingTableFunc
  );
  // missing gets mutated along the way as things get processed
  return missing;
};

export const processMissingFiles = async (
  newManifest: SN.AppManifest
): Promise<void> => {
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

  let filesToProcess: SN.TableMap;
  try {
    filesToProcess = await unwrapSNResponse(
      client.getMissingFiles(missing, tableOptions)
    );
  } catch (e) {
    if (isScopedEndpointUnavailableError(e)) {
      logger.info("Custom scope not found — fetching missing files from Table API...");
      filesToProcess = await buildBulkDownloadFromTableAPI(missing, client, tableOptions);
    } else {
      throw e;
    }
  }

  await processTablesInManifest(filesToProcess, false);
};

// Build a missing-file map that covers every file in the manifest, used to
// fetch full file contents for a fresh download.
export const buildFullMissingMap = (
  manifest: SN.AppManifest
): SN.MissingFileTableMap => {
  const missing: SN.MissingFileTableMap = {};
  for (const [tableName, tableConfig] of Object.entries(manifest.tables)) {
    missing[tableName] = {};
    for (const record of Object.values(tableConfig.records)) {
      missing[tableName][record.sys_id] = record.files.map((f) => ({
        name: f.name,
        type: f.type,
      }));
    }
  }
  return missing;
};

// Injected dependencies for the resumable download loop, so the
// progress/checkpoint/skip logic can be tested without a network or the disk.
export interface DownloadTableDeps {
  /** Fetch the file contents for a single-table missing map. */
  fetchTable: (tableMissing: SN.MissingFileTableMap) => Promise<SN.TableMap>;
  /** Write a fetched table's files to disk. */
  writeTable: (files: SN.TableMap) => Promise<void>;
  readCheckpoint: (scope: string) => Promise<DownloadCheckpoint | null>;
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

  const checkpoint = await deps.readCheckpoint(scope);
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

    completed.add(table);
    await deps.writeCheckpoint({ scope, completedTables: [...completed] });
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

  // Probe the scoped endpoint once; after the first "unavailable" go straight to
  // the Table API for the remaining tables instead of re-probing each time.
  let scopedEndpointUnavailable = false;
  const fetchTable = async (
    tableMissing: SN.MissingFileTableMap
  ): Promise<SN.TableMap> => {
    if (scopedEndpointUnavailable) {
      return buildBulkDownloadFromTableAPI(tableMissing, client, tableOptions);
    }
    try {
      return await unwrapSNResponse(
        client.getMissingFiles(tableMissing, tableOptions)
      );
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        logger.info("Custom scope not found — fetching files from Table API...");
        scopedEndpointUnavailable = true;
        return buildBulkDownloadFromTableAPI(tableMissing, client, tableOptions);
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
