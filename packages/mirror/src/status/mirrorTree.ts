// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Enumeration of the (scope, table) pairs the mirror tree actually holds.
 *
 * `mirror status` needs the disk side of its comparison (§5.10) and `mirror
 * verify` needs the set of shard manifests to walk; both questions reduce to
 * "which `instance/<scope>/<table>/` directories carry a shard set?". The
 * writer's own reader family answers it per table (`listScopesWithShards`), but
 * status and verify start from NO table list — a table that vanished from the
 * live catalog is precisely the one nobody would name — so the enumeration has
 * to come off the tree itself. This module is that enumeration, written once so
 * the detector and the verifier cannot disagree about what "mirrored" means.
 *
 * What counts as a pair, and what is skipped, mirrors `listScopesWithShards`
 * and `loadShardSet` decision for decision:
 *
 * - Staging names (`isStagingName`) are a crashed run's garbage awaiting
 *   deletion, at scope level and table level alike, exactly as the shard store
 *   treats them. Reading them as content would resurrect what the next sweep
 *   will delete.
 *
 * - Names that fail sn-transport's `isSafePathComponent` are skipped: the
 *   writer is structurally unable to create such a directory (every component
 *   it joins passes `assertMirrorPathComponent` first), so whatever carries the
 *   name is a foreign object, not mirror content — and `loadShardSet` would
 *   refuse to join it into a path anyway (`shardDirRelPath` asserts both
 *   components). Skipping is not a silent verdict: nothing inside such a
 *   directory can be claimed by any manifest, and both commands scope their
 *   verdicts to what a manifest could claim (R3 obliges a verdict per TABLE
 *   examined, not an opinion on every inode in the repository).
 *
 * - A `.shards` directory that exists but holds no shard files claims nothing
 *   and is reported as no pair — the same reading `loadShardSet` gives it
 *   (`fanout: null`, `complete: false`). The detector therefore sees such a
 *   table as unmirrored and the verifier has no manifest to verify; neither
 *   invents a claim from an empty directory (INV-5's spirit: absence of
 *   evidence is never evidence of deletion).
 *
 * The result is sorted bytewise by scope then table — `compareBytewise`, never
 * a locale — so every downstream report is a function of tree content alone,
 * independent of readdir order (the same determinism rule the shard store's
 * own walks follow).
 */

import { compareBytewise } from "../order";
import {
  INSTANCE_DIR_NAME,
  SHARD_DIR_NAME,
  SHARD_FILE_SUFFIX,
  repoPath,
} from "../shards/shardLayout";
import { isStagingName } from "../write/atomicWrite";
import { toNativePath } from "../write/fs";
import { isSafePathComponent } from "@syncrona/sn-transport";
import type { MirrorReadFs } from "./readOnlyFs";
import type { WriterDirEntry } from "../write/fs";

/** One shard-bearing `instance/<scope>/<table>/` directory. */
export interface MirroredTablePair {
  scope: string;
  table: string;
}

/**
 * Directory names that could be mirror content: directories, not staging
 * leftovers, and joinable into a mirror path. Sorted bytewise so callers
 * iterate deterministically regardless of the underlying readdir order.
 */
function mirrorChildDirs(listing: readonly WriterDirEntry[]): string[] {
  return listing
    .filter(
      (entry) =>
        entry.isDirectory &&
        !isStagingName(entry.name) &&
        isSafePathComponent(entry.name)
    )
    .map((entry) => entry.name)
    .sort(compareBytewise);
}

/**
 * Every (scope, table) pair under `instance/` that carries at least one shard
 * file. An absent `instance/` directory is an empty mirror, not an error —
 * `mirror status` against a fresh clone must be able to say "nothing mirrored"
 * rather than crash (`readOnlyFs`'s standard: errors are for bugs, verdicts
 * are for states).
 */
export async function listMirroredTablePairs(
  fs: MirrorReadFs,
  root: string
): Promise<MirroredTablePair[]> {
  const scopeListing = await fs.readDir(toNativePath(root, INSTANCE_DIR_NAME));
  if (scopeListing === null) {
    return [];
  }
  const pairs: MirroredTablePair[] = [];
  for (const scope of mirrorChildDirs(scopeListing)) {
    const tableListing = await fs.readDir(
      toNativePath(root, repoPath(INSTANCE_DIR_NAME, scope))
    );
    /* istanbul ignore if -- @preserve: the parent listing named this directory a
       moment ago; only a concurrent deletion between the two readdir calls can
       make it null, and the next run re-reads. */
    if (tableListing === null) {
      continue;
    }
    for (const table of mirrorChildDirs(tableListing)) {
      const shardListing = await fs.readDir(
        toNativePath(
          root,
          repoPath(INSTANCE_DIR_NAME, scope, table, SHARD_DIR_NAME)
        )
      );
      // Same shard-file filter `loadShardSet` applies: files, not staging
      // leftovers, carrying the shard suffix. A `.shards` directory holding
      // only a crashed write's staging file claims nothing.
      const hasShardFile =
        shardListing !== null &&
        shardListing.some(
          (entry) =>
            !entry.isDirectory &&
            !isStagingName(entry.name) &&
            entry.name.endsWith(SHARD_FILE_SUFFIX)
        );
      if (!hasShardFile) {
        continue;
      }
      pairs.push({ scope, table });
    }
  }
  return pairs;
}
