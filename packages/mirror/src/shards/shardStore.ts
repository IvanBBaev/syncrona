// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shard set I/O — the disk half of §4.3 (WP-M7).
 *
 * A "shard set" is everything under `instance/<scope>/<table>/.shards/`: one file
 * per hex prefix at the set's fan-out, together forming the mirror's index of that
 * directory. This module reads one back and writes one out; every decision about
 * *what* the bytes say lives in `shardLayout.ts`, which is pure and therefore
 * testable without a filesystem.
 *
 * Two design choices here are worth the paragraph they cost.
 *
 * **The shard set is per `(scope, table)`, not per table.** §4.3 names the field
 * `table` and D16 speaks of a table's fan-out, but the files live under a scope
 * directory, and the fan-out's job — measured in analyses §9.4 — is to keep an
 * individual shard file small enough to diff and merge. Choosing the level from the
 * whole table's row count would give a 300 000-row table spread across 50 scopes a
 * fan-out of 2 in every one of them: 12 800 shard files, almost all nearly empty,
 * spent against the file-count budget analyses §9.3 says vanilla git cares about.
 * Choosing it from the directory's own count is the only reading under which the
 * knob controls the thing it was measured against. The manifest's `table` field is
 * still the table — a shard file names the table it indexes, and every shard in one
 * scope directory agrees on it.
 *
 * **Every shard file for the fan-out is written, including empty ones.** The
 * alternative (skip empty shards) saves a handful of ~90-byte files and costs two
 * properties. First, the expected file set becomes a function of the data rather
 * than of the fan-out, so "delete what is no longer claimed" — the pass that cleans
 * up after a `mirror migrate` — has to reason about which absences are intentional.
 * Second, a directory swept to empty would have NO shards at all, which erases both
 * the sticky fan-out and the evidence that the sweep completed, and INV-5 reads that
 * evidence to decide whether deletions are authorised. Fan-out 1 and 2 only exist
 * above 16 000 and 256 000 records respectively, so in every case that is not a
 * post-shrink remnant the files are full anyway.
 */
import {
  assertMirrorPathComponent,
  buildShardManifest,
  INSTANCE_DIR_NAME,
  isContainedRepoPath,
  parseShardManifest,
  renderShardManifest,
  repoPath,
  SHARD_DIR_NAME,
  SHARD_FILE_SUFFIX,
  shardDirRelPath,
  shardFileName,
  shardFileNamesFor,
  ShardManifestCorrupt,
  shardKeyFor,
  SINGLE_SHARD_FILE,
  type ShardFanout,
} from "./shardLayout";
import { atomicWriteFile, isStagingName, removeFileIfPresent } from "../write/atomicWrite";
import { toNativePath, type WriterFs } from "../write/fs";
import type { RecordEntry, ShardManifest } from "../contracts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

/** What one scope directory's shard set said, as read back off disk. */
export interface LoadedShardSet {
  /**
   * The fan-out the existing files use, or `null` when there are none. `null` is
   * the ONLY condition under which a new fan-out may be chosen (D16) — see
   * `stickyFanout`.
   */
  fanout: ShardFanout | null;
  /** Every record the set claims, keyed by sys_id (each already INV-6 validated). */
  entries: Map<string, RecordEntry>;
  /**
   * Whether every shard in the set claims a complete index of the scope's records.
   * Established by a completed full sweep and preserved across incremental
   * overlays (see `TableSweepWriter.completeTable`); the planner reads it for
   * watermark eligibility (§5.4). Not deletion evidence — that is minted in
   * memory by a full sweep and never read back off disk (INV-5).
   */
  complete: boolean;
  /** Shard file base names found in the directory, sorted. */
  fileNames: string[];
}

/** Two shard files in one directory disagree about the set's fan-out. */
export class ShardFanoutConflict extends Error {
  constructor(shardDir: string, seen: ShardFanout[]) {
    super(
      `Shard set ${shardDir} mixes fan-out levels (${seen.join(", ")}). ` +
        "This is a half-finished layout migration; run `mirror migrate` to complete it."
    );
    this.name = "ShardFanoutConflict";
  }
}

/**
 * Read one scope directory's shard set.
 *
 * Absent directory, absent files and an empty directory all produce the same
 * "nothing here yet" answer, because to every caller they mean the same thing: no
 * baseline, no sticky fan-out, no deletion authority.
 *
 * A shard file that exists but does not parse is NOT treated as nothing — it
 * throws. Treating a corrupt baseline as empty would tell the deletion logic that
 * every record the shard used to describe is now absent from the instance, which is
 * how a parse bug becomes a mass deletion. F8's contract is "stop, leave the tree
 * consistent", and that is what this does.
 */
export async function loadShardSet(
  fs: WriterFs,
  root: string,
  scope: string,
  table: string
): Promise<LoadedShardSet> {
  const shardDirRel = shardDirRelPath(scope, table);
  const shardDirAbs = toNativePath(root, shardDirRel);
  const listing = await fs.readDir(shardDirAbs);
  if (listing === null) {
    return { fanout: null, entries: new Map(), complete: false, fileNames: [] };
  }

  const fileNames = listing
    .filter(
      (entry) =>
        !entry.isDirectory &&
        !isStagingName(entry.name) &&
        entry.name.endsWith(SHARD_FILE_SUFFIX)
    )
    .map((entry) => entry.name)
    .sort();

  const entries = new Map<string, RecordEntry>();
  const fanouts = new Set<ShardFanout>();
  let complete = fileNames.length > 0;

  for (const fileName of fileNames) {
    const filePathRel = repoPath(shardDirRel, fileName);
    const bytes = await fs.readFile(toNativePath(root, filePathRel));
    /* istanbul ignore if -- @preserve: the listing said it was there; a race here
       is indistinguishable from "not there", and the next sweep re-reads. */
    if (bytes === null) {
      continue;
    }
    const manifest = parseShardManifest(UTF8_DECODER.decode(bytes), filePathRel);
    if (shardFileName(manifest.shard, manifest.fanout) !== fileName) {
      throw new ShardManifestCorrupt(
        filePathRel,
        `file name does not match shard "${manifest.shard}" at fanout ${manifest.fanout}`
      );
    }
    if (manifest.table !== table) {
      throw new ShardManifestCorrupt(
        filePathRel,
        `claims table ${manifest.table} but sits under ${table}`
      );
    }
    fanouts.add(manifest.fanout);
    complete = complete && manifest.complete;
    for (const [sysId, entry] of Object.entries(manifest.records)) {
      entries.set(sysId, entry);
    }
  }

  if (fanouts.size > 1) {
    throw new ShardFanoutConflict(shardDirRel, [...fanouts].sort());
  }
  const fanout = fanouts.size === 1 ? [...fanouts][0] : null;
  return {
    fanout: fanout ?? null,
    entries,
    complete: fanout === null ? false : complete,
    fileNames,
  };
}

/** Everything one flush needs to know. */
export interface ShardSetWrite {
  /** Repo root (native absolute path). */
  root: string;
  scope: string;
  table: string;
  fanout: ShardFanout;
  /** INV-4: `true` only when a full table sweep observed this whole set. */
  complete: boolean;
  /**
   * The sweep this flush belongs to — stamped into a shard only when that shard's
   * content actually changes.
   *
   * §4.3 puts `sweepId` in the manifest and says nothing about what it identifies,
   * which leaves two readings. "The last sweep that ran" is the one a naive flush
   * produces, and it is incompatible with INV-1: a re-run against an unchanged
   * instance would rewrite every shard file in the repository with a new id, so `git
   * status` would never be empty and every sync would manufacture a commit. "The
   * sweep that last CHANGED this shard" satisfies the same schema, satisfies INV-1,
   * and is the more useful of the two — under it a shard's `sweepId` and its `git
   * blame` agree, which is what someone reading the field is actually asking.
   *
   * The cost is one signal. Before, a `.shards/` directory whose files disagreed
   * about `sweepId` meant a flush had crashed part-way; now that is the ordinary
   * steady state and carries no information. Nothing depended on it — the crash was
   * always repaired by content comparison rather than by the id, and INV-4's
   * evidence is `complete`, not `sweepId` — but `mirror verify` must not be tempted
   * to read a mixed set as damage.
   */
  sweepId: string;
  /** Every record the set should claim after the flush, keyed by sys_id. */
  entries: ReadonlyMap<string, RecordEntry>;
}

/**
 * Write a whole shard set and delete whatever the fan-out no longer claims.
 *
 * The set is written file by file, each through {@link atomicWriteFile}, so no
 * individual shard is ever observed half written (R4). The SET, however, is not
 * atomic — a crash after shard `3` and before shard `4` leaves a directory whose
 * shards were written by two different sweeps. That is deliberate; making the set
 * atomic would mean staging the whole `.shards` directory and renaming it in, which
 * is 256 file writes for a one-record change and throws away the diff locality D15
 * exists to buy. It is also self-repairing without any special handling: the next
 * completed sweep recomputes the whole entry set from its own observation, so a shard
 * left describing the older state has content that disagrees with what that sweep
 * saw, and is rewritten for that reason.
 *
 * **A shard whose only difference is `sweepId` is not written** — see
 * {@link ShardSetWrite.sweepId} for why, and for what that costs.
 *
 * Returns the repo-relative paths actually written, in the order written, so the
 * caller can report exactly what landed. A skipped shard is absent from that list,
 * matching the writer's own `unchanged` outcome for records.
 */
export async function writeShardSet(fs: WriterFs, write: ShardSetWrite): Promise<string[]> {
  const shardDirRel = shardDirRelPath(write.scope, write.table);
  const shardDirAbs = toNativePath(write.root, shardDirRel);
  await fs.makeDir(shardDirAbs);

  const buckets = new Map<string, Record<string, RecordEntry>>();
  for (const key of enumerateExpectedKeys(write.fanout)) {
    buckets.set(key, {});
  }
  for (const [sysId, entry] of write.entries) {
    // INV-6 again, at the last moment before the sys_id becomes a shard key and a
    // manifest key. The writer validated on the way in; this is the guarantee for
    // any future caller that reaches the store directly.
    const key = shardKeyFor(sysId, write.fanout);
    const bucket = buckets.get(key);
    /* istanbul ignore if -- @preserve: shardKeyFor only yields enumerated keys. */
    if (bucket === undefined) {
      throw new ShardManifestCorrupt(shardDirRel, `no bucket for shard "${key}"`);
    }
    bucket[sysId] = entry;
  }

  const written: string[] = [];
  for (const [key, records] of buckets) {
    const fileName = shardFileName(key, write.fanout);
    const filePathRel = repoPath(shardDirRel, fileName);
    const filePathAbs = toNativePath(write.root, filePathRel);
    const manifest = buildShardManifest({
      table: write.table,
      shardKey: key,
      fanout: write.fanout,
      complete: write.complete,
      sweepId: write.sweepId,
      records,
    });
    const existing = await fs.readFile(filePathAbs);
    if (existing !== null && wouldOnlyRestampSweepId(existing, manifest)) {
      continue;
    }
    await atomicWriteFile(fs, filePathAbs, renderShardManifest(manifest));
    written.push(filePathRel);
  }

  await pruneShardDirectory(fs, write.root, shardDirRel, write.fanout);
  return written;
}

/**
 * Whether writing `manifest` over `existing` would change nothing but the sweep id.
 *
 * Decided by rendering, not by comparing fields: the question is about the BYTES on
 * disk, and the only thing that can answer a question about bytes without being a
 * second, drifting copy of §8's rules is the renderer that produced them. So the
 * incoming manifest is re-rendered wearing the sweep id the file already carries,
 * and the two byte strings are compared. If they match, the file on disk is already
 * exactly what this sweep would write apart from the id — which is the definition of
 * "this shard did not change".
 *
 * An existing file that will not parse, or that carries no usable `sweepId`, answers
 * `false` and is overwritten. That is not the same judgement `loadShardSet` makes on
 * a corrupt shard, and the difference is deliberate: there, a corrupt file is a
 * deletion baseline that would authorise removing every record it failed to describe,
 * so it must stop the sweep. Here the sweep has already computed the correct content
 * independently, and the corrupt file is simply garbage in the way of it.
 */
function wouldOnlyRestampSweepId(existing: Uint8Array, manifest: ShardManifest): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(existing)) as unknown;
  } catch {
    return false;
  }
  if (!isPlainObject(parsed) || typeof parsed.sweepId !== "string") {
    return false;
  }
  const restamped = renderShardManifest({ ...manifest, sweepId: parsed.sweepId });
  return bytesEqual(existing, restamped);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

/** Shard keys of a set at this fan-out, as an ordered list (0 → `[""]`). */
function enumerateExpectedKeys(fanout: ShardFanout): string[] {
  return shardFileNamesFor(fanout).map((fileName) =>
    fileName === SINGLE_SHARD_FILE
      ? ""
      : fileName.slice(0, fileName.length - SHARD_FILE_SUFFIX.length)
  );
}

/**
 * Delete every file in `.shards/` that the current fan-out does not claim.
 *
 * This is what makes a fan-out change (`mirror migrate`, D16) converge instead of
 * leaving the old level's files behind to be read back as a fan-out conflict on the
 * next sweep. It also sweeps up staging leftovers from a crashed run.
 *
 * Subdirectories are left alone. Nothing this package writes creates one, so a
 * directory inside `.shards/` was put there by someone else, and silently deleting
 * a user's tree because it sits in a directory the mirror manages is a far worse
 * outcome than an untidy listing.
 */
async function pruneShardDirectory(
  fs: WriterFs,
  root: string,
  shardDirRel: string,
  fanout: ShardFanout
): Promise<void> {
  const keep = new Set(shardFileNamesFor(fanout));
  const listing = await fs.readDir(toNativePath(root, shardDirRel));
  /* istanbul ignore if -- @preserve: writeShardSet just created this directory. */
  if (listing === null) {
    return;
  }
  for (const entry of listing) {
    if (entry.isDirectory || keep.has(entry.name)) {
      continue;
    }
    if (!entry.name.endsWith(SHARD_FILE_SUFFIX) && !isStagingName(entry.name)) {
      continue;
    }
    const victimRel = repoPath(shardDirRel, entry.name);
    /* istanbul ignore if -- @preserve: names come from a directory listing, so a
       traversal segment cannot appear; the check is the belt to the store's braces. */
    if (!isContainedRepoPath(victimRel)) {
      continue;
    }
    await removeFileIfPresent(fs, toNativePath(root, victimRel));
  }
}

/**
 * Every scope directory that already holds a shard set for a table.
 *
 * A full table sweep must be authoritative over the whole table, and "the whole
 * table" includes a scope whose records were all deleted since the last sweep —
 * that scope will never appear in the sweep's own output, so without this listing it
 * would keep a shard set claiming records that no longer exist, and INV-5 would
 * never authorise removing them. One `readdir` of `instance/` per completed table is
 * a negligible price for closing that hole.
 */
export async function listScopesWithShards(
  fs: WriterFs,
  root: string,
  table: string
): Promise<string[]> {
  // Validated here as well as in the writer: this function joins the table into a
  // path directly, so it must not depend on a caller having checked first (INV-6's
  // sibling rule for the components that are not sys_ids).
  assertMirrorPathComponent(table, "table name");
  const listing = await fs.readDir(toNativePath(root, INSTANCE_DIR_NAME));
  if (listing === null) {
    return [];
  }
  const scopes: string[] = [];
  for (const entry of listing) {
    // Staging names are excluded for the same reason `loadShardSet` and
    // `pruneShardDirectory` exclude them: a directory whose name carries the prefix
    // is a crashed run's garbage awaiting deletion, and treating it as a scope would
    // make the next completed sweep flush a fresh shard set into it — promoting the
    // leftover to permanent, committed tree content, and minting INV-5 deletion
    // evidence for records nobody is mirroring.
    if (!entry.isDirectory || isStagingName(entry.name)) {
      continue;
    }
    const shardDirAbs = toNativePath(
      root,
      repoPath(INSTANCE_DIR_NAME, entry.name, table, SHARD_DIR_NAME)
    );
    const shardListing = await fs.readDir(shardDirAbs);
    if (shardListing !== null) {
      scopes.push(entry.name);
    }
  }
  return scopes.sort();
}
