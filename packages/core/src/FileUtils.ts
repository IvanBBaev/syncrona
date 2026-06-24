// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncro-now-ai/types";
import { PATH_DELIMITER } from "./constants";
import fs, { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  task: () => Promise<T>,
  retries = 2,
  waitMs = 50
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < retries && waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
};

export const SNFileExists = (parentDirPath: string) => async (
  file: SN.File
): Promise<boolean> => {
  try {
    const files = await fsp.readdir(parentDirPath);
    const escapedName = file.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reg = new RegExp(`^${escapedName}\\..*$`);
    const match = files.find((f) => reg.test(f));
    if (!match) {
      return false;
    }
    // Treat zero-byte placeholder files as missing so their content gets
    // (re)fetched on refresh instead of being skipped as "already present".
    try {
      const stats = await fsp.stat(path.join(parentDirPath, match));
      return stats.size > 0;
    } catch (_) {
      return false;
    }
  } catch (e) {
    return false;
  }
};

export const writeManifestFile = async (man: SN.AppManifest) => {
  return withRetry(() =>
    fsp.writeFile(
      ConfigManager.getManifestPath(),
      JSON.stringify(man, null, 2)
    )
  );
};

export const writeSNFileCurry = (checkExists: boolean) => async (
  file: SN.File,
  parentPath: string
): Promise<void> => {
  const { name, type } = file;
  let { content = "" } = file;
  // content can sometimes be null
  if (!content) {
    content = "";
  } else if (typeof content !== "string") {
    try {
      content = JSON.stringify(content, null, 2);
    } catch (_) {
      content = String(content);
    }
  }
  const write = async () => {
      const fullPath = path.join(parentPath, `${name}.${type}`);
      return await withRetry(() => fsp.writeFile(fullPath, content));
    };
    if (checkExists) {
    const exists = await SNFileExists(parentPath)(file);
    if (!exists) {
      await write();
    }
  } else {
    await write();
  }
};

export const createDirRecursively = async (path: string): Promise<void> => {
  await fsp.mkdir(path, { recursive: true });
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fsp.access(path, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
};

export const appendToPath = (prefix: string) => (suffix: string): string =>
  path.join(prefix, suffix);

/**
 * Detects if a path is under a parent directory
 * @param parentPath full path to parent directory
 * @param potentialChildPath full path to child directory
 */
export const isUnderPath = (
  parentPath: string,
  potentialChildPath: string
): boolean => {
  const parentTokens = parentPath.split(path.sep);
  const childTokens = potentialChildPath.split(path.sep);
  return parentTokens.every((token, index) => token === childTokens[index]);
};

const getFileExtension = (filePath: string): string => {
  try {
    return path.extname(filePath);
  } catch (e) {
    return "";
  }
};

export const getBuildExt = (
  table: string,
  recordName: string,
  field: string
): string => {
  const manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("Failed to retrieve manifest");
  }
  const files = manifest.tables[table].records[recordName].files;
  const file = files.find((f) => f.name === field);
  if (!file) {
    throw new Error("Unable to find file");
  }
  return file.type;
};

const getTargetFieldFromPath = (
  filePath: string,
  table: string,
  ext: string
): string => {
  return table === "sys_atf_step"
    ? "inputs.script"
    : path.basename(filePath, ext);
};

export const getFileContextFromPath = (
  filePath: string
): Sync.FileContext | undefined => {
  const ext = getFileExtension(filePath);
  const [tableName, recordName] = path
    .dirname(filePath)
    .split(path.sep)
    .slice(-2);
  const targetField = getTargetFieldFromPath(filePath, tableName, ext);
  const manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("No manifest has been loaded!");
  }
  const { tables, scope } = manifest;
  try {
    const { records } = tables[tableName];
    const record = records[recordName];
    const { files, sys_id } = record;
    const field = files.find((file) => file.name === targetField);
    if (!field) {
      return undefined;
    }
    return {
      filePath,
      ext,
      sys_id,
      name: recordName,
      scope,
      tableName,
      targetField,
    };
  } catch (e) {
    return undefined;
  }
};

export const toAbsolutePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(process.cwd(), p);

export const isDirectory = async (p: string): Promise<boolean> => {
  const stats = await fsp.stat(p);
  return stats.isDirectory();
};

export const getPathsInPath = async (p: string): Promise<string[]> => {
  if (
    !isUnderPath(ConfigManager.getSourcePath(), p) &&
    !isUnderPath(ConfigManager.getBuildPath(), p)
  ) {
    return [];
  }
  const maxDepth = 20;
  const files: string[] = [];
  const stack: Array<{ filePath: string; depth: number }> = [
    { filePath: path.resolve(p), depth: 0 },
  ];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) {
      continue;
    }

    if (next.depth > maxDepth) {
      continue;
    }

    let stat;
    try {
      stat = await fsp.lstat(next.filePath);
    } catch (_) {
      continue;
    }

    if (!stat.isDirectory()) {
      files.push(next.filePath);
      continue;
    }

    if (next.depth === maxDepth) {
      continue;
    }

    let children: string[] = [];
    try {
      children = await fsp.readdir(next.filePath);
    } catch (_) {
      continue;
    }

    for (const child of children) {
      stack.push({
        filePath: path.resolve(next.filePath, child),
        depth: next.depth + 1,
      });
    }
  }

  return files;
};

export const splitEncodedPaths = (encodedPaths: string): string[] =>
  encodedPaths.split(PATH_DELIMITER).filter((p) => p && p !== "");

export const isValidPath = async (path: string): Promise<boolean> => {
  return pathExists(path);
};

export const encodedPathsToFilePaths = async (
  encodedPaths: string
): Promise<string[]> => {
  const pathSplits = splitEncodedPaths(encodedPaths);
  const validChecks = await Promise.all(pathSplits.map(isValidPath));
  const validSplits = pathSplits.filter((_, index) => validChecks[index]);
  const splitPaths = await Promise.all(validSplits.map(getPathsInPath));
  const deDupedPaths = splitPaths.flat().reduce((acc, cur) => {
    acc.add(cur);
    return acc;
  }, new Set<string>());
  return Array.from(deDupedPaths);
};

export const summarizeFile = (ctx: Sync.FileContext): string => {
  const { tableName, name: recordName, sys_id } = ctx;
  return `${tableName}/${recordName}/${sys_id}`;
};

export const writeBuildFile = async (
  folderPath: string,
  newPath: string,
  fileContents: string
) => {
  try {
    await fsp.access(folderPath, fs.constants.F_OK);
  } catch (e) {
    await fsp.mkdir(folderPath, { recursive: true });
  }
  await writeFileForce(newPath, fileContents);
};

export const writeSNFileIfNotExists = writeSNFileCurry(true);
export const writeSNFileForce = writeSNFileCurry(false);

export const writeFileForce = (
  filePath: fs.PathLike,
  data: string | NodeJS.ArrayBufferView
) => withRetry(() => fsp.writeFile(filePath, data));
