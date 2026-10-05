// SPDX-License-Identifier: GPL-3.0-or-later
import * as cp from "child_process";
import path from "path";
import { logger } from "./Logger.js";
import { PATH_DELIMITER } from "./constants.js";
import * as ConfigManager from "./config.js";
import fs from "fs";
import * as fUtils from "./FileUtils.js";

export const gitDiffToEncodedPaths = async (diff: string) => {
  if (diff !== "") return gitDiff(diff, ConfigManager.getSourcePath());
  return ConfigManager.getSourcePath();
};

/** What `git diff --name-status` says about the source tree. */
export interface GitDiffChanges {
  /** Added, modified, copied and renamed-to paths, encoded like gitDiffToEncodedPaths. */
  changed: string;
  /**
   * Absolute paths the diff removed: `D` lines and the OLD side of an `R`
   * rename (a rename takes the file away from its old record).
   */
  deleted: string[];
}

/**
 * gitDiffToEncodedPaths plus the deleted side of the diff (R2, `push --prune`).
 * Without a diff target there is no diff to read, so nothing counts as deleted.
 */
export const gitDiffToChanges = async (diff: string): Promise<GitDiffChanges> => {
  const sourcePath = ConfigManager.getSourcePath();
  if (diff !== "") return gitDiffChanges(diff, sourcePath);
  return { changed: sourcePath, deleted: [] };
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

const gitDiffChanges = async (
  target: string,
  sourcePath: string
): Promise<GitDiffChanges> => {
  const stdout = await execGit([
    // Emit literal UTF-8 paths. Under the default core.quotePath=true git
    // C-quotes any byte >0x80 (e.g. a Cyrillic record name becomes
    // "src/…/\320\242…/script.js"), which never matches a real file and is
    // silently dropped by the tab-split parser below — an empty `push --diff`.
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-status",
    `${target}...`,
    "--",
    sourcePath,
  ]);
  return formatGitChanges(stdout);
};

/**
 * R2, `push --prune` without `--diff`: the source-tree files git proves were
 * deleted — tracked in HEAD and now missing from the working tree (or staged
 * for removal). Renames are not detected, so a moved file lists its old path.
 * A file that was never committed is not evidence of anything and is absent
 * here. Throws when git cannot answer (not a repository, no HEAD commit).
 */
export const gitWorkingTreeDeletions = async (): Promise<string[]> => {
  const stdout = await execGit([
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-status",
    "--no-renames",
    "--diff-filter=D",
    "HEAD",
    "--",
    ConfigManager.getSourcePath(),
  ]);
  return (await formatGitChanges(stdout)).deleted;
};

const gitDiff = async (target: string, sourcePath: string): Promise<string> =>
  (await gitDiffChanges(target, sourcePath)).changed;

export const writeDiff = async (files: string) => {
  const paths = await fUtils.encodedPathsToFilePaths(files);
  logger.silly(`${paths.length} paths found...`);
  logger.silly(JSON.stringify(paths, null, 2));
  await fs.promises.writeFile(
    ConfigManager.getDiffPath(),
    JSON.stringify({ changed: paths })
  );
};

/**
 * Removes the diff manifest, if there is one.
 *
 * deploy treats the file's PRESENCE as the intent to ship a subset — under --ci
 * it does so without a prompt — so a manifest left behind by an earlier
 * `build --diff` silently narrows the deploy that follows a FULL rebuild to a
 * stale list of paths. An absent file is the normal state, so ENOENT is not an
 * error; anything else is reported and left in place rather than swallowed,
 * because the next deploy would act on it.
 */
export const clearDiff = async () => {
  try {
    await fs.promises.unlink(ConfigManager.getDiffPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    logger.warn(
      `Could not remove the stale diff manifest at ${ConfigManager.getDiffPath()}: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        "Delete it before deploying, or the deploy will ship only the paths it lists."
    );
  }
};

/**
 * Splits `git diff --name-status` output into the paths to push and the paths
 * the diff removed. Lines are tab separated: "M\tpath", "D\tpath",
 * "R100\told\tnew", "C75\tsrc\tcopy". The last column is always a path that
 * exists after the diff; for a rename the first path column no longer does, so
 * it is reported as deleted. A copy leaves its source in place.
 */
export const formatGitChanges = async (gitFiles: string): Promise<GitDiffChanges> => {
  const baseRepoPath = await getRepoRootDir();
  const workspaceDir = process.cwd();
  const fileSplit = gitFiles.split(/\r?\n/);
  const fileArray: string[] = [];
  const deleted: string[] = [];
  const addIfInScope = (target: string[], filePath: string) => {
    if (isValidScope(filePath, workspaceDir, baseRepoPath)) {
      target.push(path.resolve(baseRepoPath, filePath));
      return true;
    }
    return false;
  };
  fileSplit.forEach((diffFile) => {
    if (diffFile === "") {
      return;
    }
    const columns = diffFile.split("\t");
    if (columns.length < 2) {
      return;
    }
    const modCode = columns[0].charAt(0);
    if (modCode === "D") {
      addIfInScope(deleted, columns[1].trim());
      return;
    }
    if (modCode === "R" && columns.length > 2) {
      addIfInScope(deleted, columns[1].trim());
    }
    if (addIfInScope(fileArray, columns[columns.length - 1].trim())) {
      logger.info(diffFile);
    }
  });
  return { changed: fileArray.join(PATH_DELIMITER), deleted };
};

/** The changed side only, in the encoded form every push/build caller expects. */
export const formatGitFiles = async (gitFiles: string): Promise<string> =>
  (await formatGitChanges(gitFiles)).changed;

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

// Collapse either separator to a single "/" so a segment comparison works no
// matter the OS. On Windows this matters twice over: `git diff` always emits
// forward slashes, while path.relative()/path.sep produce backslashes — so the
// two would never line up and every in-scope file would be dropped (an empty
// `push --diff`). Normalizing both sides removes that platform trap.
const toPosixSeparators = (p: string): string => p.replace(/\\/g, "/");

const isValidScope = (
  file: string,
  scope: string,
  baseRepoPath: string
): boolean => {
  const relativePath = toPosixSeparators(path.relative(baseRepoPath, scope));
  const normalizedFile = toPosixSeparators(file);
  // When the scope IS the repo root, path.relative() yields "" and every diff
  // path (which is repo-relative, no leading "/") is in scope. Without this the
  // checks below reject everything and `push --diff` at the repo root is empty.
  if (relativePath === "") {
    return true;
  }
  // Require a full path-segment match. A bare startsWith also accepted sibling
  // directories that merely share the prefix (scope "src" leaking "src-other"),
  // so a file is in scope only when it equals the scope dir or sits beneath it.
  return normalizedFile === relativePath || normalizedFile.startsWith(relativePath + "/");
};
