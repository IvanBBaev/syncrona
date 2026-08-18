// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-5 — "a record may be deleted only when its table's fresh sweep is complete and
 * the record is absent from it" (§13, WP-M7).
 *
 * The failure this file exists to catch is the worst one this package can have, and
 * it is silent: a deletion authorised on partial evidence removes records that are
 * alive on the instance and were merely not seen. Nothing downstream can notice —
 * the shard is rewritten, the tree is consistent with it, git commits a clean diff,
 * and the mirror now claims the instance does not contain a record it does contain.
 *
 * So the positive path here is scaffolding and the negatives are the subject. Each
 * negative asserts three separate things, because each can fail on its own:
 *
 *  1. the call REFUSES rather than returning an empty answer — {@link refusalOf}
 *     turns "returned normally" into a failure, so a future `return null` cannot
 *     pass this suite by looking like "nothing to delete";
 *  2. it refuses with {@link DeletionNotAuthorized}, not a bare `Error`, so a caller
 *     can tell INV-5 apart from an I/O fault and must not retry past it;
 *  3. the message names WHICH check refused. The module has exactly two refusals —
 *     the completeness check in the factory and the membership check in `authorize`
 *     — and an operator reading "refusing to delete" in a run report needs to know
 *     whether the sweep was cut short or the record was simply never proved gone.
 *
 * Every expectation is derived rather than restated: sys_ids come out of a hash, and
 * every `RecordEntry.path` comes out of the production `recordDirRelPath`, so a
 * fixture cannot agree with the code by being a copy of it.
 */
import { createHash } from "node:crypto";

import type { RecordEntry } from "../src/contracts";
import { isMirrorSysId, recordDirRelPath } from "../src/shards/shardLayout";
import {
  DeletionAuthority,
  DeletionNotAuthorized,
  type CompletedSweepEvidence,
  type SweptScopeEvidence,
} from "../src/write/deletionAuthority";

const TABLE = "sys_script_include";
/** Deliberately shares no substring with {@link TABLE}, so "names its own table" bites. */
const OTHER_TABLE = "cmdb_ci";
const GLOBAL = "global";
const APP_SCOPE = "x_acme_tools";
/** A third scope, so "stale in two scopes at once" can have a live one to move to. */
const OTHER_SCOPE = "x_other_app";

/** A valid INV-6 sys_id derived from a readable label — never hand-typed hex. */
function sysIdFor(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, 32);
}

function entryFor(args: {
  scope: string;
  table?: string;
  sysId: string;
  name: string;
  modCount?: number;
}): RecordEntry {
  const table = args.table ?? TABLE;
  const modCount = args.modCount ?? 3;
  return {
    // Derived by the production path builder, not spelled out here: a fixture that
    // hardcoded `instance/<scope>/<table>/<name>` would keep passing after a layout
    // change that moved every record on disk.
    path: recordDirRelPath({
      scope: args.scope,
      table,
      sysId: args.sysId,
      name: args.name,
    }),
    name: args.name,
    sysUpdatedOn: "2026-01-01 00:00:00",
    sysUpdatedBy: "admin",
    sysModCount: modCount,
    contentHash: createHash("sha256")
      .update(`${args.sysId}:${String(modCount)}`)
      .digest("hex"),
    files: [],
  };
}

/**
 * Run `action` and return the INV-5 refusal it raised.
 *
 * The `throw` at the end is the point: a module that answered "no" by returning an
 * empty authority, or by returning `undefined` from `authorize`, would satisfy an
 * `expect(...).toThrow()` written the lazy way only by accident. Here, returning
 * normally fails the test with a message that says so.
 */
function refusalOf(action: () => unknown): DeletionNotAuthorized {
  try {
    action();
  } catch (error) {
    if (error instanceof DeletionNotAuthorized) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a DeletionNotAuthorized, but the call returned normally");
}

/** Evidence for one scope, from two plain object literals. */
function scopeEvidence(args: {
  scope: string;
  baseline: Map<string, RecordEntry>;
  observed: Map<string, RecordEntry>;
}): SweptScopeEvidence {
  return { scope: args.scope, baseline: args.baseline, observed: args.observed };
}

function completedSweep(
  scopes: readonly SweptScopeEvidence[],
  sweepId = "sweep-1"
): CompletedSweepEvidence {
  return { table: TABLE, sweepId, complete: true, scopes };
}

const DELETED = sysIdFor("deleted-record");
const SURVIVOR = sysIdFor("surviving-record");

describe("INV-5: what a completed sweep proves", () => {
  it("authorises exactly the records the baseline claimed and the sweep never saw", () => {
    // Scaffolding for every negative below: unless this set is non-empty and
    // correct, "it refused" proves nothing, because refusing everything is easy.
    const gone = entryFor({ scope: GLOBAL, sysId: DELETED, name: "old_util" });
    const alive = entryFor({ scope: GLOBAL, sysId: SURVIVOR, name: "still_here" });

    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([
            [DELETED, gone],
            [SURVIVOR, alive],
          ]),
          observed: new Map([[SURVIVOR, alive]]),
        }),
      ])
    );

    expect(authority.size).toBe(1);
    expect(authority.has(GLOBAL, DELETED)).toBe(true);
    expect(authority.has(GLOBAL, SURVIVOR)).toBe(false);

    const deletion = authority.authorize(GLOBAL, DELETED);
    expect(deletion.path).toBe(gone.path);
    expect(deletion.scope).toBe(GLOBAL);
    // The entry is handed back by reference so the run report can quote what the
    // shard said before the sweep, not a reconstruction of it.
    expect(deletion.entry).toBe(gone);
    expect(authority.table).toBe(TABLE);
  });

  it("carries a sys_id that INV-6 would accept, in every fixture here", () => {
    // The fixtures are hashes, so a typo cannot produce a non-hex id — but if the
    // slice length or the digest encoding ever changed, every path assertion in this
    // file would start testing a string that could never reach the filesystem.
    expect([DELETED, SURVIVOR].every(isMirrorSysId)).toBe(true);
    expect(DELETED).not.toBe(SURVIVOR);
  });
});

describe("INV-5: a sweep that did not complete proves nothing", () => {
  it("refuses to mint an authority at all", () => {
    const gone = entryFor({ scope: GLOBAL, sysId: DELETED, name: "old_util" });
    const scopes = [
      scopeEvidence({
        scope: GLOBAL,
        baseline: new Map([[DELETED, gone]]),
        observed: new Map<string, RecordEntry>(),
      }),
    ];

    // Control first: with `complete: true` this very evidence authorises a deletion.
    // So the refusal below is caused by the completeness flag and by nothing else —
    // without this line the test would also pass against evidence that happened to
    // have nothing deletable in it.
    expect(DeletionAuthority.fromCompletedSweep(completedSweep(scopes)).size).toBe(1);

    const refusal = refusalOf(() =>
      DeletionAuthority.fromCompletedSweep({
        table: TABLE,
        sweepId: "sweep-1",
        complete: false,
        scopes,
      })
    );

    expect(refusal).toBeInstanceOf(DeletionNotAuthorized);
    expect(refusal.name).toBe("DeletionNotAuthorized");
    expect(refusal.message).toContain(TABLE);
    expect(refusal.message).toContain("did not complete");
    expect(refusal.message).toContain("INV-5");
    // It must not be reported as a fact about the record: no record is named here,
    // because the sweep's own state is what failed.
    expect(refusal.message).not.toContain(DELETED);
  });

  it("refuses even when the incomplete sweep had nothing to delete", () => {
    // An empty authority is a legitimate "nothing to delete"; a MISSING authority is
    // "you may not ask". Collapsing the two would make an interrupted sweep look
    // like a clean one whenever it happened to observe everything it had seen, and
    // that is precisely the case where the next call is a mistake.
    const refusal = refusalOf(() =>
      DeletionAuthority.fromCompletedSweep({
        table: TABLE,
        sweepId: "sweep-1",
        complete: false,
        scopes: [],
      })
    );

    expect(refusal.message).toContain("did not complete");
  });
});

describe("INV-5: evidence that belongs to something else", () => {
  it("refuses a sys_id no baseline in the evidence ever claimed", () => {
    const alive = entryFor({ scope: GLOBAL, sysId: SURVIVOR, name: "still_here" });
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[SURVIVOR, alive]]),
          observed: new Map([[SURVIVOR, alive]]),
        }),
      ])
    );

    const stranger = sysIdFor("never-mentioned");
    expect(authority.has(GLOBAL, stranger)).toBe(false);
    const refusal = refusalOf(() => authority.authorize(GLOBAL, stranger));

    expect(refusal.message).toContain(stranger);
    expect(refusal.message).toContain("was not proved absent");
    // The other refusal's wording must not appear: this sweep DID complete, and
    // reporting it as incomplete would send an operator looking for an interruption
    // that never happened.
    expect(refusal.message).not.toContain("did not complete");
  });

  it("refuses a sys_id the sweep observed alive", () => {
    const alive = entryFor({ scope: GLOBAL, sysId: SURVIVOR, name: "still_here" });
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[SURVIVOR, alive]]),
          observed: new Map([[SURVIVOR, alive]]),
        }),
      ])
    );

    expect(authority.size).toBe(0);
    expect(refusalOf(() => authority.authorize(GLOBAL, SURVIVOR)).message).toContain(SURVIVOR);
  });

  it("refuses a sys_id that a DIFFERENT table's sweep proved absent", () => {
    // The reconciler holds one authority per table and deletes in a loop. Handing
    // table A's authority a sys_id that table B proved gone must not delete A's copy
    // of that record — sys_ids are unique per instance, not per table, so a
    // table-agnostic authority would happily hand back a path in the wrong table.
    const goneFromOther = entryFor({
      scope: GLOBAL,
      table: OTHER_TABLE,
      sysId: DELETED,
      name: "old_util",
    });
    const other = DeletionAuthority.fromCompletedSweep({
      table: OTHER_TABLE,
      sweepId: "sweep-1",
      complete: true,
      scopes: [
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[DELETED, goneFromOther]]),
          observed: new Map<string, RecordEntry>(),
        }),
      ],
    });
    const mine = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map<string, RecordEntry>(),
          observed: new Map<string, RecordEntry>(),
        }),
      ])
    );

    // The other table's authority really does authorise it — so the refusal below is
    // about the table, not about the record being unknown to everybody.
    expect(other.authorize(GLOBAL, DELETED).path).toBe(goneFromOther.path);

    const refusal = refusalOf(() => mine.authorize(GLOBAL, DELETED));
    expect(refusal.message).toContain(TABLE);
    expect(refusal.message).not.toContain(OTHER_TABLE);
  });

  it("refuses a sys_id that only a LATER sweep proved absent (stale authority)", () => {
    // An authority is a statement about one sweep, and the reconciler may still be
    // holding yesterday's. Sweep 1 saw the record; sweep 2 did not. Only sweep 2's
    // authority may act on that, and sweep 1's refusal must name sweep 1 so the run
    // report shows which evidence was consulted.
    const entry = entryFor({ scope: GLOBAL, sysId: DELETED, name: "old_util" });
    const firstSweep = DeletionAuthority.fromCompletedSweep(
      completedSweep(
        [
          scopeEvidence({
            scope: GLOBAL,
            baseline: new Map([[DELETED, entry]]),
            observed: new Map([[DELETED, entry]]),
          }),
        ],
        "sweep-1"
      )
    );
    const secondSweep = DeletionAuthority.fromCompletedSweep(
      completedSweep(
        [
          scopeEvidence({
            scope: GLOBAL,
            baseline: new Map([[DELETED, entry]]),
            observed: new Map<string, RecordEntry>(),
          }),
        ],
        "sweep-2"
      )
    );

    expect(secondSweep.has(GLOBAL, DELETED)).toBe(true);
    const refusal = refusalOf(() => firstSweep.authorize(GLOBAL, DELETED));
    expect(refusal.message).toContain("sweep-1");
    expect(refusal.message).not.toContain("sweep-2");
  });

  it("words its two refusals differently, so a report says which check said no", () => {
    const entry = entryFor({ scope: GLOBAL, sysId: DELETED, name: "old_util" });
    const scopes = [
      scopeEvidence({
        scope: GLOBAL,
        baseline: new Map([[DELETED, entry]]),
        observed: new Map<string, RecordEntry>(),
      }),
    ];
    const incomplete = refusalOf(() =>
      DeletionAuthority.fromCompletedSweep({
        table: TABLE,
        sweepId: "sweep-1",
        complete: false,
        scopes,
      })
    );
    const unknown = refusalOf(() =>
      DeletionAuthority.fromCompletedSweep(completedSweep(scopes)).authorize(
        GLOBAL,
        sysIdFor("never-mentioned")
      )
    );

    expect(incomplete.message).not.toBe(unknown.message);
    for (const refusal of [incomplete, unknown]) {
      // Both are INV-5 refusals and both must be greppable as such.
      expect(refusal.message.startsWith("Refusing to delete: ")).toBe(true);
      expect(refusal.message.endsWith("(INV-5)")).toBe(true);
    }
  });
});

describe("INV-5 rule 2: a directory a live record has taken over", () => {
  const RENAMED = sysIdFor("renamed-record");

  /**
   * Record A is deleted; record B is renamed into A's old name in the same window.
   * `placeSurvivorAt` decides whether B ends up in A's directory or its own — that
   * one difference is the whole experiment.
   */
  function sweepWhere(placeSurvivorAt: string): DeletionAuthority {
    const deletedEntry = entryFor({ scope: GLOBAL, sysId: DELETED, name: "shared" });
    const survivorEntry = entryFor({
      scope: GLOBAL,
      sysId: RENAMED,
      name: placeSurvivorAt,
    });
    return DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[DELETED, deletedEntry]]),
          observed: new Map([[RENAMED, survivorEntry]]),
        }),
      ])
    );
  }

  it("refuses the stale record whose path a freshly written record now occupies", () => {
    // Rule 1 alone ("baseline minus observed") would authorise this and delete the
    // directory the sweep had just written for the LIVE record — losing a record
    // that exists on the instance while the shard says everything is fine.
    const authority = sweepWhere("shared");
    expect(authority.has(GLOBAL, DELETED)).toBe(false);
    expect(refusalOf(() => authority.authorize(GLOBAL, DELETED)).message).toContain(DELETED);
  });

  it("still authorises it when the freed directory stays free", () => {
    // The control for the test above: same fixture, survivor one directory over. If
    // this ever goes red together with the one above, rule 2 has stopped being a
    // path check and started refusing everything.
    const authority = sweepWhere("elsewhere");
    expect(authority.has(GLOBAL, DELETED)).toBe(true);
    expect(authority.authorize(GLOBAL, DELETED).path.endsWith("/shared")).toBe(true);
  });

  it("hands back the record's OLD location when it moved to another scope", () => {
    // The record still exists — in a different scope — so what is being removed is a
    // stale directory, and the path handed back must be the one the sweep proved
    // empty. Returning the live scope's path here would delete the record the sweep
    // had just written.
    const stale = entryFor({ scope: GLOBAL, sysId: DELETED, name: "moved" });
    const live = entryFor({ scope: APP_SCOPE, sysId: DELETED, name: "moved" });
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[DELETED, stale]]),
          observed: new Map<string, RecordEntry>(),
        }),
        scopeEvidence({
          scope: APP_SCOPE,
          baseline: new Map<string, RecordEntry>(),
          observed: new Map([[DELETED, live]]),
        }),
      ])
    );

    const deletion = authority.authorize(GLOBAL, DELETED);
    expect(deletion.scope).toBe(GLOBAL);
    expect(deletion.path).toBe(stale.path);
    expect(deletion.path).not.toBe(live.path);
  });

  it("keeps BOTH stale copies when one sys_id is stale in two scopes at once", () => {
    // The scenario is real and takes three sweeps to reach: `sys_scope` moves the
    // record from global to x_acme_tools, the sweep that should have cleaned global
    // up does not complete (so nothing is deleted), and it then moves on to
    // x_other_app. Now two scope directories hold a stale copy and both are
    // deletable — the instance holds the record exactly once.
    //
    // This is the test the sys_id-keyed map could not pass. `Map.set(sysId, …)`
    // overwrote the first with the second, so `size` was 1, and one directory stayed
    // in the repository for good: no error, no report line, and no way to ask for it
    // — the authority had no memory the record was ever there.
    const staleGlobal = entryFor({ scope: GLOBAL, sysId: DELETED, name: "wanderer" });
    const staleApp = entryFor({ scope: APP_SCOPE, sysId: DELETED, name: "wanderer" });
    const live = entryFor({ scope: OTHER_SCOPE, sysId: DELETED, name: "wanderer" });
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[DELETED, staleGlobal]]),
          observed: new Map<string, RecordEntry>(),
        }),
        scopeEvidence({
          scope: APP_SCOPE,
          baseline: new Map([[DELETED, staleApp]]),
          observed: new Map<string, RecordEntry>(),
        }),
        scopeEvidence({
          scope: OTHER_SCOPE,
          baseline: new Map<string, RecordEntry>(),
          observed: new Map([[DELETED, live]]),
        }),
      ])
    );

    expect(authority.size).toBe(2);
    expect(authority.authorize(GLOBAL, DELETED).path).toBe(staleGlobal.path);
    expect(authority.authorize(APP_SCOPE, DELETED).path).toBe(staleApp.path);
    // The scope the record actually lives in is not deletable from any direction —
    // the fix must not have turned one lost deletion into one wrong one.
    expect(authority.has(OTHER_SCOPE, DELETED)).toBe(false);
    // And `list()` carries both, because the report is where an operator would have
    // had to notice the missing one.
    expect(authority.list().map((entry) => entry.scope)).toEqual([GLOBAL, APP_SCOPE]);
  });

  it("refuses a scope the record was never stale in, even though the sys_id is deletable", () => {
    // The complement of the test above, and the reason `authorize` takes the scope
    // rather than searching for it: "this sys_id is deletable somewhere" is not
    // authorisation to delete it anywhere. A caller that names the wrong scope has
    // named a directory the sweep proved nothing about.
    const stale = entryFor({ scope: GLOBAL, sysId: DELETED, name: "wanderer" });
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline: new Map([[DELETED, stale]]),
          observed: new Map<string, RecordEntry>(),
        }),
        scopeEvidence({
          scope: APP_SCOPE,
          baseline: new Map<string, RecordEntry>(),
          observed: new Map<string, RecordEntry>(),
        }),
      ])
    );

    expect(authority.has(GLOBAL, DELETED)).toBe(true);
    const refusal = refusalOf(() => authority.authorize(APP_SCOPE, DELETED));
    // The message has to name the scope, or an operator reading it sees a refusal
    // for a record their report says IS deletable and has nothing to reconcile.
    expect(refusal.message).toContain(APP_SCOPE);
    expect(refusal.message).toContain(DELETED);
  });
});

describe("the deletable set as a value", () => {
  it("lists deletions by sys_id whatever order the evidence arrived in", () => {
    // Order that follows a Map's insertion sequence follows the API's paging order,
    // and the list ends up in a run report and a commit message. The expectation is
    // derived by sorting the fixture, so it cannot be a restatement of the code.
    const ids = ["a", "b", "c", "d"].map((label) => sysIdFor(`ordering-${label}`));
    const reversed = [...ids].sort().reverse();
    const baseline = new Map<string, RecordEntry>();
    for (const sysId of reversed) {
      baseline.set(sysId, entryFor({ scope: GLOBAL, sysId, name: `r_${sysId}` }));
    }
    // Guard: if the fixture happened to be inserted in ascending order already, the
    // assertion below would hold for a sort that does nothing.
    expect([...baseline.keys()]).not.toEqual([...ids].sort());

    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([
        scopeEvidence({
          scope: GLOBAL,
          baseline,
          observed: new Map<string, RecordEntry>(),
        }),
      ])
    );

    expect(authority.list().map((deletion) => deletion.sysId)).toEqual(
      [...ids].sort()
    );
    expect(authority.size).toBe(ids.length);
    expect(authority.list().every((deletion) => authority.has(deletion.scope, deletion.sysId))).toBe(
      true
    );
  });

  it("is a snapshot of the evidence, not a live view of it", () => {
    // The writer hands its own live `baseline`/`observed` maps to the factory and
    // keeps using the objects. If the authority read through to them, a later mutation
    // — an incremental sweep continuing, a test double, a retry — could widen the set
    // of records it is willing to delete after the evidence was accepted.
    const baseline = new Map<string, RecordEntry>([
      [DELETED, entryFor({ scope: GLOBAL, sysId: DELETED, name: "old_util" })],
    ]);
    const observed = new Map<string, RecordEntry>([
      [SURVIVOR, entryFor({ scope: GLOBAL, sysId: SURVIVOR, name: "still_here" })],
    ]);
    const authority = DeletionAuthority.fromCompletedSweep(
      completedSweep([scopeEvidence({ scope: GLOBAL, baseline, observed })])
    );
    expect(authority.size).toBe(1);

    const latecomer = sysIdFor("added-after-the-fact");
    baseline.set(
      latecomer,
      entryFor({ scope: GLOBAL, sysId: latecomer, name: "latecomer" })
    );
    observed.clear();

    expect(authority.size).toBe(1);
    expect(authority.has(GLOBAL, latecomer)).toBe(false);
    expect(refusalOf(() => authority.authorize(GLOBAL, latecomer)).message).toContain(
      latecomer
    );
  });
});
