import { SN, Sync } from "@syncrona/types";
import path from "path";
import ProgressBar from "progress";
import * as fUtils from "./FileUtils";
import * as ConfigManager from "./config";
import { PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./constants";
import PluginManager from "./PluginManager";
import {
  defaultClient,
  processPushResponse,
  retryOnErr,
  SNClient,
  unwrapSNResponse,
  unwrapTableAPIFirstItem,
} from "./snClient";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
  isScopedEndpointUnavailableError,
} from "./manifestBuilder";
import { logger } from "./Logger";
import { aggregateErrorMessages, allSettled } from "./genericUtils";

const processFilesInManRec = async (
  recPath: string,
  rec: SN.MetaRecord,
  forceWrite: boolean
) => {
  const fileWrite = fUtils.writeSNFileCurry(!forceWrite);
  const filePromises = rec.files.map((file) => fileWrite(file, recPath));
  await Promise.all(filePromises);
  // Side effect, remove content from files so it doesn't get written to manifest
  rec.files.forEach((file) => {
    delete file.content;
  });
};

const processRecsInManTable = async (
  tablePath: string,
  table: SN.TableConfig,
  forceWrite: boolean
) => {
  const { records } = table;
  const recKeys = Object.keys(records);
  const recKeyToPath = (key: string) => path.join(tablePath, records[key].name);
  const recPathPromises = recKeys
    .map(recKeyToPath)
    .map(fUtils.createDirRecursively);
  await Promise.all(recPathPromises);

  const filePromises = recKeys.reduce(
    (acc: Promise<void>[], recKey: string) => {
      return [
        ...acc,
        processFilesInManRec(recKeyToPath(recKey), records[recKey], forceWrite),
      ];
    },
    [] as Promise<void>[]
  );
  return Promise.all(filePromises);
};

const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean
) => {
  const tableNames = Object.keys(tables);
  const tablePromises = tableNames.map((tableName) => {
    return processRecsInManTable(
      path.join(ConfigManager.getSourcePath(), tableName),
      tables[tableName],
      forceWrite
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

export const syncManifest = async () => {
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
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    logger.error("Encountered error while refreshing! ❌");
    logger.error(message.toString());
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
  try {
    const missing = await findMissingFiles(newManifest);
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
  } catch (e) {
    throw e;
  }
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

// Fetch and write the contents for every file in the manifest. Relies on the
// bulk download endpoint (with a Table API fallback) rather than depending on
// the manifest response to embed file contents.
export const downloadAllFiles = async (
  manifest: SN.AppManifest,
  instanceProfile?: string
): Promise<void> => {
  const missing = buildFullMissingMap(manifest);
  const { tableOptions = {} } = ConfigManager.getConfig();
  const client = defaultClient(instanceProfile);

  let filesToProcess: SN.TableMap;
  try {
    filesToProcess = await unwrapSNResponse(
      client.getMissingFiles(missing, tableOptions)
    );
  } catch (e) {
    if (isScopedEndpointUnavailableError(e)) {
      logger.info("Custom scope not found — fetching files from Table API...");
      filesToProcess = await buildBulkDownloadFromTableAPI(
        missing,
        client,
        tableOptions
      );
    } else {
      throw e;
    }
  }

  await processTablesInManifest(filesToProcess, true);
};

export const groupAppFiles = (fileCtxs: Sync.FileContext[]) => {
  const combinedFiles = fileCtxs.reduce((groupMap, cur) => {
    const { tableName, targetField, sys_id } = cur;
    const key = `${tableName}-${sys_id}`;
    const entry: Sync.BuildableRecord = groupMap[key] ?? {
      table: tableName,
      sysId: sys_id,
      fields: {},
    };
    const newEntry: Sync.BuildableRecord = {
      ...entry,
      fields: { ...entry.fields, [targetField]: cur ?? "" },
    };
    return { ...groupMap, [key]: newEntry };
  }, {} as Record<string, Sync.BuildableRecord>);
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
      }
    );
    return processPushResponse(pushRes, recSummary);
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    const errMsg = message || "Too many retries";
    return { success: false, message: `${recSummary} : ${errMsg}` };
  }
};

const resolvePushConcurrency = (): number => {
  const cfg = ConfigManager.getConfig();
  const raw = (cfg as Sync.Config).pushConcurrency;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(raw), 1), 50);
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
  recs: Sync.BuildableRecord[]
): Promise<Sync.PushResult[]> => {
  const client = defaultClient();
  const pushConcurrency = resolvePushConcurrency();
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

const getProgTick = (
  logLevel: string,
  total: number
): (() => void) | undefined => {
  if (logLevel === "info") {
    const progBar = new ProgressBar(":bar (:percent)", {
      total,
      width: 60,
    });
    return () => {
      progBar.tick();
    };
  }
  // no-op at other log levels
  return undefined;
};

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

export const swapScope = async (currentScope: string): Promise<SN.ScopeObj> => {
  try {
    const client = defaultClient();
    const scopeId = await unwrapTableAPIFirstItem(
      client.getScopeId(currentScope),
      "sys_id"
    );
    await swapServerScope(scopeId);
    const scopeObj = await unwrapSNResponse(client.getCurrentScope());
    return scopeObj;
  } catch (e) {
    throw e;
  }
};

const swapServerScope = async (scopeId: string): Promise<void> => {
  try {
    const client = defaultClient();
    const userSysId = await unwrapTableAPIFirstItem(
      client.getUserSysId(),
      "sys_id"
    );
    const curAppUserPrefId =
      (await unwrapTableAPIFirstItem(
        client.getCurrentAppUserPrefSysId(userSysId),
        "sys_id"
      )) || "";
    // If not user pref record exists, create it.
    if (curAppUserPrefId !== "")
      await client.updateCurrentAppUserPref(scopeId, curAppUserPrefId);
    else await client.createCurrentAppUserPref(scopeId, userSysId);
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    logger.error(message);
    throw e;
  }
};

/**
 * Creates a new update set and assigns it to the current user.
 * @param updateSetName - does not create update set if value is blank
 */
export const createAndAssignUpdateSet = async (updateSetName = "") => {
  logger.info(`Update Set Name: ${updateSetName}`);
  const client = defaultClient();
  const { sys_id: updateSetSysId } = await unwrapSNResponse(
    client.createUpdateSet(updateSetName)
  );
  const userSysId = await unwrapTableAPIFirstItem(
    client.getUserSysId(),
    "sys_id"
  );
  const curUpdateSetUserPrefId = await unwrapTableAPIFirstItem(
    client.getCurrentUpdateSetUserPref(userSysId),
    "sys_id"
  );

  if (curUpdateSetUserPrefId !== "") {
    await client.updateCurrentUpdateSetUserPref(
      updateSetSysId,
      curUpdateSetUserPrefId
    );
  } else {
    await client.createCurrentUpdateSetUserPref(updateSetSysId, userSysId);
  }
  return {
    name: updateSetName,
    id: updateSetSysId,
  };
};

export const checkScope = async (
  swap: boolean
): Promise<Sync.ScopeCheckResult> => {
  try {
    const man = ConfigManager.getManifest();
    if (man) {
      const client = defaultClient();
      let scopeObj: SN.ScopeObj;
      try {
        scopeObj = await unwrapSNResponse(client.getCurrentScope());
      } catch (e) {
        if (isScopedEndpointUnavailableError(e)) {
          return {
            match: true,
            sessionScope: man.scope,
            manifestScope: man.scope,
          };
        }
        throw e;
      }
      if (scopeObj.scope === man.scope) {
        return {
          match: true,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope,
        };
      } else if (swap) {
        const swappedScopeObj = await swapScope(man.scope);
        return {
          match: swappedScopeObj.scope === man.scope,
          sessionScope: swappedScopeObj.scope,
          manifestScope: man.scope,
        };
      } else {
        return {
          match: false,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope,
        };
      }
    }
    //first time case
    return {
      match: true,
      sessionScope: "",
      manifestScope: "",
    };
  } catch (e) {
    throw e;
  }
};
