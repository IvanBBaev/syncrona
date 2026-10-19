// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The checkpoint — §4.7's `CheckpointState` on disk, and the resume it licenses
 * (WP-M8, §5.4, §6, D1).
 *
 * A checkpoint is the only artifact allowed to describe an unfinished sweep, and
 * that makes it the one file whose MISREADING is more expensive than its loss. Three
 * jobs follow, each aimed at a specific way a resume goes wrong:
 *
 *  - **Parse defensively.** A truncated, corrupt or foreign-`formatVersion` file is
 *    reported as "no checkpoint" with a named reason and never crashes a sync. The
 *    file is machine-local, gitignored and entirely regenerable, so refusing to run
 *    because it is damaged would convert a recoverable state into a hard stop — in
 *    exactly the situation where starting over is what the operator wants. What it
 *    must never do is half-believe a file: a checkpoint whose `completedTables`
 *    parsed but whose `inProgress` did not would skip finished tables and restart
 *    the interrupted one from row zero *while reporting a resume*, which is worse
 *    than either honest answer. So validation is all-or-nothing.
 *  - **Answer the resume question by NAME.** {@link decideResume} matches the
 *    checkpoint's tables against a freshly derived plan by table name. The catalog is
 *    re-read on every run and tables genuinely appear and vanish between them
 *    (an app is installed, a scope is uninstalled), so a positional match would
 *    silently resume into a different table — writing table B's rows under table A's
 *    name with a cursor that means nothing there.
 *  - **Refuse rather than half-resume.** A different `sweepId` or a changed `mode`
 *    ends the resume with an actionable reason instead of a partial one. Mode is
 *    load-bearing beyond bookkeeping: INV-5 only accepts a full sweep as evidence
 *    that a record is absent, so resuming a `full` run's completed-table list into an
 *    `incremental` run would let watermark-shaped evidence inherit sweep authority.
 *
 * **Decision — the fate of `write/sweepProgress.ts` (its docblock asks for one).**
 * WP-M7 offered two exits: implement the same sink over the richer type, or absorb
 * {@link CheckpointProgressSink} and delete that file. This module takes the FIRST,
 * and the reason is the `Omit` in `WriterCheckpointState` rather than the cost of
 * the move. `preQuiescence` is evidence about the instance, obtained from the
 * Aggregate API by the Planner; the Writer never queries the instance and therefore
 * must not be able to name — let alone mint — a field that asserts what the instance
 * looked like. Absorbing would hand the Writer the full state and delete that
 * guarantee to save one small class. So {@link SweepCheckpointSink} implements the
 * same {@link SweepProgressSink} interface over the full `CheckpointState`, the
 * Writer keeps talking only to the interface, and `sweepProgress.ts` stays as the
 * narrower sink for runs that took no quiescence readings.
 *
 * The two sinks write the same path and their files are compatible in the direction
 * that matters: everything WP-M7 writes is a valid `CheckpointState`, so
 * {@link readCheckpoint} reads either one, and a WP-M7 file simply resumes without
 * quiescence evidence — which is the truth about how it was produced.
 */
import { SYS_ID_RE } from "./constants";
import type {
  CheckpointState,
  PlannedTable,
  QuiescenceReading,
  SyncMode,
  SyncPlan,
} from "./contracts";
import { canonicalJsonBytes } from "./serialize/serializer";
import { atomicWriteFile, removeFileIfPresent } from "./write/atomicWrite";
import { toNativePath, type WriterFs } from "./write/fs";
import {
  CHECKPOINT_FLUSH_EVERY_DEFAULT,
  CHECKPOINT_REL_PATH,
  type SweepProgressSink,
} from "./write/sweepProgress";

/**
 * Directory holding the checkpoint, derived from the path rather than restated.
 *
 * Deriving it keeps the two in step: a future §3 change that moves the file also
 * moves the directory the flush creates, with no second edit to forget.
 */
const CHECKPOINT_DIR_REL_PATH = CHECKPOINT_REL_PATH.slice(
  0,
  CHECKPOINT_REL_PATH.lastIndexOf("/")
);

/**
 * Why there is no usable checkpoint.
 *
 * Named rather than collapsed to `null` because the five cases have different
 * operator meanings and only one of them is normal. "No file" is the ordinary first
 * run; "not JSON" after a crash is expected and harmless; a foreign `formatVersion`
 * means a build older or newer than this one wrote it and the resume must not be
 * attempted at all; "unreadable" is a permissions or device problem the operator has
 * to fix and would otherwise be indistinguishable from a fresh start.
 */
export type CheckpointAbsence =
  | "no-file"
  | "unreadable"
  | "not-json"
  | "not-an-object"
  | "foreign-format-version"
  | "malformed-fields";

/**
 * The result of looking for a checkpoint.
 *
 * A discriminated union rather than `CheckpointState | null`, so that every caller
 * has the explanation in hand at the point it decides what to do. R3 forbids a
 * silent skip, and "started over because the checkpoint was damaged" is precisely
 * the kind of skip that goes unnoticed when the reason is thrown away.
 */
export type CheckpointRead =
  | { present: true; state: CheckpointState }
  | { present: false; reason: CheckpointAbsence; detail: string };

/** Build the negative arm of {@link CheckpointRead}. */
function absent(reason: CheckpointAbsence, detail: string): CheckpointRead {
  return { present: false, reason, detail };
}

/** Whether a value is a plain object — not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is one of §4.7's three modes. */
function isSyncMode(value: unknown): value is SyncMode {
  return value === "full" || value === "incremental" || value === "reconcile";
}

/** Whether a value is an array of strings, as `completedTables` must be. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate the `preQuiescence` map, or `null` when any part of it is wrong.
 *
 * Built on a null-prototype object for the same reason the serializer does it: the
 * keys are table names read out of a file, and a key literally spelled `__proto__`
 * assigned onto an ordinary object hits the inherited setter — silently discarding
 * the reading, or changing the object's prototype. A quiescence reading that
 * disappears on the way in would let a resumed run claim it proved something it
 * never measured.
 */
function parseQuiescence(value: unknown): Record<string, QuiescenceReading> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const readings: Record<string, QuiescenceReading> = Object.create(null);
  for (const [table, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const count = raw.count;
    const maxUpdatedOn = raw.maxUpdatedOn;
    // `Number.isFinite` rather than `typeof === "number"` alone: `NaN` survives
    // JSON only as a string, but a hand-edited or foreign writer could still
    // produce a count that fails every comparison it is later used in, and a
    // quiescence check that silently never fires is a proof that always passes.
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return null;
    }
    if (maxUpdatedOn !== null && typeof maxUpdatedOn !== "string") {
      return null;
    }
    readings[table] = { count, maxUpdatedOn };
  }
  return readings;
}

/**
 * Parse checkpoint TEXT into a {@link CheckpointRead} (§4.7).
 *
 * Separate from {@link readCheckpoint} so the validation can be exercised without a
 * filesystem, and so a caller that already holds the bytes — a test, a `mirror
 * status` report — does not have to re-read them.
 *
 * `inProgress.lastSysId` is checked against INV-6's shape and not merely against
 * `typeof "string"`. That value becomes the keyset cursor of the resumed table, so
 * it is interpolated into an encoded query where `^` separates conditions: a
 * checkpoint carrying `a^b` would not resume a table, it would issue a different
 * query than the one the plan describes.
 */
export function parseCheckpoint(text: string): CheckpointRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return absent("not-json", "The checkpoint file is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    return absent("not-an-object", "The checkpoint file does not hold a JSON object.");
  }
  if (parsed.formatVersion !== 1) {
    return absent(
      "foreign-format-version",
      `The checkpoint declares formatVersion ${JSON.stringify(parsed.formatVersion)}, which this build does not read (INV-8).`
    );
  }
  if (typeof parsed.sweepId !== "string" || parsed.sweepId === "") {
    return absent("malformed-fields", "The checkpoint has no usable `sweepId`.");
  }
  if (typeof parsed.startedAt !== "string" || parsed.startedAt === "") {
    return absent("malformed-fields", "The checkpoint has no usable `startedAt`.");
  }
  if (!isSyncMode(parsed.mode)) {
    return absent(
      "malformed-fields",
      `The checkpoint names mode ${JSON.stringify(parsed.mode)}, which is not one of full, incremental or reconcile.`
    );
  }
  if (!isStringArray(parsed.completedTables)) {
    return absent("malformed-fields", "The checkpoint's `completedTables` is not a list of table names.");
  }

  const state: CheckpointState = {
    formatVersion: 1,
    sweepId: parsed.sweepId,
    mode: parsed.mode,
    startedAt: parsed.startedAt,
    completedTables: [...parsed.completedTables],
  };

  if (parsed.inProgress !== undefined) {
    if (!isPlainObject(parsed.inProgress)) {
      return absent("malformed-fields", "The checkpoint's `inProgress` is not an object.");
    }
    const table = parsed.inProgress.table;
    const lastSysId = parsed.inProgress.lastSysId;
    if (typeof table !== "string" || table === "") {
      return absent("malformed-fields", "The checkpoint's `inProgress` names no table.");
    }
    if (typeof lastSysId !== "string" || !SYS_ID_RE.test(lastSysId)) {
      return absent(
        "malformed-fields",
        `The checkpoint's resume cursor ${JSON.stringify(lastSysId)} is not a sys_id (INV-6).`
      );
    }
    state.inProgress = { table, lastSysId };
  }

  if (parsed.preQuiescence !== undefined) {
    const readings = parseQuiescence(parsed.preQuiescence);
    if (readings === null) {
      return absent(
        "malformed-fields",
        "The checkpoint's `preQuiescence` is not a map of {count, maxUpdatedOn} readings."
      );
    }
    state.preQuiescence = readings;
  }

  return { present: true, state };
}

/**
 * Read the checkpoint at {@link CHECKPOINT_REL_PATH}, through the injected seam.
 *
 * `WriterFs.readFile` answers `null` for an absent file and throws for everything
 * else. The throw is caught here rather than propagated: a checkpoint the process
 * cannot read (a stale root-owned file, a device error) is still a regenerable,
 * gitignored artifact, and the correct response is to start the sweep over with the
 * reason named — not to abort a run that has not begun. Real local-IO failures still
 * stop the sweep, at the point where the WRITER cannot write (F8).
 */
export async function readCheckpoint(fs: WriterFs, root: string): Promise<CheckpointRead> {
  let bytes: Uint8Array | null;
  try {
    bytes = await fs.readFile(toNativePath(root, CHECKPOINT_REL_PATH));
  } catch (error) {
    return absent(
      "unreadable",
      `The checkpoint at ${CHECKPOINT_REL_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (bytes === null) {
    return absent("no-file", `No checkpoint at ${CHECKPOINT_REL_PATH}; this sweep starts from the beginning.`);
  }
  return parseCheckpoint(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/**
 * Write a checkpoint atomically (R4, §8 bytes).
 *
 * Through `atomicWriteFile` and `canonicalJsonBytes`, never `node:fs` and never
 * `JSON.stringify`: the file the crash-recovery story depends on may not itself have
 * a crash-corruption window, and every file the mirror writes goes through one
 * renderer so that "same input, same bytes" has no exceptions to remember.
 */
export async function writeCheckpoint(
  fs: WriterFs,
  root: string,
  state: CheckpointState
): Promise<void> {
  await fs.makeDir(toNativePath(root, CHECKPOINT_DIR_REL_PATH));
  await atomicWriteFile(fs, toNativePath(root, CHECKPOINT_REL_PATH), canonicalJsonBytes(state));
}

/**
 * Delete the checkpoint — what a sweep does once it has finished cleanly.
 *
 * Leaving it behind would make the next run believe the previous one was
 * interrupted and skip every table it lists, producing a mirror that describes one
 * run's tables and another run's timestamps.
 */
export async function clearCheckpoint(fs: WriterFs, root: string): Promise<void> {
  await removeFileIfPresent(fs, toNativePath(root, CHECKPOINT_REL_PATH));
}

/**
 * The checkpoint a plan starts from, before any table has completed.
 *
 * `preQuiescence` is copied from the plan here and nowhere else — this is the moment
 * D1's evidence becomes durable, and it is why the checkpoint is the full §4.7 state
 * rather than WP-M7's subtraction of it. Without this line an interrupted
 * `--verify-quiescent` run would resume having forgotten what the instance looked
 * like when it started, and could never do anything but report `quiescent: null`.
 */
export function checkpointForPlan(plan: SyncPlan, startedAt: string): CheckpointState {
  return {
    formatVersion: 1,
    sweepId: plan.sweepId,
    mode: plan.mode,
    startedAt,
    completedTables: [],
    ...(plan.preQuiescence === undefined ? {} : { preQuiescence: plan.preQuiescence }),
  };
}

/** Why a resume was refused. Each one is an operator-actionable difference. */
export type ResumeRefusal = "no-checkpoint" | "different-sweep" | "mode-changed";

/**
 * What a resumed run may skip, and what it must redo (§4.7, §6).
 *
 * Everything is stated positively — the caller never has to infer "resume" from a
 * missing field. `vanishedTables` and `droppedInProgress` exist because a resume is
 * allowed to be partially applicable and R3 forbids that being invisible: a table
 * the checkpoint finished but the catalog no longer offers, or an interrupted table
 * that has since been excluded, are both facts the coverage report should be able to
 * state rather than differences that quietly evaporate.
 */
export interface ResumeDecision {
  /** Whether the plan may skip work on the checkpoint's authority. */
  resume: boolean;
  /** Set when {@link resume} is false; null otherwise. */
  refusal: ResumeRefusal | null;
  /** Always present — an operator-facing sentence explaining this decision. */
  detail: string;
  /** Tables already swept AND still in the plan; the plan skips exactly these. */
  completedTables: string[];
  /** The table to resume mid-sweep and the keyset cursor to resume it from. */
  inProgress: { table: string; lastSysId: string } | null;
  /** Tables the checkpoint completed that the freshly derived plan no longer holds. */
  vanishedTables: string[];
  /** Interrupted table the plan no longer holds (or already counts as complete). */
  droppedInProgress: string | null;
  /** Quiescence readings carried across the interruption (D1); absent when none. */
  preQuiescence?: Record<string, QuiescenceReading>;
}

/** The refusal shape, with the fields that a refusal always zeroes out. */
function refuse(refusal: ResumeRefusal, detail: string): ResumeDecision {
  return {
    resume: false,
    refusal,
    detail,
    completedTables: [],
    inProgress: null,
    vanishedTables: [],
    droppedInProgress: null,
  };
}

/**
 * Decide what a freshly derived plan may inherit from a checkpoint (§4.7).
 *
 * The two refusals are not symmetric with the accept path and deliberately so. A
 * mismatched `sweepId` means the checkpoint belongs to a different run entirely, and
 * a changed `mode` means the completed-table list carries different authority than
 * the current run would grant it (INV-5). Neither is repairable by resuming "the
 * parts that match": a partial resume across a mode change produces a tree where
 * some tables hold sweep evidence and others watermark evidence while the coverage
 * report names one mode for all of them. Starting over costs API calls; resuming
 * wrongly costs correctness.
 */
export function decideResume(read: CheckpointRead, plan: SyncPlan): ResumeDecision {
  if (!read.present) {
    return refuse("no-checkpoint", `${read.detail} The sweep starts from the beginning.`);
  }
  const state = read.state;
  if (state.sweepId !== plan.sweepId) {
    return refuse(
      "different-sweep",
      `The checkpoint belongs to sweep ${state.sweepId} but this run is sweep ${plan.sweepId}; nothing is resumed. Re-run with the same sweep id to continue it, or delete ${CHECKPOINT_REL_PATH} to start clean.`
    );
  }
  if (state.mode !== plan.mode) {
    return refuse(
      "mode-changed",
      `The checkpoint was written by a ${state.mode} sweep and this run is ${plan.mode}; a resume across a mode change would give ${state.mode} evidence ${plan.mode} authority (INV-5). Re-run as ${state.mode}, or delete ${CHECKPOINT_REL_PATH} to start clean.`
    );
  }

  const planned = new Set(plan.tables.map((table) => table.entry.name));
  const completedTables: string[] = [];
  const vanishedTables: string[] = [];
  for (const table of state.completedTables) {
    (planned.has(table) ? completedTables : vanishedTables).push(table);
  }
  // Sorted rather than left in checkpoint order: both lists are read by humans and
  // rendered into a report, and the checkpoint's order is the previous run's
  // scheduling order, which is not a property a reader should have to reason about.
  completedTables.sort();
  vanishedTables.sort();

  const done = new Set(completedTables);
  let inProgress: ResumeDecision["inProgress"] = null;
  let droppedInProgress: string | null = null;
  if (state.inProgress !== undefined) {
    const table = state.inProgress.table;
    // `completedTables` wins over `inProgress` when they disagree: a shard on disk
    // is INV-4 evidence that the table's sweep finished, while `inProgress` is a
    // note that a row was written. Resuming mid-table into a table the same file
    // calls complete would re-fetch it and then flush a second shard set over the
    // first one.
    if (planned.has(table) && !done.has(table)) {
      inProgress = { table, lastSysId: state.inProgress.lastSysId };
    } else {
      droppedInProgress = table;
    }
  }

  const skipped = completedTables.length;
  return {
    resume: true,
    refusal: null,
    detail: `Resuming sweep ${state.sweepId} (${state.mode}) started at ${state.startedAt}: ${String(skipped)} table(s) already swept${inProgress === null ? "" : `, ${inProgress.table} resumes after ${inProgress.lastSysId}`}.`,
    completedTables,
    inProgress,
    vanishedTables,
    droppedInProgress,
    ...(state.preQuiescence === undefined ? {} : { preQuiescence: state.preQuiescence }),
  };
}

/**
 * The plan's tables minus the ones the checkpoint already finished, in plan order.
 *
 * The interrupted table is NOT removed — it is resumed, from
 * {@link ResumeDecision.inProgress}. Order is preserved rather than recomputed
 * because §4.5 makes the plan's order part of the contract: the coverage rows and
 * the report are rendered from this sequence and both are committed files.
 */
export function remainingTables(plan: SyncPlan, decision: ResumeDecision): PlannedTable[] {
  const done = new Set(decision.completedTables);
  return plan.tables.filter((table) => !done.has(table.entry.name));
}

/** Construction options for {@link SweepCheckpointSink}. */
export interface SweepCheckpointOptions {
  /** Absolute path of the mirror repository root. */
  root: string;
  /** Filesystem seam — the same one the writer uses. */
  fs: WriterFs;
  /**
   * The state this sweep starts from — typically {@link checkpointForPlan}, or a
   * resumed checkpoint whose `completedTables` are already populated.
   *
   * The whole state rather than five scalar options, because that is what carries
   * `preQuiescence`: an option list would have to name the field, and a sink that
   * can be TOLD a quiescence reading is a sink that can invent one.
   */
  state: CheckpointState;
  /** Write the checkpoint after this many records. */
  flushEvery?: number;
}

/**
 * A {@link SweepProgressSink} over the full §4.7 state — WP-M8's half of the
 * decision recorded in this module's docblock.
 *
 * Behaviourally identical to WP-M7's `CheckpointProgressSink` (same cadence, same
 * atomic write, same immediate flush on completion) and deliberately so: the writer
 * cannot tell them apart, and an operator comparing two checkpoint files should not
 * have to either. The single difference is what survives an interruption —
 * `preQuiescence`, which this sink carries through untouched and never modifies,
 * because the readings describe the instant the sweep began and nothing that happens
 * during the sweep can change what was true then.
 */
export class SweepCheckpointSink implements SweepProgressSink {
  private readonly root: string;
  private readonly fs: WriterFs;
  private readonly flushEvery: number;
  private readonly state: CheckpointState;
  private sinceFlush = 0;
  private dirty = false;

  constructor(options: SweepCheckpointOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.flushEvery = options.flushEvery ?? CHECKPOINT_FLUSH_EVERY_DEFAULT;
    if (!Number.isInteger(this.flushEvery) || this.flushEvery < 1) {
      throw new Error(
        `Checkpoint flushEvery must be a positive integer, received ${String(options.flushEvery)}`
      );
    }
    this.state = {
      ...options.state,
      completedTables: [...options.state.completedTables].sort(),
    };
  }

  async recordWritten(table: string, sysId: string): Promise<void> {
    this.state.inProgress = { table, lastSysId: sysId };
    this.dirty = true;
    this.sinceFlush += 1;
    if (this.sinceFlush >= this.flushEvery) {
      await this.flush();
    }
  }

  async tableCompleted(table: string): Promise<void> {
    if (!this.state.completedTables.includes(table)) {
      this.state.completedTables.push(table);
      this.state.completedTables.sort();
    }
    // The table is done, so there is no in-progress row for it any more — see
    // `decideResume`, which resolves the contradiction in the reader's favour but
    // should never have to.
    delete this.state.inProgress;
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    await writeCheckpoint(this.fs, this.root, this.state);
    this.sinceFlush = 0;
    this.dirty = false;
  }

  /** The state as it currently stands — for assertions and for the run report. */
  snapshot(): CheckpointState {
    return {
      ...this.state,
      completedTables: [...this.state.completedTables],
      ...(this.state.inProgress === undefined
        ? {}
        : { inProgress: { ...this.state.inProgress } }),
    };
  }
}
