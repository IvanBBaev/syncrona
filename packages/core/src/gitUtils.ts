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

/**
 * Current git branch name, or null when unavailable (not a repo, detached HEAD,
 * or git missing). Never throws — callers use this for best-effort issue-key
 * inference, so a missing branch should degrade gracefully, not error out.
 */
export const getCurrentBranch = async (): Promise<string | null> => {
  try {
    const branch = await execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    // Detached HEAD reports the literal "HEAD" — no branch name to mine.
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
};

const isValidScope = (
  file: string,
  scope: string,
  baseRepoPath: string
): boolean => {
  const relativePath = path.relative(baseRepoPath, scope);
  // Require a full path-segment match. A bare startsWith also accepted sibling
  // directories that merely share the prefix (scope "src" leaking "src-other"),
  // so a file is in scope only when it equals the scope dir or sits beneath it.
  return file === relativePath || file.startsWith(relativePath + path.sep);
};
