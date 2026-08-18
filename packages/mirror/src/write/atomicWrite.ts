// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Atomic file replacement and staged removal — R4 (WP-M7, §5.8).
 *
 * R4: "All writes are atomic (temp file + rename). Any failure leaves the tree in
 * the pre-write or post-write state, never in between." The mirror writes into a
 * git working tree that a human may be looking at, that CI may be committing, and
 * that a `mirror sync` may be resuming into after a crash. A truncated
 * `record.json` in that tree is worse than a missing one: it commits, it diffs, and
 * it looks like the instance changed.
 *
 * The mechanism is one system call's guarantee. POSIX `rename(2)` within a single
 * filesystem replaces the destination atomically — a concurrent reader sees either
 * the old inode or the new one, never a partial file — and Windows' `MoveFileEx`
 * with replace behaves the same way, which is what Node's `fs.rename` maps to. So:
 * write the whole payload to a temporary name, then one rename.
 *
 * **The temp file MUST be a sibling of the destination.** Not `os.tmpdir()`, not a
 * `.mirror/tmp` directory at the repo root. `rename` across filesystems fails with
 * `EXDEV`, and the usual "fix" for `EXDEV` is a copy-then-unlink fallback, which is
 * exactly the non-atomic write R4 forbids — reintroduced by the error handler. A
 * mirror repo can easily span mounts (`instance/` on a data volume, the repo root
 * on `/`), so this is a real configuration rather than a hypothetical one. Same
 * directory means same filesystem, always.
 *
 * **Honest limits, stated rather than implied.**
 *
 *  1. *Durability is not atomicity.* This module does not `fsync` the file or its
 *     parent directory, so a power loss (as opposed to a process death) can lose the
 *     rename even though it never exposes a partial file. Adding `fsync` per record
 *     would cost a disk flush per file on a sweep that writes hundreds of thousands
 *     of them. The mirror's answer to a lost tail is the checkpoint plus a re-sweep,
 *     which is idempotent, so the cost is not worth paying. If that trade ever
 *     changes, it changes here.
 *  2. *A record is more than one file.* A record directory holds `record.json` plus
 *     extracted field files, and no sequence of renames makes N files appear at
 *     once. A crash between them leaves a directory mixing two sweeps. That state is
 *     invisible to consumers, because INV-4 means no shard on disk ever claimed it,
 *     and the next sweep rewrites the whole directory. Making it truly atomic would
 *     mean staging each record in a sibling directory and renaming the directory —
 *     which `rename` does support — at the cost of rewriting every unchanged file in
 *     every record on every sweep, destroying the "unchanged records produce no
 *     writes" property the incremental sweep depends on. Named, measured, rejected.
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { WriterFs } from "./fs";

/**
 * Prefix of every staging name this module creates.
 *
 * Dot-prefixed so it is hidden from a casual `ls` and, more importantly, so it is
 * distinguishable by the directory-pruning pass in the writer: a leftover from a
 * crashed run must be recognisable as garbage rather than mistaken for an extracted
 * field file and preserved forever. `.gitignore` in the generated mirror repo can
 * match the same prefix for the same reason.
 */
export const STAGING_PREFIX = ".mirror-tmp-";

/**
 * Whether a directory entry is one of this module's staging artefacts.
 *
 * Exported because the pruning pass and the shard store both need the answer and
 * neither should re-spell the prefix.
 */
export function isStagingName(name: string): boolean {
  return name.startsWith(STAGING_PREFIX);
}

/**
 * A staging name that no concurrent writer can collide with.
 *
 * Three components, each earning its place: the pid, so two `mirror sync` processes
 * over the same repo cannot pick the same name; a process-lifetime counter, so two
 * awaits inside one process cannot; and eight random bytes, because pid numbers are
 * recycled and a crashed run's leftovers may still be sitting in the directory when
 * a new process with the same pid starts. `randomBytes` rather than `Math.random`
 * because the cost is irrelevant next to the write that follows and the failure mode
 * of a collision is a corrupted record.
 *
 * The name is deliberately NOT derived from the destination file name. A staging
 * name that embedded the target would make `record.json`'s temp file
 * `.mirror-tmp-record.json`, which sorts next to it and reads like a variant of it
 * in a directory listing; keeping them unrelated makes leftovers obviously garbage.
 */
let stagingCounter = 0;
function stagingName(): string {
  stagingCounter += 1;
  return `${STAGING_PREFIX}${process.pid.toString(36)}-${stagingCounter.toString(36)}-${randomBytes(8).toString("hex")}`;
}

/**
 * A fresh staging path beside `targetPath`.
 *
 * Exported because the writer's rename pass needs the same "sibling, therefore same
 * filesystem, therefore `rename` cannot fail with `EXDEV`" guarantee that this
 * module's own writes rely on, and re-deriving it there would put the one rule this
 * file exists to protect in two places.
 */
export function stagingSiblingOf(targetPath: string): string {
  return join(dirname(targetPath), stagingName());
}

/**
 * Replace `filePath` with `bytes` atomically (R4).
 *
 * The `catch` removes the staging file and then re-throws the ORIGINAL error. Both
 * halves matter: without the cleanup a failing sweep litters the tree with staging
 * files that the next `git status` shows as untracked noise, and without the
 * re-throw an `ENOSPC` becomes a silent no-op — the single worst outcome for a tool
 * whose entire value is that its output is complete. The cleanup's own failure is
 * swallowed for the same reason: it must not replace the real error with a less
 * informative one.
 */
export async function atomicWriteFile(
  fs: WriterFs,
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  const staging = stagingSiblingOf(filePath);
  await fs.writeFile(staging, bytes);
  try {
    await fs.rename(staging, filePath);
  } catch (error) {
    await fs.removeRecursive(staging).catch(() => undefined);
    throw error;
  }
}

/**
 * Remove a directory tree without ever exposing a partially removed one (§5.8).
 *
 * A plain recursive delete walks the tree and unlinks as it goes, so a crash
 * halfway through leaves a directory that still exists and still contains some of
 * its files — a record whose `record.json` is gone but whose `script.js` remains.
 * A reader (or a `git add -A`) that observes that state records a record which
 * never existed in that form on the instance.
 *
 * Renaming the directory to a hidden sibling first makes the disappearance atomic:
 * after one `rename` the record's path is gone in a single step, and whatever the
 * recursive removal then does — including nothing at all, because the process died
 * — is invisible at the record's path. The leftover staging directory is garbage a
 * later sweep's pruning pass can recognise by its prefix.
 *
 * Returns without doing anything if the target is already absent, so a reconcile
 * that runs twice is idempotent rather than an error.
 */
export async function atomicRemoveDir(fs: WriterFs, target: string): Promise<void> {
  const listing = await fs.readDir(target);
  if (listing === null) {
    return;
  }
  const staging = stagingSiblingOf(target);
  await fs.rename(target, staging);
  await fs.removeRecursive(staging);
}

/**
 * Remove a single file if it is there (used by the stale-file pruning pass).
 *
 * A file removal is already atomic — `unlink` either happened or did not — so this
 * is a thin pass-through and exists only so that the writer never calls
 * `removeRecursive` on something it believes to be a file. The difference matters
 * the day a name that was a file becomes a directory: `removeRecursive` would
 * cheerfully delete the subtree, this makes the caller's intent explicit and its
 * blast radius one entry.
 */
export async function removeFileIfPresent(
  fs: WriterFs,
  filePath: string
): Promise<void> {
  await fs.removeRecursive(filePath);
}
