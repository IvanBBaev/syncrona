// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Writer — §5.8, WP-M7.
 *
 * Last stage of the pipeline and the only one that touches the user's git working
 * tree. It takes a {@link RedactedRecord}, decides where it lives, puts it there
 * without ever exposing a half-written file (R4), keeps the table's shard set in
 * memory until the table's sweep completes (INV-4), and — when and only when a full
 * sweep completed — hands out the evidence that authorises deletions (INV-5).
 *
 * **INV-3 is a compile-time fact here, not a runtime check.** {@link
 * RecordWriteRequest.record} is typed `RedactedRecord`, whose brand is a `unique
 * symbol` no expression in the language can produce outside `serialize/redactor.ts`.
 * So there is no validation of it in this file and there should never be: a
 * `SerializedRecord` (pre-redaction, possibly holding secrets) cannot be passed to
 * `writeRecord` at all, and `test/writerContract.test.ts` compiles the attempt to
 * prove the diagnostic exists rather than trusting the claim.
 *
 * **Shape of the API.** A {@link MirrorWriter} per sweep, a {@link TableSweepWriter}
 * per table. INV-4 is about a table's boundary, so the object whose lifetime is a
 * table's sweep is the object that owns the unflushed shard state: the only way to
 * get shards onto disk is {@link TableSweepWriter.completeTable}, and the only way
 * to get a {@link DeletionAuthority} is the same call on a full sweep. An
 * interrupted sweep simply never makes that call, and the invariant holds because
 * there is no other door — not because a flag was checked.
 *
 * **What this file deliberately does not do.** It does not fetch, retry, decide
 * which tables to sweep, or read the checkpoint back; it reports progress into a
 * {@link SweepProgressSink} and never consults it. It does not delete a record on
 * its own initiative — {@link applyAuthorizedDeletion} needs an authority object,
 * and an authority object needs a completed sweep's own evidence.
 */
import { LFS_THRESHOLD_BYTES } from "../constants";
import type { RecordEntry, RedactedRecord } from "../contracts";
import {
  assertMirrorPathComponent,
  assertMirrorSysId,
  INSTANCE_DIR_NAME,
  MirrorPathRejection,
  RECORD_FILE_NAME,
  recordDirRelPath,
  repoPath,
  stickyFanout,
  type ShardFanout,
} from "../shards/shardLayout";
import {
  listScopesWithShards,
  loadShardSet,
  writeShardSet,
} from "../shards/shardStore";
import {
  applyAttachmentPlan,
  attachmentDirRelPath,
  planRecordAttachments,
  type AttachmentPayload,
  type AttachmentPlan,
} from "./attachments";
import {
  atomicRemoveDir,
  atomicWriteFile,
  isStagingName,
  removeFileIfPresent,
  stagingSiblingOf,
} from "./atomicWrite";
import { sha256Hex } from "./contentHash";
import {
  DeletionAuthority,
  type AuthorizedDeletion,
  type SweptScopeEvidence,
} from "./deletionAuthority";
import { nodeWriterFs, toNativePath, type WriterFs } from "./fs";
import { RecordNameResolver, type RecordRename } from "./recordPath";
import {
  nullProgressSink,
  type MirrorSweepMode,
  type SweepProgressSink,
} from "./sweepProgress";

/** One record offered to the Writer. */
export interface RecordWriteRequest {
  /** The record's final bytes. `RedactedRecord` and nothing else — INV-3. */
  record: RedactedRecord;
  /** Scope directory the record belongs to (`global`, `x_acme_app`, …). */
  scope: string;
  /**
   * Display name to fold into a directory name — usually `name`, but the field
   * differs per table (§7.4), so choosing it is the caller's job, not the Writer's.
   */
  displayName: string;
  /** `sys_updated_on` exactly as the instance reported it. */
  sysUpdatedOn: string;
  /** `sys_updated_by` exactly as the instance reported it. */
  sysUpdatedBy: string;
  /** `sys_mod_count` exactly as the instance reported it. */
  sysModCount: number;
  /**
   * Attachments the sweep fetched for this record (WP-M12), or `undefined` when
   * it did not fetch any.
   *
   * The distinction between `undefined` and `[]` is load-bearing and is the
   * reason this is not simply defaulted to an empty array. `[]` means the sweep
   * asked and the record has none, which authorises emptying the record's
   * attachment directory; `undefined` means the sweep never asked — attachments
   * are disabled in the config — and nothing on disk may be touched. Collapsing
   * the two would make a single run with `attachments.enabled: false` delete
   * every attachment the mirror had ever downloaded, a deletion with no evidence
   * behind it at all (INV-5's spirit, applied outside the shard set).
   */
  attachments?: readonly AttachmentPayload[];
}

/**
 * What happened to one record.
 *
 * There is no `skipped` outcome, and that is a decision rather than an omission.
 * R3 forbids silent skips; the way this file honours it is by having nothing to
 * skip. Every input that could have produced one — a hostile sys_id, an unusable
 * scope or table, an extracted file name that is not a path component — throws
 * {@link MirrorPathRejection} instead, so the caller cannot fail to notice it, and
 * the one remaining candidate (a record with no containable name) is impossible; see
 * the theorem on `NameAdmission.name`.
 */
export interface RecordWriteOutcome {
  /** `unchanged` means the bytes on disk already matched, so nothing was written. */
  status: "written" | "unchanged";
  sysId: string;
  /** Repo-relative record directory. */
  path: string;
  /** The shard entry this record now has. */
  entry: RecordEntry;
  /** Records whose directories this admission moved (F9). */
  renames: RecordRename[];
}

/** What a completed table sweep produced. */
export interface TableCompletion {
  table: string;
  mode: MirrorSweepMode;
  /**
   * Whether every shard set this sweep flushed claims a complete index. A full
   * sweep always does; an incremental flush carries its baseline's claim forward
   * (see {@link TableSweepWriter.completeTable}), so this is `false` only when an
   * incremental sweep touched a scope that had no complete baseline. NOT deletion
   * evidence — that is {@link authority}, and only a full sweep mints one.
   */
  complete: boolean;
  /** Repo-relative shard files written, in write order. */
  shardsWritten: string[];
  /** How many records the shard set now claims, across every scope. */
  recordCount: number;
  /**
   * Deletion evidence — `null` for anything but a completed full sweep. The
   * reconciler (WP-M10) cannot delete without one, so `null` is not an
   * inconvenience, it is INV-5 saying no.
   */
  authority: DeletionAuthority | null;
}

/** Options for a sweep's Writer. */
export interface MirrorWriterOptions {
  /** Absolute native path of the mirror repository root. */
  root: string;
  /** Identifier of this sweep; stamped into every shard it writes. */
  sweepId: string;
  /** Sweep mode; `full` is the only one that can authorise deletions. */
  mode?: MirrorSweepMode;
  /** Filesystem seam; defaults to the real one. */
  fs?: WriterFs;
  /** Where progress is reported. Defaults to discarding it. */
  progress?: SweepProgressSink;
  /**
   * Write every record even when its shard entry says nothing changed.
   *
   * Off by default, because the incremental sweep's value is that an unchanged
   * record costs nothing on disk and therefore produces no git diff. `mirror repair`
   * (WP-M10) turns it on: its whole purpose is to distrust the shard and rebuild the
   * tree from what the instance says, and for that job the shortcut below is
   * precisely the thing that must not fire.
   */
  rewriteUnchanged?: boolean;
  /**
   * Size at or above which an attachment is stored through git-LFS (§11).
   *
   * Injected rather than read from the config here because the Writer takes no
   * `MirrorConfig` at all — it is handed exactly the facts it needs, which is what
   * keeps `test/writerInv6.test.ts` able to construct one from nothing. Defaults
   * to {@link LFS_THRESHOLD_BYTES}, so a caller that never mentions attachments
   * still gets the measured threshold rather than an accidental zero.
   */
  lfsThresholdBytes?: number;
}

/** Per-sweep Writer. One instance per `mirror sync` run. */
export class MirrorWriter {
  private readonly options: Required<
    Omit<
      MirrorWriterOptions,
      "mode" | "fs" | "progress" | "rewriteUnchanged" | "lfsThresholdBytes"
    >
  > & {
    mode: MirrorSweepMode;
    fs: WriterFs;
    progress: SweepProgressSink;
    rewriteUnchanged: boolean;
    lfsThresholdBytes: number;
  };

  constructor(options: MirrorWriterOptions) {
    this.options = {
      root: options.root,
      sweepId: options.sweepId,
      mode: options.mode ?? "full",
      fs: options.fs ?? nodeWriterFs(),
      progress: options.progress ?? nullProgressSink(),
      rewriteUnchanged: options.rewriteUnchanged ?? false,
      lfsThresholdBytes: options.lfsThresholdBytes ?? LFS_THRESHOLD_BYTES,
    };
  }

  /**
   * Start sweeping one table.
   *
   * The table name is validated here rather than on first record: a sweep of a table
   * whose name cannot be a directory is not a sweep that should get as far as
   * fetching rows, and failing at the boundary makes the error name the table
   * instead of the first record that happened to arrive.
   */
  beginTable(table: string, options?: { mode?: MirrorSweepMode }): TableSweepWriter {
    assertMirrorPathComponent(table, "table name");
    return new TableSweepWriter({
      root: this.options.root,
      sweepId: this.options.sweepId,
      table,
      mode: options?.mode ?? this.options.mode,
      fs: this.options.fs,
      progress: this.options.progress,
      rewriteUnchanged: this.options.rewriteUnchanged,
      lfsThresholdBytes: this.options.lfsThresholdBytes,
    });
  }
}

/** Everything one scope directory needs while its table is being swept. */
interface ScopeState {
  scope: string;
  resolver: RecordNameResolver;
  /** What the shard set claimed before this sweep (paths updated by renames). */
  baseline: Map<string, RecordEntry>;
  /** Fan-out already on disk, or `null` when this scope has no shards yet (D16). */
  baselineFanout: ShardFanout | null;
  /**
   * Whether the baseline shard set claimed a complete index. An incremental flush
   * must carry this claim forward rather than re-derive it from its own mode — see
   * {@link TableSweepWriter.completeTable}.
   */
  baselineComplete: boolean;
  /** What this sweep observed and wrote. */
  observed: Map<string, RecordEntry>;
  /**
   * Directories a record left when this sweep wrote it under a new name, derived
   * from the baseline name and never read from the shard file (see
   * {@link TableSweepWriter.removeVacatedDirs}).
   */
  vacated: Set<string>;
}

interface TableSweepWriterOptions {
  root: string;
  sweepId: string;
  table: string;
  mode: MirrorSweepMode;
  fs: WriterFs;
  progress: SweepProgressSink;
  rewriteUnchanged: boolean;
  lfsThresholdBytes: number;
}

/**
 * One table's sweep. Holds the unflushed shard state — INV-4's whole point.
 *
 * State is per scope, because a shard set is per `(scope, table)` (see
 * `shards/shardStore.ts`) and because names only collide inside one directory. The
 * per-scope state is created lazily on the first record of that scope, so a table
 * that turns out to live in one scope pays for one baseline read, not for every
 * scope the instance has.
 */
export class TableSweepWriter {
  readonly table: string;
  readonly mode: MirrorSweepMode;
  private readonly root: string;
  private readonly sweepId: string;
  private readonly fs: WriterFs;
  private readonly progress: SweepProgressSink;
  private readonly rewriteUnchanged: boolean;
  private readonly lfsThresholdBytes: number;
  private readonly scopes = new Map<string, ScopeState>();
  /**
   * Set by {@link completeTable} and {@link abandon}. A sweep writer is a
   * single-use object: reusing one after its shards are flushed would append to a
   * set that already claimed to be complete, which is the exact false claim R2
   * forbids.
   */
  private closed: "completed" | "abandoned" | null = null;

  constructor(options: TableSweepWriterOptions) {
    this.root = options.root;
    this.sweepId = options.sweepId;
    this.table = options.table;
    this.mode = options.mode;
    this.fs = options.fs;
    this.progress = options.progress;
    this.rewriteUnchanged = options.rewriteUnchanged;
    this.lfsThresholdBytes = options.lfsThresholdBytes;
  }

  /**
   * Write one record and update the in-memory shard for its scope.
   *
   * Order of operations is deliberate and is the substance of INV-6: the sys_id is
   * validated, then the name is resolved, then the path is derived, and only then
   * does anything reach the filesystem. `test/writerInv6.test.ts` fuzzes hostile
   * sys_ids against a recording seam and asserts that a rejected record produced
   * zero filesystem calls — a claim that is only true because nothing above the
   * derivation touches disk.
   */
  async writeRecord(request: RecordWriteRequest): Promise<RecordWriteOutcome> {
    this.assertOpen("write a record");
    const { record } = request;
    assertMirrorSysId(record.sysId);
    if (record.table !== this.table) {
      // Filing a record under the wrong table's shards would make both tables lie:
      // one claims a record it does not own, the other never mentions it and would
      // authorise its deletion on the next full sweep.
      throw new MirrorPathRejection(
        `record ${record.sysId} belongs to ${record.table}, not ${this.table}`,
        record.table
      );
    }
    const scope = await this.scopeState(request.scope);

    const admission = scope.resolver.admit(record.sysId, request.displayName);
    await this.applyRenames(scope, admission.renames);

    const relDir = recordDirRelPath({
      scope: scope.scope,
      table: this.table,
      sysId: record.sysId,
      name: admission.name,
    });
    const files = record.extractedFiles.map((file) => file.fileName).sort();
    for (const fileName of files) {
      assertMirrorPathComponent(fileName, "field name");
    }
    const contentHash = sha256Hex(record.recordJsonBytes);
    // Planned before the unchanged-shortcut comparison, because the plan IS the
    // description of the attachments that has to take part in it: attachments live
    // outside the record directory (§3), so `contentHash` and `files` say nothing
    // about them, and an attachment added to an untouched record does not bump the
    // parent's `sys_updated_on` either. Planning is pure — it hashes bytes already
    // in memory and touches no filesystem — so doing it before the shortcut costs a
    // hash per attachment on a no-op sweep and buys a correct comparison.
    const attachments: AttachmentPlan | null =
      request.attachments === undefined
        ? null
        : planRecordAttachments({
            table: this.table,
            recordSysId: record.sysId,
            attachments: request.attachments,
            lfsThresholdBytes: this.lfsThresholdBytes,
          });
    const entry: RecordEntry = {
      path: relDir,
      name: admission.name,
      sysUpdatedOn: request.sysUpdatedOn,
      sysUpdatedBy: request.sysUpdatedBy,
      sysModCount: request.sysModCount,
      contentHash,
      files,
      // Absent in, absent out. §4.3 makes `attachments` optional, and the shard is
      // canonical JSON (§8) where a present-but-empty array and an absent key are
      // different bytes: emitting `"attachments": []` for every record in a mirror
      // with attachments disabled would rewrite every shard in the repository the
      // day the feature ships, for no information. A record that WAS swept and has
      // none is likewise indistinguishable from one that was never swept — so both
      // spell it the same way, and `applyAttachmentPlan` (not the entry) is what
      // prunes a directory whose last attachment was deleted on the instance.
      ...(attachments !== null && attachments.entries.length > 0
        ? { attachments: attachments.entries }
        : {}),
    };

    const previous = scope.baseline.get(record.sysId);
    if (!this.rewriteUnchanged && previous !== undefined && sameEntry(previous, entry)) {
      // Nothing on disk would change, so nothing is written. The comparison includes
      // `sysUpdatedOn` and `sysModCount` as well as the content hash: the hash covers
      // `record.json`, and the extracted files are NOT in it (§4.3 defines it that
      // way), so the tracking columns are what rule out an edit that only touched an
      // extracted field. Any real update to a ServiceNow record bumps both.
      //
      // Honest limit: this trusts that the tree matches the shard. A file a human
      // deleted by hand is not noticed here — detecting that means hashing every file
      // on disk on every sweep, which is the job of `mirror verify`, and `mirror
      // repair` passes `rewriteUnchanged` to rebuild from the instance.
      scope.observed.set(record.sysId, previous);
      await this.progress.recordWritten(this.table, record.sysId);
      return {
        status: "unchanged",
        sysId: record.sysId,
        path: previous.path,
        entry: previous,
        renames: admission.renames,
      };
    }

    const dirAbs = toNativePath(this.root, relDir);
    await this.fs.makeDir(dirAbs);
    await atomicWriteFile(
      this.fs,
      toNativePath(this.root, repoPath(relDir, RECORD_FILE_NAME)),
      record.recordJsonBytes
    );
    for (const file of record.extractedFiles) {
      await atomicWriteFile(
        this.fs,
        toNativePath(this.root, repoPath(relDir, file.fileName)),
        file.contents
      );
    }
    await this.pruneRecordDir(dirAbs, new Set([RECORD_FILE_NAME, ...files]));
    if (attachments !== null) {
      // Deliberately NOT inside the record directory the line above just pruned:
      // attachments hang off `attachments/<table>/<sysId>/` (§3) so that a record
      // whose display name changed does not drag megabytes of binary through a
      // rename, and so that `pruneRecordDir` — which deletes everything the shard
      // entry does not name — can stay as blunt as it is.
      await applyAttachmentPlan(this.fs, this.root, attachments);
    }

    if (previous !== undefined && previous.name !== admission.name) {
      // The record moved: a full sweep does not seed the resolver, so a display name
      // that changed on the instance produces no rename to follow — the record is
      // simply written under its new name and the old directory is left standing.
      // Unclaimed by any shard, it is a stale copy of a live record that no
      // consistency check starting from the shard set can see, and it makes the tree
      // a function of the mirror's history rather than of the instance (INV-1).
      //
      // The path is DERIVED from the baseline name rather than taken from the shard
      // entry's own `path`: shard files are committed to git, so an entry's `path` is
      // attacker-influenced input, and this is a removal. Same reasoning as
      // `applyAuthorizedDeletion`.
      scope.vacated.add(
        recordDirRelPath({
          scope: scope.scope,
          table: this.table,
          sysId: record.sysId,
          name: previous.name,
        })
      );
    }
    scope.observed.set(record.sysId, entry);
    await this.progress.recordWritten(this.table, record.sysId);
    return {
      status: "written",
      sysId: record.sysId,
      path: relDir,
      entry,
      renames: admission.renames,
    };
  }

  /**
   * Flush every scope's shard set and, on a full sweep, mint the deletion authority.
   *
   * This is INV-4's release point and the only one. Everything above this line lives
   * in memory and in the checkpoint; nothing above this line has told a reader that
   * a table's index is trustworthy.
   *
   * A full sweep also visits scopes that produced no records at all, via
   * `listScopesWithShards`. Without that, a scope whose every record was deleted
   * would keep a shard set describing them forever: it never appears in the sweep's
   * own output, so it would never be rewritten, and INV-5 would never see the
   * evidence that its records are gone.
   *
   * The `complete` flag each shard set is stamped with is a property of the entry
   * SET, not of the sweep that last wrote it. A full sweep establishes it. An
   * incremental flush overlays a filtered slice onto its baseline, and a complete
   * set plus an overlay is still a complete set — the deletions the slice cannot
   * see are exactly what INV-5 reserves for full-sweep evidence, which is why the
   * {@link DeletionAuthority} below keys off the MODE and never off this flag.
   * Deriving the flag from the mode instead would degrade a complete baseline to
   * `complete: false` on the first incremental flush, and §5.4's planner reads
   * that flag for watermark eligibility — every incremental sync would force a
   * full sweep on the next run, and watermark chaining could never happen. Only a
   * scope with no complete baseline (first seen by this incremental sweep) flushes
   * `false`, which sends exactly that table back to a full sweep to heal.
   */
  async completeTable(): Promise<TableCompletion> {
    this.assertOpen("complete the table");
    const fullSweep = this.mode === "full";
    if (fullSweep) {
      for (const scope of await listScopesWithShards(this.fs, this.root, this.table)) {
        await this.scopeState(scope);
      }
    }

    const shardsWritten: string[] = [];
    const evidence: SweptScopeEvidence[] = [];
    let recordCount = 0;
    let allScopesComplete = true;
    // Sorted so that two identical runs write shard files in the same order. Nothing
    // downstream depends on it today, but the alternative is that the order follows a
    // `Map`'s insertion sequence, which follows the API's paging order — precisely
    // the kind of hidden input INV-1 exists to keep out of the tree.
    for (const scopeName of [...this.scopes.keys()].sort()) {
      const scope = this.scopes.get(scopeName) as ScopeState;
      const entries = this.entriesToFlush(scope);
      await this.removeVacatedDirs(scope, entries);
      const fanout = stickyFanout(scope.baselineFanout, entries.size);
      const complete = fullSweep || scope.baselineComplete;
      allScopesComplete = allScopesComplete && complete;
      const written = await writeShardSet(this.fs, {
        root: this.root,
        scope: scope.scope,
        table: this.table,
        fanout,
        complete,
        sweepId: this.sweepId,
        entries,
      });
      shardsWritten.push(...written);
      recordCount += entries.size;
      evidence.push({
        scope: scope.scope,
        baseline: scope.baseline,
        observed: scope.observed,
      });
    }

    // Only after every shard is on disk: `completedTables` in the checkpoint means
    // "this table's index is durable", and recording it earlier would let a resume
    // skip a table whose shards a crash had just prevented from landing.
    await this.progress.tableCompleted(this.table);
    this.closed = "completed";

    return {
      table: this.table,
      mode: this.mode,
      complete: allScopesComplete,
      shardsWritten,
      recordCount,
      authority: fullSweep
        ? DeletionAuthority.fromCompletedSweep({
            table: this.table,
            sweepId: this.sweepId,
            complete: true,
            scopes: evidence,
          })
        : null,
    };
  }

  /**
   * Give up on this table without flushing anything (INV-4).
   *
   * The records already written stay on disk — they are correct bytes, and deleting
   * them would turn an interruption into data loss — but no shard claims them, so no
   * reader treats the table as indexed and no deletion can be authorised from a
   * sweep that did not finish. Explicit rather than implicit so that an abandoned
   * sweep is a thing the caller states, and a later `completeTable` on the same
   * object fails loudly instead of flushing a partial table.
   */
  abandon(): void {
    this.assertOpen("abandon the table");
    this.closed = "abandoned";
  }

  /** Records the shard set should claim after this sweep, for one scope. */
  private entriesToFlush(scope: ScopeState): ReadonlyMap<string, RecordEntry> {
    if (this.mode === "full") {
      // A full sweep saw everything, so what it saw IS the set. Anything the baseline
      // still claims is a deletion candidate, not a survivor.
      return scope.observed;
    }
    // An incremental sweep saw a filtered slice, so the baseline survives and the
    // observations overlay it. A partial sweep may never shrink the set: absence from
    // a filtered query means "not changed recently", never "not there".
    const merged = new Map(scope.baseline);
    for (const [sysId, entry] of scope.observed) {
      merged.set(sysId, entry);
    }
    return merged;
  }

  private async scopeState(scopeName: string): Promise<ScopeState> {
    const existing = this.scopes.get(scopeName);
    if (existing !== undefined) {
      return existing;
    }
    assertMirrorPathComponent(scopeName, "scope name");
    const loaded = await loadShardSet(this.fs, this.root, scopeName, this.table);
    const resolver = new RecordNameResolver();
    if (this.mode !== "full") {
      // Seeding is what stops a renamed record from being written straight into an
      // un-refetched record's directory — see `recordPath.ts`. A full sweep must not
      // seed, because it re-observes every live record and a baseline entry that
      // never comes back is a deletion, not a competitor for a name.
      for (const [sysId, entry] of loaded.entries) {
        resolver.seed(sysId, entry.name);
      }
    }
    const state: ScopeState = {
      scope: scopeName,
      resolver,
      baseline: loaded.entries,
      baselineFanout: loaded.fanout,
      baselineComplete: loaded.complete,
      observed: new Map(),
      vacated: new Set(),
    };
    this.scopes.set(scopeName, state);
    return state;
  }

  /**
   * Move the directories a collision forced to be renamed (F9).
   *
   * Two phases, and the second phase is why. Within one admission the renames can be
   * a permutation — group `foo` gains a second member, so the record already on disk
   * moves `foo` → `foo_<id1>` while the newcomer takes `foo_<id2>` — and a naive
   * one-at-a-time loop over a permutation renames a directory onto one it has not
   * moved yet. Staging every source first makes the source paths free before any
   * destination is claimed, so any permutation lands.
   *
   * A destination that is still occupied after staging is a leftover from an earlier
   * sweep at a name the current assignment gives to a live record. It is removed
   * rather than merged: merging would leave the previous occupant's extracted files
   * beside the new owner's, and this is not an INV-5 deletion — the record being
   * moved in exists and owns the name, so what is being discarded is a stale path,
   * not a record.
   *
   * A crash between the two phases leaves a `.mirror-tmp-…` directory and no record
   * directory at either name. The record is not in any shard yet (INV-4), the next
   * sweep re-fetches and rewrites it, and the staging leftover is prunable by its
   * prefix. Interrupted, not corrupt.
   */
  private async applyRenames(
    scope: ScopeState,
    renames: readonly RecordRename[]
  ): Promise<void> {
    if (renames.length === 0) {
      return;
    }
    const staged: Array<{ staging: string; toAbs: string }> = [];
    for (const rename of renames) {
      const fromAbs = toNativePath(
        this.root,
        recordDirRelPath({
          scope: scope.scope,
          table: this.table,
          sysId: rename.sysId,
          name: rename.from,
        })
      );
      const toRel = recordDirRelPath({
        scope: scope.scope,
        table: this.table,
        sysId: rename.sysId,
        name: rename.to,
      });
      this.retargetEntry(scope, rename.sysId, toRel, rename.to);
      if ((await this.fs.readDir(fromAbs)) === null) {
        // Nothing on disk under the old name: the record is new this sweep and has
        // not been written yet, so its first write will simply land at the new name.
        continue;
      }
      const staging = stagingSiblingOf(fromAbs);
      await this.fs.rename(fromAbs, staging);
      staged.push({ staging, toAbs: toNativePath(this.root, toRel) });
    }
    for (const move of staged) {
      await atomicRemoveDir(this.fs, move.toAbs);
      await this.fs.rename(move.staging, move.toAbs);
    }
  }

  /**
   * Remove the directories this sweep's own writes emptied out.
   *
   * Deferred to the table's completion rather than done at the moment of the write,
   * because within one sweep the vacated paths can be a permutation: two records that
   * swap display names each leave a directory the other now occupies. Removing
   * eagerly would delete a record this sweep had just written, and the shard set
   * would then claim a directory that no longer exists — a worse outcome than the
   * stale copy this is here to clean up. Deciding against the entries the shard set
   * is about to claim makes that impossible to get wrong: a path something still
   * lives at is never removed, whatever order the records arrived in.
   *
   * Not an INV-5 deletion. The record exists, was observed by this sweep, and was
   * rewritten under its current name; what is discarded is a path it no longer
   * occupies. No evidence is needed to stop mirroring a directory the mirror itself
   * moved out of a moment earlier.
   */
  private async removeVacatedDirs(
    scope: ScopeState,
    entries: ReadonlyMap<string, RecordEntry>
  ): Promise<void> {
    if (scope.vacated.size === 0) {
      return;
    }
    const claimed = new Set<string>();
    for (const entry of entries.values()) {
      claimed.add(entry.path);
    }
    // Sorted so that two identical runs issue the same filesystem calls in the same
    // order, for the same reason the scope loop above is sorted.
    for (const relDir of [...scope.vacated].sort()) {
      if (claimed.has(relDir)) {
        continue;
      }
      await atomicRemoveDir(this.fs, toNativePath(this.root, relDir));
    }
  }

  /** Point a record's shard entry at its new directory after a rename. */
  private retargetEntry(
    scope: ScopeState,
    sysId: string,
    path: string,
    name: string
  ): void {
    // Both maps, because who holds the entry depends on the sweep: on a full sweep
    // the record was written earlier in this same sweep (observed), while on an
    // incremental sweep the record being displaced may be one that was never
    // re-fetched and exists only in the baseline. Missing the baseline case would
    // leave a shard entry pointing at a directory that has moved.
    for (const map of [scope.observed, scope.baseline]) {
      const entry = map.get(sysId);
      if (entry !== undefined) {
        map.set(sysId, { ...entry, path, name });
      }
    }
  }

  /**
   * Delete files in a record directory that this sweep did not write.
   *
   * A field that stopped being extracted — because the record's value became empty,
   * or because the field policy changed — leaves a file behind that no shard entry
   * claims. Left alone it stays in the repo forever and reads as current content.
   *
   * Subdirectories are never touched. Nothing in WP-M7 creates one, so a directory
   * inside a record directory belongs to someone else (a later WP's attachments, or
   * a user), and recursively deleting a user's data because it sat in a directory the
   * mirror manages is a far worse failure than an untidy tree.
   */
  private async pruneRecordDir(dirAbs: string, keep: Set<string>): Promise<void> {
    const listing = await this.fs.readDir(dirAbs);
    /* istanbul ignore if -- @preserve: makeDir just created it; a race here is
       indistinguishable from an empty directory and the next sweep re-prunes. */
    if (listing === null) {
      return;
    }
    for (const entry of listing) {
      if (entry.isDirectory || keep.has(entry.name)) {
        continue;
      }
      if (!isStagingName(entry.name) && !looksWritable(entry.name)) {
        continue;
      }
      await removeFileIfPresent(this.fs, toNativePath(dirAbs, entry.name));
    }
  }

  private assertOpen(action: string): void {
    if (this.closed !== null) {
      throw new Error(
        `Cannot ${action}: the sweep of ${this.table} was already ${this.closed}`
      );
    }
  }
}

/**
 * Whether a stray file in a record directory is one the mirror could have written.
 *
 * The pruning pass only removes files that look like its own output — a name that is
 * a legal path component and does not start with a dot. A dotfile a user dropped in
 * (`.gitattributes`, an editor's lock file) is left alone, because "the mirror owns
 * this directory" is a claim about the files it writes, not a licence to clear it.
 */
function looksWritable(name: string): boolean {
  return !name.startsWith(".");
}

/** Whether two shard entries describe the same on-disk state. */
function sameEntry(left: RecordEntry, right: RecordEntry): boolean {
  return (
    left.contentHash === right.contentHash &&
    left.path === right.path &&
    left.name === right.name &&
    left.sysUpdatedOn === right.sysUpdatedOn &&
    left.sysUpdatedBy === right.sysUpdatedBy &&
    left.sysModCount === right.sysModCount &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index]) &&
    sameAttachments(left.attachments, right.attachments)
  );
}

/**
 * Whether two entries claim the same attachments.
 *
 * This is the one part of the comparison that the tracking columns cannot stand in
 * for. Adding, replacing or deleting an attachment in ServiceNow writes a
 * `sys_attachment` row; it does not touch the record it hangs off, so
 * `sys_updated_on` and `sys_mod_count` are unchanged and `contentHash` — which
 * covers `record.json` alone — is unchanged too. Without this the shortcut would
 * declare a record with a brand-new 4 MB attachment "unchanged", and the bytes
 * would never reach the tree.
 *
 * Absent and empty are the same claim here (see the entry literal in `writeRecord`),
 * so both normalize to `[]`: a sweep that fetched attachments and found none must
 * not read as a change against a baseline written before the feature existed, or
 * the first sweep after the upgrade rewrites every record in the instance.
 *
 * Element-wise rather than set-wise because `planRecordAttachments` sorts by sys_id
 * and the baseline was produced by the same sort — a difference in ORDER at equal
 * membership would mean the sort itself changed, which is a real change to the
 * bytes of every shard and should not be waved through.
 */
function sameAttachments(
  left: RecordEntry["attachments"],
  right: RecordEntry["attachments"]
): boolean {
  const ours = left ?? [];
  const theirs = right ?? [];
  return (
    ours.length === theirs.length &&
    ours.every((attachment, index) => {
      const other = theirs[index];
      return (
        attachment.sysId === other.sysId &&
        attachment.fileName === other.fileName &&
        attachment.sizeBytes === other.sizeBytes &&
        attachment.sha256 === other.sha256 &&
        attachment.lfs === other.lfs
      );
    })
  );
}

/**
 * Remove one record — the ONLY deletion path in this package.
 *
 * It takes a {@link DeletionAuthority}, not a path and not a sys_id-plus-root, so
 * the sequence "prove the sweep completed → prove the record was absent from it →
 * get the mirror's own path back" cannot be skipped or reordered. WP-M10's reconciler
 * calls this; there is nothing else for it to call.
 *
 * Each removal is staged (`atomicRemoveDir`), so an interrupted delete never leaves
 * a directory holding half its files.
 *
 * ## A record is two directories, not one
 *
 * The record's own directory under `instance/` is only half of it. Its attachment
 * binaries live at `attachments/<table>/<record sys_id>/` (design §8.4), which is
 * deliberately OUTSIDE `instance/` so a rename or a scope move does not relocate a
 * 76 MB blob in git history — and that same separation is why removing only the
 * record directory leaves the bytes behind forever. No later sweep of the table
 * walks past `attachments/` to reclaim them, and `mirror verify` walks from the
 * manifests inward, so a directory that no shard entry points at is one verify
 * cannot even name. The result is a tree holding content no manifest claims, which
 * is precisely what INV-4 and §5.9 exist to prevent.
 *
 * ## Why the attachments go first
 *
 * Both removals are idempotent (`atomicRemoveDir` returns on an absent target), so
 * the ordering only decides what a resumed run sees after an F8 local-I/O failure
 * between them — and F8 is fatal, so that gap is a state the tree really can be
 * left in. With attachments first, a failure leaves the record directory AND its
 * shard entry standing: the record still looks live, the next run re-derives the
 * same deletion from the same evidence, and repeats both removals. With the record
 * directory first, the same failure leaves an orphan whose only remaining claimant
 * — the entry naming it — is about to be dropped from the shard set, and nothing
 * would ever name it again.
 *
 * The path check precedes both, so a refused deletion touches neither.
 */
export async function applyAuthorizedDeletion(
  fs: WriterFs,
  root: string,
  authority: DeletionAuthority,
  scope: string,
  sysId: string
): Promise<AuthorizedDeletion> {
  const deletion = authority.authorize(scope, sysId);
  // Re-derived from the entry's own components rather than trusting `entry.path`
  // verbatim: the path came out of a shard file, which is committed to git and
  // therefore editable by anyone with a pull request. `recordDirRelPath` validates
  // every component, so a shard that says `../../.ssh` cannot direct a removal.
  const relDir = recordDirRelPath({
    scope: deletion.scope,
    table: authority.table,
    sysId: deletion.sysId,
    name: deletion.entry.name,
  });
  if (relDir !== deletion.path) {
    throw new MirrorPathRejection(
      `shard entry for ${sysId} claims ${deletion.path}, which is not where ${deletion.entry.name} lives`,
      deletion.path
    );
  }
  // Derived, not spelled: `attachmentDirRelPath` is the one site that knows the
  // §8.4 layout, and it re-validates both components for the same reason the
  // record path above is re-derived.
  const relAttachments = attachmentDirRelPath(authority.table, deletion.sysId);
  await atomicRemoveDir(fs, toNativePath(root, relAttachments));
  await atomicRemoveDir(fs, toNativePath(root, relDir));
  return deletion;
}

/** Repo-relative directory holding one table's records in one scope (§3). */
export function tableDirRelPath(scope: string, table: string): string {
  assertMirrorPathComponent(scope, "scope name");
  assertMirrorPathComponent(table, "table name");
  return repoPath(INSTANCE_DIR_NAME, scope, table);
}
