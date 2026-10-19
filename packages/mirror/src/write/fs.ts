// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Writer's filesystem seam (WP-M7, §5.8).
 *
 * Six operations, no more: the mirror's writer needs to make directories, put
 * bytes somewhere, move them, read them back, list a directory and remove a tree.
 * Everything else `node:fs/promises` offers — chmod, symlinks, watches, streams —
 * is absent on purpose, because a seam that can express an operation is a seam a
 * future edit can smuggle an operation through, and this one sits directly in
 * front of the user's git repository.
 *
 * Why a seam at all, given that the acceptance tests use a real temporary
 * directory anyway (a fake filesystem that agrees with itself proves nothing about
 * `rename`):
 *
 *  - **R4 is about the moments between calls.** "Kill the process between the temp
 *    write and the rename" is not something a test can arrange against the real
 *    `fs` module without actually killing a process, and a killed process cannot
 *    then assert anything. With a seam the test runs the REAL production code
 *    against the REAL disk and interrupts it at a chosen call, then inspects the
 *    real tree from the surviving process. That is a stronger test than a fake
 *    filesystem and a more precise one than a `SIGKILL` race.
 *  - **F8 (local disk failure) has to be exercised.** `ENOSPC` mid-flush is a
 *    documented failure class with a required behaviour (checkpoint and stop, tree
 *    stays consistent). Filling a disk in CI is not an option; failing the seam is.
 *  - **INV-6 needs a witness.** "A hostile sys_id must never reach a filesystem
 *    call" is only checkable if something can observe every filesystem call. A
 *    recording wrapper around this interface is that observer.
 *
 * The interface deals in absolute native paths (`/` or `\` as the platform wants)
 * and in `Uint8Array`. Repo-relative, always-forward-slash paths are a different
 * type of thing and stay in `shards/shardLayout.ts`; {@link toNativePath} is the
 * one conversion point between them.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { sep } from "node:path";

/** One entry of a directory listing — only what the writer's pruning needs. */
export interface WriterDirEntry {
  /** Base name inside the listed directory. */
  name: string;
  /** Whether the entry is itself a directory. */
  isDirectory: boolean;
}

/**
 * Everything the Writer is allowed to do to a filesystem.
 *
 * `readFile` and `readDir` return `null` for "not there" rather than rejecting.
 * That is not sugar: the writer asks "does this shard set exist yet?" on every
 * flush and "what is stale in this record directory?" on every record, and both
 * questions have a legitimate negative answer. Encoding it as an exception means
 * every call site wraps a `try` whose `catch` has to re-inspect `error.code` and
 * re-throw everything that is not `ENOENT` — a shape that gets written correctly
 * the first time and wrongly the fourth, and whose failure mode is swallowing the
 * `EACCES` that should have stopped the sweep.
 */
export interface WriterFs {
  /** Create a directory and every missing parent. Succeeds if it exists. */
  makeDir(dir: string): Promise<void>;
  /** Write bytes, creating or truncating. Never appends. */
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>;
  /** Rename within one filesystem — the atomic half of R4. */
  rename(from: string, to: string): Promise<void>;
  /** Read a file's bytes, or `null` when it does not exist. */
  readFile(filePath: string): Promise<Uint8Array | null>;
  /** List a directory, or `null` when it does not exist. */
  readDir(dir: string): Promise<WriterDirEntry[] | null>;
  /** Remove a file or directory tree. Succeeds if it is already gone. */
  removeRecursive(target: string): Promise<void>;
}

/** Node error shape, narrowed enough to read `code` without an `any`. */
function errorCode(error: unknown): string | undefined {
  /* istanbul ignore next -- @preserve: every caller passes a rejection from
     `node:fs/promises`, which is always an object carrying `code`, so the guard
     never fails today. It stays rather than becoming an unchecked cast, because
     what it protects is the direction the callers read the result in: an
     `undefined` here means "this is not an absence" and is rethrown, so a wrong
     narrowing would turn an unreadable directory into an empty one — the forged
     evidence INV-5 exists to forbid. Being wrong loudly is the safe failure. */
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

/**
 * The production implementation, on `node:fs/promises`.
 *
 * A function rather than a module-level constant so that a caller who wants two
 * independent recorders wrapping it gets two objects; and so that the module has
 * no side effect at import time, which matters because `test/getOnlyBuild.test.ts`
 * loads every emitted module to scan it.
 */
export function nodeWriterFs(): WriterFs {
  return {
    async makeDir(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
    },
    async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
      await writeFile(filePath, bytes);
    },
    async rename(from: string, to: string): Promise<void> {
      await rename(from, to);
    },
    async readFile(filePath: string): Promise<Uint8Array | null> {
      try {
        return new Uint8Array(await readFile(filePath));
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async readDir(dir: string): Promise<WriterDirEntry[] | null> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
          return null;
        }
        throw error;
      }
    },
    async removeRecursive(target: string): Promise<void> {
      await rm(target, { recursive: true, force: true });
    },
  };
}

/**
 * Turn a repo-relative path (always `/`) into a native absolute path.
 *
 * The one place the two path worlds meet. Splitting on `/` and re-joining with
 * `path.sep` rather than calling `path.join(root, relative)` is intentional: on
 * Windows `path.join` would also accept a relative path containing `\` and quietly
 * normalise it, which would let a `\`-bearing string from a committed shard become
 * a valid path. `shardLayout.isContainedRepoPath` rejects those, and this function
 * keeps the property that anything it produces is `root` plus segments.
 */
export function toNativePath(root: string, repoRelative: string): string {
  const segments = repoRelative.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? root : `${root}${sep}${segments.join(sep)}`;
}
