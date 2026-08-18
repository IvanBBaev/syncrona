// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The other half of INV-4 — where progress lives while a table is mid-sweep
 * (WP-M7, §5.8, §4.7).
 *
 * INV-4 has two clauses and only one of them is a prohibition. "Shards flush to
 * disk only when the table sweep completes" is the prohibition, and the shard store
 * enforces it. "Until then the checkpoint carries progress" is an obligation, and
 * something has to discharge it: a sweep that writes 400 000 record directories,
 * flushes no shard, and then dies must not have to start the table again from row
 * one. Without this module the writer would satisfy INV-4 by losing work, which is
 * the letter of R2 and the opposite of its purpose.
 *
 * **Boundary — read this before extending.** The canonical `CheckpointState` (§4.7,
 * with `preQuiescence` carried from the plan) belongs to WP-M8, the resume/interrupt
 * work package. WP-M7 cannot depend on a type that does not exist yet and must not
 * mint the package's checkpoint contract on WP-M8's behalf. So this module defines
 * the NARROWEST thing the writer needs — {@link WriterCheckpointState}, which is
 * §4.7 minus `preQuiescence` — behind a {@link SweepProgressSink} interface, and the
 * writer only ever talks to the interface. When WP-M8 lands the full state, it
 * either implements the same sink over its own richer type (nothing in the writer
 * changes) or absorbs {@link CheckpointProgressSink} and drops this file. Both are
 * cheap precisely because the writer never names the concrete class.
 *
 * The field names and the file location match §4.7 exactly so the two are readable
 * as the same document on disk, and `formatVersion` is present so that a WP-M8
 * checkpoint and a WP-M7 checkpoint are distinguishable rather than silently
 * mixed.
 */
import type { CheckpointState, SyncMode } from "../contracts";
import { canonicalJsonBytes } from "../serialize/serializer";
import { atomicWriteFile } from "./atomicWrite";
import { toNativePath, type WriterFs } from "./fs";

/**
 * Sweep modes §4.7 admits. Named here because the writer branches on them.
 *
 * An alias of the contract's own union rather than a second copy: this file was
 * written before WP-M8 declared `SyncMode`, and the moment both existed the copy
 * became a thing that could gain a fourth member on one side only. The local name
 * stays because the writer's call sites read better for it.
 */
export type MirrorSweepMode = SyncMode;

/**
 * §4.7's {@link CheckpointState} minus `preQuiescence` — see the module docblock
 * for why WP-M7 stops there.
 *
 * Derived with `Omit` rather than restated, so the two cannot disagree. The
 * subtraction is the point and is load-bearing in one direction only: everything
 * WP-M7 writes is a valid `CheckpointState` field, so a WP-M8 reader can consume a
 * WP-M7 file, while a writer holding one of these can never invent a quiescence
 * reading it did not take. `preQuiescence` is evidence about the instance, and the
 * writer never queries the instance.
 */
export type WriterCheckpointState = Omit<CheckpointState, "preQuiescence">;

/**
 * Where the checkpoint lives (§3). Under `.mirror/state/`, which the generated
 * repo's `.gitignore` excludes — resumption state is machine-local and committing
 * it would make two clones of the mirror disagree about what they had already done.
 */
export const CHECKPOINT_REL_PATH = ".mirror/state/checkpoint.json";

/**
 * What the writer tells the outside world about its progress.
 *
 * Deliberately three verbs and no getters. The writer reports; it does not consult
 * the checkpoint, decide what to resume, or read anything back. That decision
 * belongs to the planner (WP-M8), and keeping the writer write-only here means a
 * resume policy can change without the writer being able to notice.
 */
export interface SweepProgressSink {
  /** One record's bytes are on disk. `sysId` is the resume point. */
  recordWritten(table: string, sysId: string): Promise<void>;
  /** A table's sweep finished and its shards are flushed — INV-4's release point. */
  tableCompleted(table: string): Promise<void>;
  /** Flush whatever is pending; called before the sweep reports its exit code. */
  flush(): Promise<void>;
}

/** A sink that discards everything — the default when no resumption is wanted. */
export function nullProgressSink(): SweepProgressSink {
  return {
    async recordWritten(): Promise<void> {
      /* intentionally nothing */
    },
    async tableCompleted(): Promise<void> {
      /* intentionally nothing */
    },
    async flush(): Promise<void> {
      /* intentionally nothing */
    },
  };
}

/** Construction options for {@link CheckpointProgressSink}. */
export interface CheckpointProgressOptions {
  /** Absolute path of the mirror repository root. */
  root: string;
  /** Identifier of the sweep being recorded. */
  sweepId: string;
  /** Sweep mode, carried into the checkpoint verbatim. */
  mode: MirrorSweepMode;
  /** ISO-8601 start instant, carried into the checkpoint verbatim. */
  startedAt: string;
  /** Filesystem seam — the same one the writer uses. */
  fs: WriterFs;
  /**
   * Write the checkpoint after this many records. See the class docblock for the
   * measurement behind the default.
   */
  flushEvery?: number;
}

/**
 * How many records may be re-fetched after a crash, traded against how often the
 * checkpoint is rewritten.
 *
 * The two ends are both bad. Flushing on every record adds a write-plus-rename to
 * every record the sweep writes — on the order of 25-30 % more filesystem syscalls
 * for a table of small records, to save at most one record of re-fetching. Never
 * flushing until the table ends makes the checkpoint useless for exactly the tables
 * that need it. 250 puts the worst-case redundant work at 250 rows — a quarter of
 * one page at `PAGE_SIZE_DEFAULT`, so under a second of API time — while adding one
 * checkpoint write per 250 record writes, which is below the noise floor of the
 * record writes themselves.
 *
 * The re-fetched records are not wasted: rewriting a record with identical bytes
 * produces an identical file, so a resume costs API calls, never a spurious diff.
 * That is why the number can be this large without threatening INV-1.
 */
export const CHECKPOINT_FLUSH_EVERY_DEFAULT = 250;

/**
 * A {@link SweepProgressSink} that persists §4.7-shaped state to disk.
 *
 * Every write goes through {@link atomicWriteFile}, and that is not incidental. The
 * checkpoint is the one file whose corruption costs the most: a half-written
 * `checkpoint.json` is unparseable, an unparseable checkpoint has to be treated as
 * absent, and an absent checkpoint means the interrupted table restarts from row
 * one. The file the crash-recovery story depends on may not itself have a
 * crash-corruption window.
 *
 * `tableCompleted` always flushes immediately, ignoring `flushEvery`. The
 * `completedTables` entry is what lets a resume skip a table entirely, and it is
 * only sound because the shards for that table are already on disk when it is
 * recorded (INV-4) — so it is written at the exact moment the claim becomes true,
 * not up to 250 records later.
 */
export class CheckpointProgressSink implements SweepProgressSink {
  private readonly root: string;
  private readonly fs: WriterFs;
  private readonly flushEvery: number;
  private readonly state: WriterCheckpointState;
  private sinceFlush = 0;
  private dirty = false;

  constructor(options: CheckpointProgressOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.flushEvery = options.flushEvery ?? CHECKPOINT_FLUSH_EVERY_DEFAULT;
    if (!Number.isInteger(this.flushEvery) || this.flushEvery < 1) {
      throw new Error(
        `Checkpoint flushEvery must be a positive integer, received ${String(options.flushEvery)}`
      );
    }
    this.state = {
      formatVersion: 1,
      sweepId: options.sweepId,
      mode: options.mode,
      startedAt: options.startedAt,
      completedTables: [],
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
      // Sorted rather than in completion order: the checkpoint is compared between
      // runs by humans and by tests, and completion order is the planner's
      // scheduling order, which is not a property anyone should have to reason
      // about when reading it.
      this.state.completedTables.sort();
    }
    // The table is done, so there is no in-progress row for it any more. Leaving a
    // stale `inProgress` would tell a resume to restart mid-table in a table that
    // `completedTables` says is finished — two clauses of the same file disagreeing.
    delete this.state.inProgress;
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const path = toNativePath(this.root, CHECKPOINT_REL_PATH);
    await this.fs.makeDir(dirNameOf(path));
    // Canonical bytes via the serializer, not `JSON.stringify`: the checkpoint is
    // a file in the user's tree and INV-1's "same input, same bytes" reads better
    // when every file the mirror writes goes through one renderer (§8).
    await atomicWriteFile(this.fs, path, canonicalJsonBytes(this.state));
    this.sinceFlush = 0;
    this.dirty = false;
  }

  /** The state as it currently stands — for assertions and for the run report. */
  snapshot(): WriterCheckpointState {
    return {
      ...this.state,
      completedTables: [...this.state.completedTables],
      ...(this.state.inProgress === undefined
        ? {}
        : { inProgress: { ...this.state.inProgress } }),
    };
  }
}

/**
 * Parent directory of a native path.
 *
 * Hand-rolled rather than `path.dirname` because the path was produced by
 * {@link toNativePath}, so its separator is known, and because `dirname` on Windows
 * also interprets `/` — which would make this function's answer depend on which
 * separators happened to survive, exactly the ambiguity `toNativePath` exists to
 * remove.
 */
function dirNameOf(nativePath: string): string {
  const index = Math.max(nativePath.lastIndexOf("/"), nativePath.lastIndexOf("\\"));
  /* istanbul ignore next -- @preserve: toNativePath always yields a separator here. */
  return index <= 0 ? nativePath : nativePath.slice(0, index);
}

/**
 * Read a checkpoint back, or `null` when there is none or it is unreadable.
 *
 * Provided so WP-M8 has a parser that agrees with this writer byte-for-byte, and so
 * the INV-4 interrupt test can assert resumption against the real file rather than
 * against an in-memory snapshot the production code never touched.
 *
 * An unparseable or wrong-shaped checkpoint returns `null` — "no resumption
 * information" — rather than throwing. Refusing to run because a machine-local,
 * gitignored, entirely regenerable file is corrupt would turn a recoverable state
 * into a hard stop, and the corrupt case is precisely the one where the tool most
 * needs to be able to start over.
 */
export async function readWriterCheckpoint(
  fs: WriterFs,
  root: string
): Promise<WriterCheckpointState | null> {
  const bytes = await fs.readFile(toNativePath(root, CHECKPOINT_REL_PATH));
  if (bytes === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.formatVersion !== 1 ||
    typeof candidate.sweepId !== "string" ||
    typeof candidate.startedAt !== "string" ||
    !isSweepMode(candidate.mode) ||
    !isStringArray(candidate.completedTables)
  ) {
    return null;
  }
  const state: WriterCheckpointState = {
    formatVersion: 1,
    sweepId: candidate.sweepId,
    mode: candidate.mode,
    startedAt: candidate.startedAt,
    completedTables: [...candidate.completedTables],
  };
  const inProgress = candidate.inProgress;
  if (typeof inProgress === "object" && inProgress !== null) {
    const progress = inProgress as Record<string, unknown>;
    if (typeof progress.table === "string" && typeof progress.lastSysId === "string") {
      state.inProgress = { table: progress.table, lastSysId: progress.lastSysId };
    }
  }
  return state;
}

function isSweepMode(value: unknown): value is MirrorSweepMode {
  return value === "full" || value === "incremental" || value === "reconcile";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
