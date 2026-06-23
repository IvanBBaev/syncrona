// SPDX-License-Identifier: GPL-3.0-or-later
import * as cp from "child_process";
import path from "path";
import { logger } from "./Logger";
import { PATH_DELIMITER } from "./constants";
import * as ConfigManager from "./config";
import fs from "fs";
import * as fUtils from "./FileUtils";

export const gitDiffToEncodedPaths = async (diff: string) => {
  if (diff !== "") return gitDiff(diff, ConfigManager.getSourcePath());
  return ConfigManager.getSourcePath();
};

const execGit = (args: string[]): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    // execFile (no shell) keeps paths with spaces intact and rules out shell
    // injection through the diff target argument.
    cp.execFile("git", args, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
};

const gitDiff = async (target: string, sourcePath: string): Promise<string> => {
  const stdout = await execGit([
    "diff",
    "--name-status",
    `${target}...`,
    "--",
    sourcePath,
  ]);
  return formatGitFiles(stdout);
};

export const writeDiff = async (files: string) => {
  const paths = await fUtils.encodedPathsToFilePaths(files);
  logger.silly(`${paths.length} paths found...`);
  logger.silly(JSON.stringify(paths, null, 2));
  await fs.promises.writeFile(
    ConfigManager.getDiffPath(),
    JSON.stringify({ changed: paths })
  );
};

const formatGitFiles = async (gitFiles: string) => {
  const baseRepoPath = await getRepoRootDir();
  const workspaceDir = process.cwd();
  const fileSplit = gitFiles.split(/\r?\n/);
  const fileArray: string[] = [];
  fileSplit.forEach((diffFile) => {
    if (diffFile === "") {
      return;
    }
    // --name-status lines are tab separated: "M\tpath", "R100\told\tnew",
    // "C75\tsrc\tcopy". For renames/copies the new path is the last column.
    const columns = diffFile.split("\t");
    const modCode = columns[0].charAt(0);
    if (modCode === "D" || columns.length < 2) {
      return;
    }
    const filePath = columns[columns.length - 1].trim();

    if (isValidScope(filePath, workspaceDir, baseRepoPath)) {
      logger.info(diffFile);
      const absFilePath = path.resolve(baseRepoPath, filePath);
      fileArray.push(absFilePath);
    }
  });
  return fileArray.join(PATH_DELIMITER);
};

const getRepoRootDir = async (): Promise<string> => {
  return execGit(["rev-parse", "--show-toplevel"]);
};

const isValidScope = (
  file: string,
  scope: string,
  baseRepoPath: string
): boolean => {
  const relativePath = path.relative(baseRepoPath, scope);
  return file.startsWith(relativePath) ? true : false;
};
