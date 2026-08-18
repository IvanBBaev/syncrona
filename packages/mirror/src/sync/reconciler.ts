// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reconciler — the module that decides which mirrored records may be DELETED,
 * and refuses everything else with a named reason (WP-M10, §5.9).
 *
 * §5.9: "Full-sweep diff: fresh sweep result vs existing shards → adds /
 * updates / deletes. `sys_audit_delete` tombstones are an *advisory
 * optimization* between reconciliations — a tombstone triggers a targeted
 * existence check (GET by sys_id), never a blind delete." Adds and updates are
 * the writer's business and already happened by the time this runs; deletions
 * are the dangerous remainder, because a wrong add is overwritten next sweep
 * while a wrong delete silently erases history the instance still has.
 *
 * INV-5 is therefore enforced STRUCTURALLY, not by a boolean argument:
 *
 *  - The only evidence kind that can delete is `full-sweep`, and it carries a
 *    {@link DeletionAuthority} — an object that can only be constructed from
 *    completed-sweep evidence (`deletionAuthority.ts` refuses anything else at
 *    its factory). There is no `{ complete: true }` flag for a caller to set;
 *    the proof travels as a capability, so an incomplete sweep has nothing to
 *    hand this module.
 *  - Every other evidence kind — `watermark` (a filtered read's silence means
 *    "not changed", never "not there"), `partial`, `failed`, `not-attempted` —
 *    becomes a {@link ReconcileRefusal} row. So does every table that has
 *    shards on disk but no evidence at all (`not-in-sweep`): a table the plan
 *    forgot must not quietly keep whatever it happens to hold without the run
 *    report saying so (R3: nothing dropped silently).
 *  - Every actual removal goes through `applyAuthorizedDeletion`, the one
 *    deletion path in this package — this module never touches
 *    `removeRecursive` and never constructs a deletable path itself.
 *
 * **Tombstones are advice, never authority on their own.** §5.8 states INV-5
 * in full: a record may be deleted when its table's fresh sweep is complete
 * and the record is absent from it, *or a reconcile confirms a tombstone*.
 * The confirmation needs two independent witnesses because each alone is a
 * known way to destroy live data:
 *
 *  - a tombstone alone is a blind delete — `sys_audit_delete` rows can be
 *    stale, replayed, or plain wrong about what exists NOW;
 *  - a zero-row GET alone is an ACL artifact waiting to happen — a record the
 *    mirror user cannot see returns the same empty page as a record that is
 *    gone (the F2-vs-F3 ambiguity that shaped the whole error taxonomy).
 *
 * Together they are an attested deletion the instance does not refute, which
 * is the sanctioned second leg of INV-5. Mechanically, the confirming GET
 * filters by primary key (`sys_id=<id>`, one row requested — INV-2: GET
 * only), and its universe is that single sys_id; a primary-key-filtered read
 * observes that universe WHOLE, which is why the narrow
 * `CompletedSweepEvidence` minted from it may honestly say `complete: true`
 * for a baseline of exactly that record. The full-table `complete` flag is
 * never touched: the shard rewrite that drops the confirmed-dead entry
 * PRESERVES the loaded set's `complete`, because removing a record proved
 * absent cannot make a live record missing from the set (INV-4 measures the
 * set against the instance, and the instance no longer has this record).
 *
 * A transient failure on the confirming GET is NOT authority to delete —
 * failure lands the tombstone in `confirm-failed` with its failure class, and
 * the record stays. Likewise a non-empty page of ANY size means the record
 * stays (`still-present`): the safe direction never needs the page parsed
 * further. A tombstone for a table that completed a full sweep this run is
 * `superseded` without a GET — the diff already decided every deletion for
 * that table, and re-litigating it on stale advice could only disagree with
 * fresher evidence. A tombstone whose sys_id fails INV-6 or whose table name
 * is unusable as a path component is `invalid` before any I/O.
 *
 * Dangling references (D2) pass through as counts per table for the coverage
 * report — reported, never repaired (§7): a deletion this module performs may
 * well CREATE dangling references in records that pointed at the removed row,
 * and that is correct behaviour, not damage to hide.
 *
 * Everything returned is sorted with `compareBytewise` (INV-1: the tree and
 * the report must not encode API paging order or filesystem enumeration
 * order), and tombstones are processed in sorted, deduplicated order so even
 * the SEQUENCE of network calls is a function of the input. No clock, no
 * environment: `fs` and the page source are injected, and the module reads
 * time from nobody.
 */
import type {
  CoverageReason,
  MirrorFailureClass,
  RecordEntry,
  TablePage,
} from "../contracts";
import type { DanglingReference } from "../derived/refsView";
import { MirrorHttpError } from "../http/client";
import { compareBytewise } from "../order";
import type { MirrorComponentKind } from "../shards/shardLayout";
import {
  INSTANCE_DIR_NAME,
  SHARD_DIR_NAME,
  assertMirrorPathComponent,
  isMirrorSysId,
  repoPath,
  stickyFanout,
} from "../shards/shardLayout";
import type { LoadedShardSet } from "../shards/shardStore";
import {
  listScopesWithShards,
  loadShardSet,
  writeShardSet,
} from "../shards/shardStore";
import { isStagingName } from "../write/atomicWrite";
import { DeletionAuthority } from "../write/deletionAuthority";
import type { WriterFs } from "../write/fs";
import { toNativePath } from "../write/fs";
import { applyAuthorizedDeletion } from "../write/writer";
import type { FetcherPageSource } from "./fetcher";

/**
 * What this run can attest about one table's sweep. Exactly one entry per
 * table — two entries naming the same table are contradictory evidence, and
 * the reconciler throws rather than picking a side.
 *
 * The `full-sweep` variant carries no table name of its own: the table is
 * read from the authority, so "authority for table A filed under table B" is
 * unrepresentable.
 */
export type TableSweepEvidence =
  | {
      /** A completed full sweep — the only kind that can authorize deletions. */
      kind: "full-sweep";
      authority: DeletionAuthority;
    }
  | {
      /** A watermark-filtered read completed. Absence from it proves nothing. */
      kind: "watermark";
      table: string;
    }
  | {
      /** The sweep ran but did not observe the table whole. */
      kind: "partial";
      table: string;
      reason: CoverageReason;
    }
  | {
      /** The sweep failed outright. `reason` is null when no class was assigned. */
      kind: "failed";
      table: string;
      reason: CoverageReason | null;
    }
  | {
      /** The run never reached this table (planned but not attempted). */
      kind: "not-attempted";
      table: string;
    };

/** One `sys_audit_delete` claim, reduced to what the advisory path needs. */
export interface TombstoneAdvisory {
  table: string;
  sysId: string;
}

/**
 * Tombstones travel WITH the page source that can confirm them, so "advice
 * without a way to check it" is unrepresentable — a caller that cannot reach
 * the instance simply has no advisory input to pass.
 */
export interface TombstoneAdvisoryInput {
  tombstones: readonly TombstoneAdvisory[];
  /** GET-only seam (INV-2) used for the targeted existence checks. */
  source: FetcherPageSource;
}

export interface ReconcileOptions {
  fs: WriterFs;
  /** Repo root as a native absolute path, exactly as the writer takes it. */
  root: string;
  /** Sweep id stamped on shard rewrites and the narrow tombstone evidence. */
  sweepId: string;
  evidence: readonly TableSweepEvidence[];
  advisory?: TombstoneAdvisoryInput;
  /** From the derived layer (D2); folded into per-table counts for coverage. */
  danglingRefs?: readonly DanglingReference[];
}

/** One record directory actually removed, and which leg of INV-5 allowed it. */
export interface AppliedDeletion {
  table: string;
  scope: string;
  sysId: string;
  /** Repo-relative record directory, as re-derived by the deletion path. */
  path: string;
  via: "full-sweep" | "tombstone";
}

export type ReconcileRefusalReason =
  | "sweep-partial"
  | "sweep-failed"
  | "watermark-silence"
  | "not-attempted"
  | "not-in-sweep";

/** Why one table's records were left exactly as they were. */
export interface ReconcileRefusal {
  table: string;
  reason: ReconcileRefusalReason;
  detail: string;
}

export type TombstoneDisposition =
  | "deleted"
  | "not-mirrored"
  | "still-present"
  | "confirm-failed"
  | "superseded"
  | "invalid"
  | "path-conflict";

/** One tombstone's fate — every advisory row gets exactly one of these (R3). */
export interface TombstoneOutcome {
  table: string;
  sysId: string;
  disposition: TombstoneDisposition;
  /** Present only for `confirm-failed`: the class of the failed GET. */
  failureClass?: MirrorFailureClass;
  detail: string;
}

export interface ReconcileResult {
  /** Tables whose full-sweep evidence was accepted, sorted bytewise. */
  reconciled: string[];
  /** Sorted by (table, scope, sysId). */
  deletions: AppliedDeletion[];
  /**
   * Sorted by table. Together with `reconciled` this partitions the input:
   * every evidence table lands in exactly one of the two, and every on-disk
   * table absent from the evidence lands here as `not-in-sweep`.
   */
  refusals: ReconcileRefusal[];
  /** One row per distinct (table, sysId) advisory, sorted the same way. */
  tombstones: TombstoneOutcome[];
  /** Repo-relative shard paths rewritten by the tombstone leg, sorted. */
  shardsRewritten: string[];
  /** Table → dangling-reference count, keys sorted (for `TableCoverage`). */
  danglingRefsByTable: Record<string, number>;
}

/** The one table a piece of evidence speaks for. */
function evidenceTable(evidence: TableSweepEvidence): string {
  return evidence.kind === "full-sweep" ? evidence.authority.table : evidence.table;
}

/** A refusal row for every evidence kind that cannot authorize deletion. */
function refusalFor(
  table: string,
  evidence: Exclude<TableSweepEvidence, { kind: "full-sweep" }>
): ReconcileRefusal {
  switch (evidence.kind) {
    case "watermark":
      return {
        table,
        reason: "watermark-silence",
        detail: `the ${table} sweep filtered by watermark; a filtered read's silence about a record means "not changed", never "not there"`,
      };
    case "partial":
      return {
        table,
        reason: "sweep-partial",
        detail: `the ${table} sweep was partial (${evidence.reason}); a record it did not report may be one it could not see`,
      };
    case "failed":
      return {
        table,
        reason: "sweep-failed",
        detail: `the ${table} sweep failed${
          evidence.reason === null ? "" : ` (${evidence.reason})`
        }; it proves nothing about any record`,
      };
    case "not-attempted":
      return {
        table,
        reason: "not-attempted",
        detail: `the sweep never reached ${table}; the shard baseline is the only claim there is`,
      };
  }
}

/**
 * Path-validate a component without duplicating the rules: the layout module's
 * assertion is the single authority, and ANY refusal from it makes the
 * component unusable here — the thrown text becomes the outcome's detail.
 */
function componentRefusal(value: string, label: MirrorComponentKind): string | null {
  try {
    assertMirrorPathComponent(value, label);
    return null;
  } catch (error) {
    return String(error);
  }
}

/**
 * Every table that has a shard directory anywhere on disk. Enumeration only —
 * no shard file is parsed here, so a corrupt shard set in a table nobody swept
 * yields a calm `not-in-sweep` refusal, not a crash: the refusal already says
 * "touch nothing", and reading the files could add nothing to that verdict.
 */
async function listTablesWithShards(fs: WriterFs, root: string): Promise<string[]> {
  const scopesListing = await fs.readDir(toNativePath(root, INSTANCE_DIR_NAME));
  if (scopesListing === null) {
    return [];
  }
  const tables = new Set<string>();
  for (const scopeEntry of scopesListing) {
    if (!scopeEntry.isDirectory || isStagingName(scopeEntry.name)) {
      continue;
    }
    const tablesListing = await fs.readDir(
      toNativePath(root, repoPath(INSTANCE_DIR_NAME, scopeEntry.name))
    );
    if (tablesListing === null) {
      // The scope directory vanished between the two reads; a racing cleanup
      // is not this module's emergency.
      continue;
    }
    for (const tableEntry of tablesListing) {
      if (
        !tableEntry.isDirectory ||
        isStagingName(tableEntry.name) ||
        tables.has(tableEntry.name)
      ) {
        continue;
      }
      const shardsListing = await fs.readDir(
        toNativePath(
          root,
          repoPath(INSTANCE_DIR_NAME, scopeEntry.name, tableEntry.name, SHARD_DIR_NAME)
        )
      );
      if (shardsListing !== null) {
        tables.add(tableEntry.name);
      }
    }
  }
  return [...tables].sort(compareBytewise);
}

/**
 * Deduplicate and order the advisories. The instance can log several deletion
 * audits for one record (delete, restore, delete again); one existence check
 * answers all of them, and processing in sorted order makes the sequence of
 * GETs — not just the result — a function of the input.
 */
function dedupeSortedTombstones(
  tombstones: readonly TombstoneAdvisory[]
): TombstoneAdvisory[] {
  const byKey = new Map<string, TombstoneAdvisory>();
  for (const advisory of tombstones) {
    // `\u0000` cannot appear in a valid table name or sys_id, so distinct
    // pairs cannot collide; hostile values that could are refused later anyway.
    const key = `${advisory.table}\u0000${advisory.sysId}`;
    if (!byKey.has(key)) {
      byKey.set(key, advisory);
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareBytewise(left.table, right.table) || compareBytewise(left.sysId, right.sysId)
  );
}

/** Shared state the tombstone leg mutates while confirming advisories. */
interface TombstoneContext {
  fs: WriterFs;
  root: string;
  sweepId: string;
  source: FetcherPageSource;
  evidenceByTable: ReadonlyMap<string, TableSweepEvidence>;
  /**
   * `scope\u0000table` → loaded shard set, kept current across rewrites so a
   * later tombstone for the same set sees the earlier removal, not the disk
   * state from before it.
   */
  shardCache: Map<string, LoadedShardSet>;
  deletions: AppliedDeletion[];
  shardsRewritten: string[];
}

/** A scope directory whose shard set still claims the tombstoned record. */
interface ScopeClaim {
  scope: string;
  entry: RecordEntry;
  shards: LoadedShardSet;
}

/** Run one advisory through the confirmation ladder described in the docblock. */
async function confirmTombstone(
  context: TombstoneContext,
  advisory: TombstoneAdvisory
): Promise<TombstoneOutcome> {
  const { table, sysId } = advisory;

  // INV-6 first: a sys_id that is not 32 lowercase hex characters is refused
  // before it can reach a query string or a path, and so is a table name the
  // layout rules would not accept as a directory.
  if (!isMirrorSysId(sysId)) {
    return {
      table,
      sysId,
      disposition: "invalid",
      detail: `tombstone names sys_id ${JSON.stringify(sysId)}, which INV-6 refuses`,
    };
  }
  const tableProblem = componentRefusal(table, "table name");
  if (tableProblem !== null) {
    return {
      table,
      sysId,
      disposition: "invalid",
      detail: `tombstone names an unusable table: ${tableProblem}`,
    };
  }

  // A completed full sweep of this table already decided every deletion by
  // diffing fresher evidence than any audit row; stale advice yields to it.
  const evidence = context.evidenceByTable.get(table);
  if (evidence !== undefined && evidence.kind === "full-sweep") {
    return {
      table,
      sysId,
      disposition: "superseded",
      detail: `${table} completed a full sweep in this run; its diff already decided every deletion`,
    };
  }

  // Locate every scope whose shard set still claims the record. A moved record
  // can be stale in several scope directories at once (see deletionAuthority's
  // key rationale), so ALL claiming scopes are collected, not the first.
  const claims: ScopeClaim[] = [];
  for (const scope of await listScopesWithShards(context.fs, context.root, table)) {
    const cacheKey = `${scope}\u0000${table}`;
    let shards = context.shardCache.get(cacheKey);
    if (shards === undefined) {
      // Corrupt shard manifests THROW here, on purpose: unlike the not-in-sweep
      // enumeration, this path is about to base a deletion on shard contents,
      // and a baseline that cannot be read must never be treated as empty.
      shards = await loadShardSet(context.fs, context.root, scope, table);
      context.shardCache.set(cacheKey, shards);
    }
    const entry = shards.entries.get(sysId);
    if (entry !== undefined) {
      claims.push({ scope, entry, shards });
    }
  }
  if (claims.length === 0) {
    return {
      table,
      sysId,
      disposition: "not-mirrored",
      detail: `no shard set claims ${sysId} in ${table}; nothing to remove, nothing to confirm`,
    };
  }

  // Rule-2 guard, same hazard the authority checks for full sweeps: if another
  // record in the same set claims this record's directory, removing the
  // directory would take a live record's files with it. Without full-sweep
  // evidence there is no observed set to consult, so the shard set stands in
  // as the best available map of live paths — and a conflict means refuse.
  for (const claim of claims) {
    for (const [otherId, otherEntry] of claim.shards.entries) {
      if (otherId !== sysId && otherEntry.path === claim.entry.path) {
        return {
          table,
          sysId,
          disposition: "path-conflict",
          detail: `${otherId} also claims ${claim.entry.path} in scope ${claim.scope}; removing it would take another record's files`,
        };
      }
    }
  }

  // The targeted existence check (§5.9): one GET, filtered by primary key,
  // one row requested — presence needs no more, and absence is judged on the
  // row count alone. The sys_id is safe to interpolate: INV-6 passed above.
  let page: TablePage;
  try {
    page = await context.source.getPage(table, null, {
      fields: ["sys_id"],
      extraQuery: `sys_id=${sysId}`,
      pageSize: 1,
    });
  } catch (error) {
    if (error instanceof MirrorHttpError) {
      // A failed read is not evidence of absence — INV-5 fails toward keeping.
      return {
        table,
        sysId,
        disposition: "confirm-failed",
        failureClass: error.failureClass,
        detail: `the confirming GET for ${sysId} in ${table} failed (${error.failureClass}); a failed read is not evidence of absence`,
      };
    }
    // Anything else is a broken seam, not a classified instance failure; the
    // fetcher's local-io normalization is about its row sink (the disk) and
    // has no analogue for a read that touches no disk at all.
    throw error;
  }
  if (page.rows.length > 0) {
    return {
      table,
      sysId,
      disposition: "still-present",
      detail: `the instance still returns ${sysId} from ${table}; the tombstone is stale and the record stays`,
    };
  }

  // Two witnesses agree. Mint the narrow authority — its universe is the one
  // sys_id the GET's primary-key filter observed whole, so `complete: true`
  // is an honest statement about THAT universe (see module docblock) — and
  // route the removal through the package's single deletion path.
  const authority = DeletionAuthority.fromCompletedSweep({
    table,
    sweepId: context.sweepId,
    complete: true,
    scopes: claims.map((claim) => ({
      scope: claim.scope,
      baseline: new Map([[sysId, claim.entry]]),
      observed: new Map<string, RecordEntry>(),
    })),
  });
  for (const claim of claims) {
    const applied = await applyAuthorizedDeletion(
      context.fs,
      context.root,
      authority,
      claim.scope,
      sysId
    );
    context.deletions.push({
      table,
      scope: claim.scope,
      sysId,
      path: applied.path,
      via: "tombstone",
    });
    // Rewrite the scope's shard set without the entry. `complete` is
    // preserved: removing a record two witnesses proved absent cannot make a
    // live record missing from the set, so whatever INV-4 standing the set
    // had, it keeps. The fanout is sticky (D16) and the current sweep id is
    // stamped because the set's content genuinely changed this run.
    claim.shards.entries.delete(sysId);
    const written = await writeShardSet(context.fs, {
      root: context.root,
      scope: claim.scope,
      table,
      fanout: stickyFanout(claim.shards.fanout, claim.shards.entries.size),
      complete: claim.shards.complete,
      sweepId: context.sweepId,
      entries: claim.shards.entries,
    });
    context.shardsRewritten.push(...written);
  }
  const copies = claims.length === 1 ? "stale copy" : "stale copies";
  return {
    table,
    sysId,
    disposition: "deleted",
    detail: `tombstone confirmed by targeted GET; removed ${String(claims.length)} ${copies}`,
  };
}

/**
 * Decide and apply this run's deletions, and account for everything that was
 * NOT deleted and why. See the module docblock for the full argument; the
 * short form is: full-sweep evidence deletes through its authority, every
 * other table gets a named refusal, and tombstones delete only when a
 * targeted GET seconds them.
 */
export async function reconcileSweep(options: ReconcileOptions): Promise<ReconcileResult> {
  const { fs, root, sweepId } = options;

  const evidenceByTable = new Map<string, TableSweepEvidence>();
  for (const evidence of options.evidence) {
    const table = evidenceTable(evidence);
    if (evidenceByTable.has(table)) {
      // Contradictory evidence is a caller bug; picking either entry would
      // make the outcome depend on array order, so neither is picked.
      throw new Error(
        `reconcile evidence names ${table} twice; contradictory evidence must be resolved by the caller`
      );
    }
    evidenceByTable.set(table, evidence);
  }

  const reconciled: string[] = [];
  const refusals: ReconcileRefusal[] = [];
  const deletions: AppliedDeletion[] = [];
  const shardsRewritten: string[] = [];

  // Tables in sorted order so deletions are applied — not merely reported —
  // in a sequence that is a function of the evidence set alone.
  for (const table of [...evidenceByTable.keys()].sort(compareBytewise)) {
    const evidence = evidenceByTable.get(table) as TableSweepEvidence;
    if (evidence.kind === "full-sweep") {
      reconciled.push(table);
      for (const candidate of evidence.authority.list()) {
        const applied = await applyAuthorizedDeletion(
          fs,
          root,
          evidence.authority,
          candidate.scope,
          candidate.sysId
        );
        deletions.push({
          table,
          scope: applied.scope,
          sysId: applied.sysId,
          path: applied.path,
          via: "full-sweep",
        });
      }
    } else {
      refusals.push(refusalFor(table, evidence));
    }
  }

  // Tables that exist on disk but were not part of this sweep at all.
  for (const table of await listTablesWithShards(fs, root)) {
    if (!evidenceByTable.has(table)) {
      refusals.push({
        table,
        reason: "not-in-sweep",
        detail: `${table} has shards on disk but no place in this sweep; absence from a plan is not absence from the instance`,
      });
    }
  }

  const tombstones: TombstoneOutcome[] = [];
  if (options.advisory !== undefined) {
    const context: TombstoneContext = {
      fs,
      root,
      sweepId,
      source: options.advisory.source,
      evidenceByTable,
      shardCache: new Map(),
      deletions,
      shardsRewritten,
    };
    for (const advisory of dedupeSortedTombstones(options.advisory.tombstones)) {
      tombstones.push(await confirmTombstone(context, advisory));
    }
  }

  const counts = new Map<string, number>();
  for (const ref of options.danglingRefs ?? []) {
    counts.set(ref.table, (counts.get(ref.table) ?? 0) + 1);
  }
  const danglingRefsByTable: Record<string, number> = {};
  for (const table of [...counts.keys()].sort(compareBytewise)) {
    danglingRefsByTable[table] = counts.get(table) as number;
  }

  deletions.sort(
    (left, right) =>
      compareBytewise(left.table, right.table) ||
      compareBytewise(left.scope, right.scope) ||
      compareBytewise(left.sysId, right.sysId)
  );
  refusals.sort((left, right) => compareBytewise(left.table, right.table));
  shardsRewritten.sort(compareBytewise);
  // `reconciled` and `tombstones` were built in sorted order already.

  return { reconciled, deletions, refusals, tombstones, shardsRewritten, danglingRefsByTable };
}
