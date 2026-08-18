// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-5 — the guard that makes an unauthorised deletion impossible to express
 * (WP-M7, §5.8).
 *
 * INV-5: *a record may be deleted only when its table's fresh sweep is complete and
 * the record is absent from it.* WP-M10 owns the reconciler that decides when to act
 * on that; WP-M7 owns the fact that there is no way to ask for any other deletion.
 *
 * The enforcement is the SHAPE of the API, not the identity of the caller. There is
 * no `delete(path)` and no `delete(sysId)` anywhere in this package. The only thing
 * that can be deleted is a member of the set this class computes, and that set is
 * `baseline \ observed` for one completed sweep of one table — the exact set INV-5
 * describes. A caller cannot widen it, cannot add to it, and cannot hand a path in;
 * {@link DeletionAuthority.authorize} takes a sys_id and RETURNS the path, so the
 * path is always the mirror's own, never the caller's.
 *
 * A `private constructor` plus {@link DeletionAuthority.fromCompletedSweep} makes
 * that the only construction route. The factory rejects incomplete evidence, so an
 * interrupted or incremental sweep produces no authority at all rather than an empty
 * one — the distinction matters, because an empty authority is a legitimate "nothing
 * to delete" answer and a missing one is "you may not ask".
 *
 * A rejected alternative, for the record: a module-private `unique symbol` minting
 * token, so that only the writer could construct an authority. It moves the guard
 * from *what can be expressed* to *who may speak*, which is weaker — the writer is
 * exactly the code most likely to acquire a bug, and any token it can pass, a future
 * refactor inside the same module can pass too. The evidence check below constrains
 * the writer as much as it constrains anyone else, which is the point.
 */
import type { RecordEntry } from "../contracts";
import { compareBytewise } from "../order";

/** One record the sweep has proved is gone, and where it lives on disk. */
export interface AuthorizedDeletion {
  /** The record's sys_id, already INV-6 validated when the shard was read. */
  sysId: string;
  /** Scope directory the record lived under. */
  scope: string;
  /** Repo-relative record directory — the mirror's own path, not the caller's. */
  path: string;
  /** The shard entry as it stood before the sweep, for the run report. */
  entry: RecordEntry;
}

/** One scope's before/after picture from a completed table sweep. */
export interface SweptScopeEvidence {
  scope: string;
  /** What the shard set claimed before this sweep ran. */
  baseline: ReadonlyMap<string, RecordEntry>;
  /** What this sweep actually observed and wrote in that scope. */
  observed: ReadonlyMap<string, RecordEntry>;
}

/** Everything {@link DeletionAuthority.fromCompletedSweep} needs to be convinced. */
export interface CompletedSweepEvidence {
  table: string;
  sweepId: string;
  /**
   * Whether the sweep observed the table WHOLE. Only a completed full sweep may set
   * this; an incremental sweep saw a filtered subset, so a record's absence from it
   * means "not changed recently", not "not there".
   */
  complete: boolean;
  scopes: readonly SweptScopeEvidence[];
}

/** Raised when deletion is asked for without the evidence INV-5 requires. */
export class DeletionNotAuthorized extends Error {
  constructor(detail: string) {
    super(`Refusing to delete: ${detail} (INV-5)`);
    this.name = "DeletionNotAuthorized";
  }
}

/**
 * Internal key of the deletable set: a record is identified by scope AND sys_id.
 *
 * Not by sys_id alone, which is what this was and which silently lost deletions.
 * A sys_id is unique on the instance at any one instant, but the mirror tree holds
 * OBSERVATIONS, and the same record can be stale in two scope directories at once:
 * its `sys_scope` moved from A to B, the sweep that should have cleaned A up did
 * not complete, it then moved to C. Now A and B both hold a stale copy and both are
 * deletable. Keyed by sys_id, the second `set` overwrote the first and one directory
 * was orphaned in the repository for good — with no error, because the authority
 * genuinely had no memory of it.
 *
 * `/` is the delimiter because {@link assertMirrorPathComponent} has already refused
 * any scope containing one, so no two distinct pairs can collide on a key.
 */
function deletionKey(scope: string, sysId: string): string {
  return `${scope}/${sysId}`;
}

export class DeletionAuthority {
  /** Table this authority covers. An authority is never table-agnostic. */
  readonly table: string;
  /** The sweep that produced the evidence, carried into the run report. */
  readonly sweepId: string;
  /** Keyed by {@link deletionKey} — scope and sys_id, never sys_id alone. */
  private readonly deletions: Map<string, AuthorizedDeletion>;

  private constructor(
    table: string,
    sweepId: string,
    deletions: Map<string, AuthorizedDeletion>
  ) {
    this.table = table;
    this.sweepId = sweepId;
    this.deletions = deletions;
  }

  /**
   * Compute the deletable set from a completed sweep's own before/after evidence.
   *
   * Two rules, and the second is the one that is easy to miss.
   *
   *  1. A record is deletable when the baseline claimed it and the sweep did not
   *     observe it. That is INV-5 verbatim.
   *  2. A record is NOT deletable — even under rule 1 — when its directory is now
   *     claimed by a record the sweep DID observe. This happens for real: record A
   *     is called `foo` and is deleted, record B is renamed to `foo` in the same
   *     window, and B is written into the directory A used to own. A's stale entry
   *     still points at `instance/<scope>/<table>/foo`, so acting on rule 1 alone
   *     would delete B's freshly written directory and the mirror would lose a
   *     record that exists on the instance. The observed set is the authority on
   *     which paths are live, so the check is a lookup, not a heuristic.
   */
  static fromCompletedSweep(evidence: CompletedSweepEvidence): DeletionAuthority {
    if (!evidence.complete) {
      throw new DeletionNotAuthorized(
        `the sweep of ${evidence.table} did not complete, so an absent record is not a deleted record`
      );
    }
    const livePaths = new Set<string>();
    for (const scope of evidence.scopes) {
      for (const entry of scope.observed.values()) {
        livePaths.add(entry.path);
      }
    }

    const deletions = new Map<string, AuthorizedDeletion>();
    for (const scope of evidence.scopes) {
      for (const [sysId, entry] of scope.baseline) {
        if (scope.observed.has(sysId) || livePaths.has(entry.path)) {
          continue;
        }
        deletions.set(deletionKey(scope.scope, sysId), {
          sysId,
          scope: scope.scope,
          path: entry.path,
          entry,
        });
      }
    }
    return new DeletionAuthority(evidence.table, evidence.sweepId, deletions);
  }

  /** Whether this record, in this scope, is one the sweep proved absent. */
  has(scope: string, sysId: string): boolean {
    return this.deletions.has(deletionKey(scope, sysId));
  }

  /** How many records the sweep proved absent. */
  get size(): number {
    return this.deletions.size;
  }

  /**
   * Everything deletable, ordered by scope and then sys_id.
   *
   * Sorted because the reconciler's output ends up in a run report and in a git
   * commit, and an order that follows a `Map`'s insertion sequence follows the API's
   * paging order — which is the same class of hidden input INV-1 exists to keep out
   * of the tree. Scope leads the comparison for the same reason it leads the key: on
   * a sys_id-only sort, the two stale copies of a moved record land adjacent and
   * indistinguishable in the report, which is how the bug above stayed invisible.
   */
  list(): AuthorizedDeletion[] {
    return [...this.deletions.values()].sort(
      (left, right) =>
        compareBytewise(left.scope, right.scope) ||
        compareBytewise(left.sysId, right.sysId)
    );
  }

  /**
   * Turn a scope and sys_id into the one path that may be removed, or refuse.
   *
   * This is the choke point. The reconciler cannot construct a path to delete; it
   * can only present a record's identity and be handed one, and only for records this
   * sweep proved absent from that scope.
   *
   * The scope is a parameter rather than a lookup because it is part of the record's
   * identity in this tree, not a detail the authority can recover: a sys_id stale in
   * two scopes is two deletions, and a caller that names only the sys_id has not said
   * which directory it means. Refusing to guess is the whole of the fix.
   */
  authorize(scope: string, sysId: string): AuthorizedDeletion {
    const deletion = this.deletions.get(deletionKey(scope, sysId));
    if (deletion === undefined) {
      throw new DeletionNotAuthorized(
        `${sysId} was not proved absent from scope ${scope} by sweep ${this.sweepId} of ${this.table}`
      );
    }
    return deletion;
  }
}
