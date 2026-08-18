// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Verifier — the engine behind `mirror verify` (architecture §5.10).
 *
 * The shard manifests are the mirror's claims about the tree; this stage walks
 * the claims and checks the tree against them. Per (scope, table) pair it
 * performs two tiers of checking:
 *
 * - Cheap and total: the record directories the table directory actually holds
 *   versus the names the manifests claim, both ways. A claimed record whose
 *   directory is gone (the hand-deletion the writer's docblocks defer to
 *   `mirror verify` by name) is `record-dir-missing`; a child no manifest
 *   claims is `unclaimed-path`. This costs one readdir per table.
 *
 * - Sampled and deep: every Kth claimed record, in bytewise `sys_id` order
 *   starting from the first, has its `record.json` bytes re-read from disk and
 *   re-hashed against the entry's `contentHash`; its extracted files are
 *   checked for existence (they are deliberately OUTSIDE the content hash, so
 *   existence is all the manifest promises about them); and its attachments
 *   are re-hashed against their recorded `sha256`. K = 1 is a full walk.
 *
 * Re-hashing off disk, not re-fetching: §5.10 once described the spot-check as
 * "re-fetch → compare `contentHash`", and the two answer different questions.
 * Re-fetching checks the mirror against the live instance — that is `mirror
 * status --deep`, which does exactly that — while re-hashing checks the tree
 * against its own manifests, which is the question "did anything corrupt,
 * truncate or hand-edit the mirror?" that a verifier of local integrity can
 * answer with no network at all. §5.10 now states the re-hash, so this is the
 * spec rather than a deviation from it; the paragraph stays because the choice
 * is the reason `mirror verify` is the one command that works offline.
 *
 * "Reports, never mutates" (§5.10) is structural here: the only filesystem
 * capability this module accepts is {@link MirrorReadFs}, and the shard reader
 * it reuses gets that seam widened through `readOnlyWriterFs`, whose mutating
 * methods throw. The test suite additionally proves the property from the
 * outside with a recording fs spy.
 *
 * INV-4 discipline: completion is read off the manifests' `complete` flag and
 * NOWHERE else. In particular `sweepId` is never read — a shard set whose
 * files carry different sweepIds is the ordinary steady state of incremental
 * sweeps (only rewritten shards get restamped) and carries no information;
 * the shard store's docblock names `mirror verify` as the tool that must not
 * be tempted to read a mixed set as damage, and this file is where that
 * temptation is refused. An incomplete set (`complete: false`) is likewise a
 * checkpoint state, not damage: it is reported in the pair's outcome row and
 * is NOT a finding.
 *
 * Damage the shard reader itself refuses — `ShardManifestCorrupt`,
 * `ShardFanoutConflict` — becomes a finding for that pair and the walk moves
 * on to the next pair: verify's whole purpose is to report damage, so damage
 * must not stop it (contrast the writer, where F8's contract is to stop). What
 * a corrupt manifest can never become is an empty one (INV-5): the pair gets a
 * named finding and NO outcome row, never a "0 records, all fine" reading.
 *
 * Exit contract (R1): 0 when there are no findings, 2 when there are any,
 * derived from the findings and never accepted from a caller.
 */

import type { RecordEntry } from "../contracts";
import { compareBytewise } from "../order";
import {
  INSTANCE_DIR_NAME,
  RECORD_FILE_NAME,
  SHARD_DIR_NAME,
  ShardManifestCorrupt,
  repoPath,
  shardDirRelPath,
} from "../shards/shardLayout";
import { ShardFanoutConflict, loadShardSet } from "../shards/shardStore";
import type { LoadedShardSet } from "../shards/shardStore";
import { isStagingName } from "../write/atomicWrite";
import { ATTACHMENTS_DIR_NAME } from "../write/attachments";
import { sha256Hex } from "../write/contentHash";
import { toNativePath } from "../write/fs";
import { listMirroredTablePairs } from "./mirrorTree";
import { readOnlyWriterFs } from "./readOnlyFs";
import type { MirrorReadFs } from "./readOnlyFs";

export interface VerifierOptions {
  fs: MirrorReadFs;
  /** Repo root, native absolute path. */
  root: string;
  /**
   * Every Kth claimed record (bytewise `sys_id` order, starting from the
   * first) gets its content checks. Must be an integer >= 1; 1 = full walk.
   * The cheap directory cross-check always covers every record regardless.
   */
  sampleEvery: number;
}

export type VerifyFindingKind =
  | "shard-corrupt"
  | "shard-fanout-conflict"
  | "record-dir-missing"
  | "unclaimed-path"
  | "record-json-missing"
  | "content-hash-mismatch"
  | "extracted-file-missing"
  | "attachment-missing"
  | "attachment-hash-mismatch";

/** One discrepancy between the tree and what its manifests claim. */
export interface VerifyFinding {
  kind: VerifyFindingKind;
  scope: string;
  table: string;
  /** The record the finding is about, or null when it names no single record. */
  sysId: string | null;
  /** Repo-relative path of the object named, or null when no one path is it. */
  path: string | null;
  detail: string;
}

/**
 * One verified (scope, table) pair. Pairs whose shard set could not be loaded
 * at all get a finding instead of a row — a corrupt manifest must never read
 * as "0 records, verified" (INV-5).
 */
export interface VerifyTableOutcome {
  scope: string;
  table: string;
  /** INV-4 evidence — read off the manifests' `complete`, never off sweepId. */
  complete: boolean;
  recordsClaimed: number;
  recordsSampled: number;
  findings: number;
}

/** JSON-ready result of one `mirror verify` run. */
export interface MirrorVerifyResult {
  /** In walk order: bytewise by scope, then table (deterministic, INV-1's spirit). */
  tables: VerifyTableOutcome[];
  findings: VerifyFinding[];
  /** Derived from the findings, never accepted: 0 = clean, 2 = findings exist. */
  exitCode: 0 | 2;
}

/** Walk the shard manifests and check the tree against their claims. */
export async function verifyMirror(
  options: VerifierOptions
): Promise<MirrorVerifyResult> {
  // A caller bug, not a tree state: no finding vocabulary applies.
  if (!Number.isInteger(options.sampleEvery) || options.sampleEvery < 1) {
    throw new Error(
      `verify sampling interval must be an integer >= 1, got ${String(options.sampleEvery)}`
    );
  }
  const reader = readOnlyWriterFs(options.fs);
  const pairs = await listMirroredTablePairs(options.fs, options.root);
  const findings: VerifyFinding[] = [];
  const tables: VerifyTableOutcome[] = [];
  for (const { scope, table } of pairs) {
    let set: LoadedShardSet;
    try {
      set = await loadShardSet(reader, options.root, scope, table);
    } catch (error) {
      if (error instanceof ShardManifestCorrupt) {
        findings.push({
          kind: "shard-corrupt",
          scope,
          table,
          sysId: null,
          path: error.shardPath,
          detail: error.message,
        });
        continue;
      }
      if (error instanceof ShardFanoutConflict) {
        findings.push({
          kind: "shard-fanout-conflict",
          scope,
          table,
          sysId: null,
          path: shardDirRelPath(scope, table),
          detail: error.message,
        });
        continue;
      }
      throw error;
    }
    const pairFindings = await verifyPair(options, scope, table, set);
    findings.push(...pairFindings.findings);
    tables.push({
      scope,
      table,
      complete: set.complete,
      recordsClaimed: set.entries.size,
      recordsSampled: pairFindings.recordsSampled,
      findings: pairFindings.findings.length,
    });
  }
  return { tables, findings, exitCode: findings.length > 0 ? 2 : 0 };
}

interface PairResult {
  findings: VerifyFinding[];
  recordsSampled: number;
}

/**
 * All checks for one loaded pair, in deterministic order: unclaimed children
 * first (bytewise by name), then missing record directories (bytewise by
 * sys_id), then the sampled content checks (bytewise by sys_id).
 *
 * Coherence note: the directory cross-check goes by `entry.name` against the
 * standard table directory, while content reads go by `entry.path` — the
 * writer guarantees the two agree (`path` = `instance/<scope>/<table>/<name>`,
 * decided once in `write/recordPath`), and the parser guarantees containment.
 * A hand-edited manifest whose `path` points elsewhere therefore surfaces as
 * `record-dir-missing` at the standard location, whose detail carries the
 * divergent claimed path for the operator to follow.
 */
async function verifyPair(
  options: VerifierOptions,
  scope: string,
  table: string,
  set: LoadedShardSet
): Promise<PairResult> {
  const findings: VerifyFinding[] = [];
  const tableDirRel = repoPath(INSTANCE_DIR_NAME, scope, table);
  const listing = await options.fs.readDir(toNativePath(options.root, tableDirRel));
  /* istanbul ignore next -- @preserve: shard files were read out of a
     subdirectory of this directory a moment ago, so only a concurrent deletion
     between the two calls can make the listing null; the next run re-reads. */
  const children = listing ?? [];

  const claimedNames = new Set<string>();
  for (const entry of set.entries.values()) {
    claimedNames.add(entry.name);
  }

  // Unclaimed children: anything in the table directory that is neither the
  // shard directory, nor a crashed write's staging leftover, nor a directory
  // some manifest entry claims by name. A FILE with a claimed name is still
  // unclaimed — the claim is for a record directory.
  const presentDirs = new Set<string>();
  const unclaimed: string[] = [];
  for (const child of children) {
    if (child.name === SHARD_DIR_NAME || isStagingName(child.name)) {
      continue;
    }
    if (child.isDirectory) {
      presentDirs.add(child.name);
      if (claimedNames.has(child.name)) {
        continue;
      }
    }
    unclaimed.push(child.name);
  }
  for (const name of unclaimed.sort(compareBytewise)) {
    findings.push({
      kind: "unclaimed-path",
      scope,
      table,
      sysId: null,
      path: repoPath(tableDirRel, name),
      detail: `no shard manifest claims ${name} in ${tableDirRel}`,
    });
  }

  // Missing record directories: total over every claimed record, one readdir.
  const sysIds = [...set.entries.keys()].sort(compareBytewise);
  const missingDirs = new Set<string>();
  for (const sysId of sysIds) {
    const entry = set.entries.get(sysId) as RecordEntry;
    if (!presentDirs.has(entry.name)) {
      missingDirs.add(sysId);
      findings.push({
        kind: "record-dir-missing",
        scope,
        table,
        sysId,
        path: entry.path,
        detail: `manifest claims record directory ${entry.path} and the table directory has no ${entry.name}`,
      });
    }
  }

  // Sampled content checks. A record already reported record-dir-missing still
  // counts as sampled (it was selected) but is not re-read — its one finding
  // already says everything a failed read would.
  let recordsSampled = 0;
  for (let index = 0; index < sysIds.length; index += options.sampleEvery) {
    const sysId = sysIds[index];
    recordsSampled += 1;
    if (missingDirs.has(sysId)) {
      continue;
    }
    const entry = set.entries.get(sysId) as RecordEntry;
    findings.push(...(await verifyRecord(options, scope, table, sysId, entry)));
  }

  return { findings, recordsSampled };
}

/** The content checks for one sampled record. */
async function verifyRecord(
  options: VerifierOptions,
  scope: string,
  table: string,
  sysId: string,
  entry: RecordEntry
): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = [];

  const recordJsonRel = repoPath(entry.path, RECORD_FILE_NAME);
  const bytes = await options.fs.readFile(toNativePath(options.root, recordJsonRel));
  if (bytes === null) {
    findings.push({
      kind: "record-json-missing",
      scope,
      table,
      sysId,
      path: recordJsonRel,
      detail: `manifest records contentHash ${entry.contentHash} and ${recordJsonRel} does not exist`,
    });
  } else {
    const actual = sha256Hex(bytes);
    if (actual !== entry.contentHash) {
      findings.push({
        kind: "content-hash-mismatch",
        scope,
        table,
        sysId,
        path: recordJsonRel,
        detail: `manifest records contentHash ${entry.contentHash} but ${recordJsonRel} hashes to ${actual}`,
      });
    }
  }

  // Extracted files sit OUTSIDE the content hash by design (the tracking
  // columns rule out content changing while only the extracted view is stale),
  // so existence is the whole claim being checked.
  //
  // The names are joined to `entry.path` without a further check because
  // `parseShardManifest` holds every member of `files` to the same component
  // rule as `name` and an attachment's `fileName`: a hostile manifest is
  // rejected whole, as `shard-corrupt`, before any entry reaches this walk. A
  // second check here would be a second answer to "is this name usable", and
  // the one that fires later is the one that reads the file.
  for (const fileName of entry.files) {
    const fileRel = repoPath(entry.path, fileName);
    const fileBytes = await options.fs.readFile(toNativePath(options.root, fileRel));
    if (fileBytes === null) {
      findings.push({
        kind: "extracted-file-missing",
        scope,
        table,
        sysId,
        path: fileRel,
        detail: `manifest lists extracted file ${fileName} and ${fileRel} does not exist`,
      });
    }
  }

  // Attachments carry their own recorded sha256, so they get the full hash
  // check — except LFS ones, where the on-disk file is a pointer text unless
  // git-lfs smudged it and this stage cannot know which; existence is the
  // strongest deterministic claim available (design §8.4; WP-M12 owns doing
  // better, e.g. by recognizing pointer files).
  for (const attachment of entry.attachments ?? []) {
    const attachmentRel = repoPath(
      ATTACHMENTS_DIR_NAME,
      table,
      sysId,
      `${attachment.sysId}_${attachment.fileName}`
    );
    const attachmentBytes = await options.fs.readFile(
      toNativePath(options.root, attachmentRel)
    );
    if (attachmentBytes === null) {
      findings.push({
        kind: "attachment-missing",
        scope,
        table,
        sysId,
        path: attachmentRel,
        detail: `manifest lists attachment ${attachment.sysId} (${attachment.fileName}) and ${attachmentRel} does not exist`,
      });
      continue;
    }
    if (attachment.lfs) {
      continue;
    }
    const actual = sha256Hex(attachmentBytes);
    if (actual !== attachment.sha256) {
      findings.push({
        kind: "attachment-hash-mismatch",
        scope,
        table,
        sysId,
        path: attachmentRel,
        detail: `manifest records sha256 ${attachment.sha256} for attachment ${attachment.sysId} but ${attachmentRel} hashes to ${actual}`,
      });
    }
  }

  return findings;
}
