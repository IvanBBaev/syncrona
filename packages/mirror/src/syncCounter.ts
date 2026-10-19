// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The run counter — the state that makes `reconcileEveryNSyncs` a cadence rather
 * than a setting (§5.4, INV-5).
 *
 * §5.4 promotes every Nth sync to `reconcile` mode, which forces `strategy:
 * "sweep"` for every table and is therefore the only routine way a DELETION on the
 * instance reaches the mirror: INV-5 accepts nothing but a completed full sweep as
 * evidence that a record is gone. "Every Nth" needs an N-th, and an ordinal is not
 * something a stateless run can know. The Planner is pure and takes the ordinal as
 * an input; before this module existed nothing supplied one, so the ordinal was
 * always 1, `1 % 10` was never 0, and every sync in the product's history planned
 * `incremental`. The cadence was advertised, configurable, documented — and
 * unreachable except by an operator who remembered `--full` by hand.
 *
 * ## Where the count lives
 *
 * `.mirror/state/sync-counter.json`, beside the checkpoint, in the directory
 * `write/gitIgnore.ts` hides from git. It cannot live IN the checkpoint, which is
 * the obvious first idea: `runMirrorCommand` deletes that file on every run that
 * reaches its own end, so a count stored there would be erased by exactly the runs
 * that are supposed to advance it.
 *
 * The format, the atomic write and the defensive parse are the checkpoint's,
 * deliberately and to the letter — same `formatVersion` gate (INV-8), same
 * all-or-nothing validation, same named-absence union, same `makeDir` +
 * `atomicWriteFile` + `canonicalJsonBytes` (R4). A second convention for a second
 * small state file is a second thing to get right.
 *
 * ## When it advances: completed runs only
 *
 * {@link advanceSyncCounter} is called on the path where `fatal === null` — exits 0
 * and 2 — and never on a fatal (exit 1). Two reasons, one of which is a
 * correctness bug rather than a preference:
 *
 *  1. **A consumed slot would break the resume.** `decideResume` refuses a
 *     checkpoint whose `mode` differs from the fresh plan's, because letting an
 *     incremental run inherit a full run's completed-table list would give
 *     watermark evidence sweep authority (INV-5). Now suppose run 10 — the
 *     reconcile — dies fatally halfway. If the counter had already advanced, run 11
 *     plans `incremental`, the modes disagree, the resume is refused, and every
 *     table the reconcile completed is swept again from scratch. Holding at 9 means
 *     the retry is once again ordinal 10, once again `reconcile`, and the
 *     checkpoint it left behind is accepted. The failed run keeps its place in the
 *     queue instead of forfeiting it.
 *  2. **The count means "syncs completed", so it should count them.** A run that
 *     could not finish did not reconcile and did not prove anything about the
 *     instance; letting it consume a slot would push the next real reconcile
 *     further away every time the network flaked, which is the direction that
 *     hides deletions rather than surfacing them.
 *
 * The value written is always exactly one more than the value that was READ, never
 * one more than the ordinal the run used. That matters because
 * `RunMirrorCommandOptions.syncOrdinal` is an override a caller may pass: an
 * override changes what THIS run does and cannot rewrite the mirror's history.
 *
 * ## Not exported from the package barrel
 *
 * See `index.ts`. A consumer that can write this file can move a reconcile
 * arbitrarily far into the future — the same authority INV-5 spends the reconciler
 * refusing to grant — and can do it without producing any evidence at all.
 */
import { canonicalJsonBytes } from "./serialize/serializer";
import { atomicWriteFile } from "./write/atomicWrite";
import { toNativePath, type WriterFs } from "./write/fs";
import { CHECKPOINT_REL_PATH } from "./write/sweepProgress";

/**
 * The state directory, derived from the checkpoint path for the reason
 * `checkpoint.ts` derives its own: one spelling of `.mirror/state`, so a §3 rename
 * moves both files rather than separating them.
 */
const STATE_DIR_REL_PATH = CHECKPOINT_REL_PATH.slice(0, CHECKPOINT_REL_PATH.lastIndexOf("/"));

/** Where the count lives. */
export const SYNC_COUNTER_REL_PATH = `${STATE_DIR_REL_PATH}/sync-counter.json`;

/**
 * §5.4's cadence position, on disk.
 *
 * One field, and it is a COUNT of finished runs rather than "the ordinal of the
 * next one". The difference shows up on a fresh mirror: a count starts at the
 * honest zero, while a stored next-ordinal would have to start at a 1 that no run
 * has earned, and every reader would have to remember which of the two the file
 * holds. {@link nextSyncOrdinal} performs the one conversion.
 */
export interface SyncCounterState {
  /** INV-8's gate. Bumped only by a change this build cannot read. */
  formatVersion: 1;
  /** Runs that reached their own end against this mirror. Zero on a fresh tree. */
  completedSyncs: number;
}

/**
 * Why there is no usable count — the checkpoint's vocabulary, for the same reason
 * it has one. Only `no-file` is the ordinary case (a mirror that has never
 * completed a sync); every other value means a run's cadence position was silently
 * reset to the start unless somebody says so out loud, which is the class of skip
 * R3 forbids.
 */
export type SyncCounterAbsence =
  | "no-file"
  | "unreadable"
  | "not-json"
  | "not-an-object"
  | "foreign-format-version"
  | "malformed-fields";

/** The result of looking for the count. */
export type SyncCounterRead =
  | { present: true; state: SyncCounterState }
  | { present: false; reason: SyncCounterAbsence; detail: string };

/** Build the negative arm of {@link SyncCounterRead}. */
function absent(reason: SyncCounterAbsence, detail: string): SyncCounterRead {
  return { present: false, reason, detail };
}

/**
 * Parse counter TEXT (§5.4).
 *
 * `Number.isSafeInteger` rather than `typeof === "number"`: the value is used in a
 * modulo against the configured N, and a float, a negative or a value past 2^53
 * would produce a position that is either meaningless or never zero — a cadence
 * that silently never fires, which is the defect this module exists to remove.
 * Rejecting is safe because rejection is visible: the caller resets to zero AND
 * reports the reason.
 */
export function parseSyncCounter(text: string): SyncCounterRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return absent("not-json", "The sync counter file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return absent("not-an-object", "The sync counter file does not hold a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.formatVersion !== 1) {
    return absent(
      "foreign-format-version",
      `The sync counter declares formatVersion ${JSON.stringify(record.formatVersion)}, which this build does not read (INV-8).`
    );
  }
  const completedSyncs = record.completedSyncs;
  if (typeof completedSyncs !== "number" || !Number.isSafeInteger(completedSyncs) || completedSyncs < 0) {
    return absent(
      "malformed-fields",
      `The sync counter's completedSyncs is ${JSON.stringify(completedSyncs)}, which is not a count of completed runs.`
    );
  }
  return { present: true, state: { formatVersion: 1, completedSyncs } };
}

/**
 * Read the count through the injected seam.
 *
 * A throw becomes `unreadable` rather than propagating, exactly as the checkpoint's
 * reader does it: this file is machine-local and regenerable, and refusing to
 * mirror an instance because a bookkeeping file has the wrong owner would turn a
 * cosmetic problem into an outage. The cost of degrading is a deferred reconcile,
 * and {@link SyncCounterRead.detail} is what keeps that from being invisible.
 */
export async function readSyncCounter(fs: WriterFs, root: string): Promise<SyncCounterRead> {
  let bytes: Uint8Array | null;
  try {
    bytes = await fs.readFile(toNativePath(root, SYNC_COUNTER_REL_PATH));
  } catch (error) {
    return absent(
      "unreadable",
      `The sync counter at ${SYNC_COUNTER_REL_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (bytes === null) {
    return absent(
      "no-file",
      `No sync counter at ${SYNC_COUNTER_REL_PATH}; this run counts as the first sync of the cycle.`
    );
  }
  return parseSyncCounter(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** How many completed runs the read attests to — zero for every absence. */
function completedFrom(read: SyncCounterRead): number {
  return read.present ? read.state.completedSyncs : 0;
}

/**
 * The 1-based ordinal of the run about to start.
 *
 * The run in progress counts itself, which is what makes `ordinal % everyN === 0`
 * promote the Nth run rather than the (N+1)th.
 */
export function nextSyncOrdinal(read: SyncCounterRead): number {
  return completedFrom(read) + 1;
}

/**
 * Record that a run finished, advancing the count by exactly one from what was
 * read (see the module docblock on why the ordinal is not used here).
 *
 * Unguarded, like `clearCheckpoint` beside which it is called: both are small local
 * writes into a directory the run has already written to many times, and a `try`
 * that swallowed a failure here would let a mirror advertise a cadence it is not
 * keeping. If the state directory has genuinely become unwritable, that is F8 and
 * the operator needs to hear about it.
 */
export async function advanceSyncCounter(
  fs: WriterFs,
  root: string,
  read: SyncCounterRead
): Promise<SyncCounterState> {
  const state: SyncCounterState = {
    formatVersion: 1,
    completedSyncs: completedFrom(read) + 1,
  };
  await fs.makeDir(toNativePath(root, STATE_DIR_REL_PATH));
  await atomicWriteFile(fs, toNativePath(root, SYNC_COUNTER_REL_PATH), canonicalJsonBytes(state));
  return state;
}

/**
 * The operator-facing sentence for a count that could not be read, or `null` when
 * there is nothing to say.
 *
 * `no-file` and a successful read are both silent: a mirror's first sync is not an
 * incident. Everything else IS one — the cadence just restarted, so the next
 * automatic reconcile is up to N runs further away than the operator expects, and
 * on a mirror whose deletions only arrive with that reconcile the difference is
 * records that stay in the tree after they left the instance.
 */
export function syncCounterWarning(read: SyncCounterRead): string | null {
  if (read.present || read.reason === "no-file") {
    return null;
  }
  return `${read.detail} The reconcile cadence restarts from sync 1; run \`syncrona mirror sync --reconcile\` if a reconcile was due.`;
}
