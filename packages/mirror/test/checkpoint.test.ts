// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Checkpoint tests — WP-M8, §4.7, §6, D1, INV-4, INV-5, INV-6.
 *
 * The checkpoint is the only file that can make a sweep skip work, so every test
 * here is about a way that skip could be wrong:
 *
 *  - *Half-believing a file.* A checkpoint whose `completedTables` parsed but whose
 *    `inProgress` did not would skip the finished tables and silently restart the
 *    interrupted one from row zero while REPORTING a resume. Validation is
 *    all-or-nothing, and the parser tests below assert the "or-nothing" half.
 *  - *Matching by position.* The catalog is re-read between runs, so a checkpoint
 *    matched positionally against a fresh plan resumes into a different table with a
 *    cursor that means nothing there. Everything is matched by name, and the tests
 *    move tables in and out of the plan to prove it.
 *  - *Resuming across a mode change.* INV-5 only accepts a full sweep as evidence of
 *    absence, so inheriting a `full` run's completed-table list into an `incremental`
 *    run would launder watermark-shaped evidence into sweep authority.
 *  - *Forgetting the quiescence proof.* D1's readings describe the instant the sweep
 *    began; if they do not survive the interruption, a resumed `--verify-quiescent`
 *    run can only ever report `quiescent: null`.
 *
 * Progress is observed through the `WriterFs` seam and specifically through renames
 * onto the checkpoint path, because that is where `atomicWriteFile` commits — a
 * staged `writeFile` a crash could still discard is not a commit. The in-memory
 * filesystem refuses to create a file whose parent directory was never made, the way
 * `open(2)` does, so a flush that forgot its `makeDir` fails here.
 */
import { sep } from "node:path";

import {
  checkpointForPlan,
  clearCheckpoint,
  decideResume,
  parseCheckpoint,
  readCheckpoint,
  remainingTables,
  SweepCheckpointSink,
  writeCheckpoint,
  type CheckpointRead,
} from "../src/checkpoint";
import type {
  CheckpointState,
  PlannedTable,
  QuiescenceReading,
  SyncPlan,
  TableCatalogEntry,
} from "../src/contracts";
import type { WriterDirEntry, WriterFs } from "../src/write/fs";
import {
  CHECKPOINT_FLUSH_EVERY_DEFAULT,
  CHECKPOINT_REL_PATH,
  readWriterCheckpoint,
} from "../src/write/sweepProgress";

const ROOT = `${sep}mirror-root`;
const SWEEP_ID = "sweep-7f3a";
const STARTED_AT = "2026-08-18T09:00:00.000Z";
const CHECKPOINT_NATIVE = [ROOT, ".mirror", "state", "checkpoint.json"].join(sep);
const CHECKPOINT_DIR_NATIVE = [ROOT, ".mirror", "state"].join(sep);
const READING: QuiescenceReading = { count: 12, maxUpdatedOn: "2026-08-18 08:30:00" };

/** A sys_id-shaped resume point, distinct per index (INV-6). */
function sysIdFor(index: number): string {
  return index.toString(16).padStart(32, "0");
}

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

class MemoryFs implements WriterFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly calls: string[] = [];
  /** When set, every `readFile` rejects — the unreadable-checkpoint case. */
  readFailure: Error | null = null;

  async makeDir(dir: string): Promise<void> {
    this.calls.push(`makeDir ${dir}`);
    const parts = dir.split(sep);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = parts.slice(0, depth).join(sep);
      if (candidate !== "") {
        this.dirs.add(candidate);
      }
    }
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`writeFile ${filePath}`);
    if (!this.dirs.has(parentOf(filePath))) {
      throw new Error(`ENOENT: no directory holds ${filePath}`);
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      throw new Error(`ENOENT: nothing to rename at ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    if (this.readFailure !== null) {
      throw this.readFailure;
    }
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    if (!this.dirs.has(dir)) {
      return null;
    }
    const entries: WriterDirEntry[] = [];
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        entries.push({ name: filePath.slice(dir.length + sep.length), isDirectory: false });
      }
    }
    return entries;
  }

  async removeRecursive(target: string): Promise<void> {
    this.calls.push(`removeRecursive ${target}`);
    this.files.delete(target);
  }

  /** How many times the checkpoint was COMMITTED — renames onto its path. */
  commitCount(): number {
    return this.calls.filter((call) => call.endsWith(`-> ${CHECKPOINT_NATIVE}`)).length;
  }

  checkpointText(): string | null {
    const bytes = this.files.get(CHECKPOINT_NATIVE);
    return bytes === undefined ? null : new TextDecoder("utf-8").decode(bytes);
  }

  /** Put a handwritten checkpoint on disk, bypassing every writer. */
  async place(text: string): Promise<void> {
    await this.makeDir(CHECKPOINT_DIR_NATIVE);
    this.files.set(CHECKPOINT_NATIVE, new TextEncoder().encode(text));
  }
}

// ---------------------------------------------------------------------------
// Plan fixtures
// ---------------------------------------------------------------------------

function catalogEntry(name: string): TableCatalogEntry {
  return {
    name,
    sysId: "0".repeat(32),
    superClass: null,
    isMetadata: true,
    tier: 1,
    rowCount: 1,
    maxUpdatedOn: null,
    fields: [],
    status: "included",
  };
}

function planned(name: string): PlannedTable {
  return { entry: catalogEntry(name), strategy: "sweep" };
}

function planFor(names: readonly string[], overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    sweepId: SWEEP_ID,
    mode: "full",
    tables: names.map(planned),
    ...overrides,
  };
}

function stateFor(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    formatVersion: 1,
    sweepId: SWEEP_ID,
    mode: "full",
    startedAt: STARTED_AT,
    completedTables: [],
    ...overrides,
  };
}

function presentState(read: CheckpointRead): CheckpointState {
  if (!read.present) {
    throw new Error(`expected a checkpoint, got ${read.reason}: ${read.detail}`);
  }
  return read.state;
}

// ---------------------------------------------------------------------------
// Parsing — refusing to half-believe a file
// ---------------------------------------------------------------------------

describe("parseCheckpoint (§4.7)", () => {
  it("reads a minimal checkpoint", () => {
    const state = presentState(
      parseCheckpoint(
        JSON.stringify({
          formatVersion: 1,
          sweepId: SWEEP_ID,
          mode: "incremental",
          startedAt: STARTED_AT,
          completedTables: ["incident", "problem"],
        })
      )
    );
    expect(state).toEqual({
      formatVersion: 1,
      sweepId: SWEEP_ID,
      mode: "incremental",
      startedAt: STARTED_AT,
      completedTables: ["incident", "problem"],
    });
  });

  it("reads inProgress and preQuiescence when they are well formed", () => {
    const state = presentState(
      parseCheckpoint(
        JSON.stringify({
          ...stateFor(),
          inProgress: { table: "incident", lastSysId: sysIdFor(9) },
          preQuiescence: { incident: READING, problem: { count: 0, maxUpdatedOn: null } },
        })
      )
    );
    expect(state.inProgress).toEqual({ table: "incident", lastSysId: sysIdFor(9) });
    expect(state.preQuiescence).toEqual({
      incident: READING,
      problem: { count: 0, maxUpdatedOn: null },
    });
  });

  it("reports a truncated file as not-json rather than throwing", () => {
    // A crash mid-write is the expected way this file becomes unreadable, and a
    // regenerable machine-local artifact must never turn a recoverable state into a
    // hard stop.
    const read = parseCheckpoint('{"formatVersion":1,"sweepId":"swe');
    expect(read).toMatchObject({ present: false, reason: "not-json" });
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["null", '"a string"', "[1,2,3]", "7"]) {
      expect(parseCheckpoint(text)).toMatchObject({
        present: false,
        reason: "not-an-object",
      });
    }
  });

  it("refuses a foreign format version and names it (INV-8)", () => {
    const read = parseCheckpoint(JSON.stringify({ ...stateFor(), formatVersion: 2 }));
    expect(read).toMatchObject({ present: false, reason: "foreign-format-version" });
    expect(read.present ? "" : read.detail).toContain("2");
  });

  it("refuses every malformed scalar field, one at a time", () => {
    const cases: Array<Record<string, unknown>> = [
      { sweepId: 7 },
      { sweepId: "" },
      { startedAt: null },
      { startedAt: "" },
      { mode: "sideways" },
      { completedTables: "incident" },
      { completedTables: ["incident", 3] },
    ];
    for (const override of cases) {
      expect(parseCheckpoint(JSON.stringify({ ...stateFor(), ...override }))).toMatchObject({
        present: false,
        reason: "malformed-fields",
      });
    }
  });

  it("refuses a malformed inProgress rather than dropping it", () => {
    // Dropping it is the dangerous repair: the run would skip the completed tables
    // and restart the interrupted one from row one while calling itself a resume.
    const cases: unknown[] = [
      "incident",
      { lastSysId: sysIdFor(1) },
      { table: "", lastSysId: sysIdFor(1) },
      { table: "incident" },
      { table: "incident", lastSysId: 5 },
    ];
    for (const inProgress of cases) {
      expect(parseCheckpoint(JSON.stringify({ ...stateFor(), inProgress }))).toMatchObject({
        present: false,
        reason: "malformed-fields",
      });
    }
  });

  it("refuses a resume cursor that is not a sys_id (INV-6)", () => {
    // The cursor is interpolated into an encoded query where `^` separates
    // conditions, so a value like this would not resume a table — it would issue a
    // different query than the plan describes.
    const read = parseCheckpoint(
      JSON.stringify({
        ...stateFor(),
        inProgress: { table: "incident", lastSysId: "abc^ORDERBYsys_id" },
      })
    );
    expect(read).toMatchObject({ present: false, reason: "malformed-fields" });
    expect(read.present ? "" : read.detail).toContain("INV-6");
  });

  it("refuses a malformed preQuiescence rather than importing half of it", () => {
    const cases: unknown[] = [
      "quiet",
      [{ count: 1 }],
      { incident: 4 },
      { incident: [1] },
      { incident: { maxUpdatedOn: null } },
      { incident: { count: "12", maxUpdatedOn: null } },
      { incident: { count: 12, maxUpdatedOn: 7 } },
    ];
    for (const preQuiescence of cases) {
      expect(parseCheckpoint(JSON.stringify({ ...stateFor(), preQuiescence }))).toMatchObject({
        present: false,
        reason: "malformed-fields",
      });
    }
  });

  it("survives a table literally named __proto__ in preQuiescence", () => {
    // Assigning that key onto an ordinary object hits the inherited setter and the
    // reading vanishes — a resumed run would then claim to have proved something it
    // never measured.
    const state = presentState(
      parseCheckpoint(
        `{"formatVersion":1,"sweepId":${JSON.stringify(SWEEP_ID)},"mode":"full","startedAt":${JSON.stringify(STARTED_AT)},"completedTables":[],"preQuiescence":{"__proto__":{"count":3,"maxUpdatedOn":null}}}`
      )
    );
    expect(Object.keys(state.preQuiescence ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

// ---------------------------------------------------------------------------
// Disk round trip
// ---------------------------------------------------------------------------

describe("checkpoint file I/O", () => {
  it("reports no-file when nothing has been written", async () => {
    const fs = new MemoryFs();
    const read = await readCheckpoint(fs, ROOT);
    expect(read).toMatchObject({ present: false, reason: "no-file" });
    expect(read.present ? "" : read.detail).toContain(CHECKPOINT_REL_PATH);
  });

  it("reports an unreadable checkpoint as its own reason instead of crashing the sync", async () => {
    const fs = new MemoryFs();
    fs.readFailure = new Error("EACCES: permission denied");
    const read = await readCheckpoint(fs, ROOT);
    expect(read).toMatchObject({ present: false, reason: "unreadable" });
    expect(read.present ? "" : read.detail).toContain("EACCES");
  });

  it("reports a non-Error read rejection without losing the value", async () => {
    const fs = new MemoryFs();
    // Some Node paths reject with a non-Error; stringifying it keeps the operator
    // message from becoming "[object Object]".
    fs.readFailure = "disk on fire" as unknown as Error;
    const read = await readCheckpoint(fs, ROOT);
    expect(read.present ? "" : read.detail).toContain("disk on fire");
  });

  it("writes canonical bytes atomically and reads them back", async () => {
    const fs = new MemoryFs();
    const state = stateFor({
      completedTables: ["incident"],
      inProgress: { table: "problem", lastSysId: sysIdFor(3) },
      preQuiescence: { incident: READING },
    });
    await writeCheckpoint(fs, ROOT, state);

    expect(fs.commitCount()).toBe(1);
    const text = fs.checkpointText();
    // §8: keys sorted at every level, two-space indent, one trailing newline.
    expect(text?.endsWith("\n")).toBe(true);
    expect(text?.startsWith('{\n  "completedTables"')).toBe(true);
    expect(presentState(await readCheckpoint(fs, ROOT))).toEqual(state);
  });

  it("clears the checkpoint, and clearing an absent one is not an error", async () => {
    const fs = new MemoryFs();
    await clearCheckpoint(fs, ROOT);
    await writeCheckpoint(fs, ROOT, stateFor());
    await clearCheckpoint(fs, ROOT);
    expect(await readCheckpoint(fs, ROOT)).toMatchObject({ present: false, reason: "no-file" });
  });

  it("reads a checkpoint written by WP-M7's narrower sink", async () => {
    // The compatibility claim in the module docblock, checked rather than asserted:
    // everything the writer's sink emits is a valid CheckpointState, it simply
    // carries no quiescence evidence — which is the truth about how it was made.
    const fs = new MemoryFs();
    await fs.place(
      `{\n  "completedTables": [\n    "incident"\n  ],\n  "formatVersion": 1,\n  "mode": "full",\n  "startedAt": ${JSON.stringify(STARTED_AT)},\n  "sweepId": ${JSON.stringify(SWEEP_ID)}\n}\n`
    );
    const state = presentState(await readCheckpoint(fs, ROOT));
    expect(state.completedTables).toEqual(["incident"]);
    expect(state.preQuiescence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkpointForPlan
// ---------------------------------------------------------------------------

describe("checkpointForPlan", () => {
  it("carries the plan's identity and no completed tables", () => {
    expect(checkpointForPlan(planFor(["incident"]), STARTED_AT)).toEqual({
      formatVersion: 1,
      sweepId: SWEEP_ID,
      mode: "full",
      startedAt: STARTED_AT,
      completedTables: [],
    });
  });

  it("carries the plan's quiescence readings across the interruption (D1)", () => {
    const plan = planFor(["incident"], { preQuiescence: { incident: READING } });
    expect(checkpointForPlan(plan, STARTED_AT).preQuiescence).toEqual({ incident: READING });
  });
});

// ---------------------------------------------------------------------------
// decideResume
// ---------------------------------------------------------------------------

describe("decideResume (§4.7, INV-5)", () => {
  it("refuses when there is no checkpoint, carrying the absence reason forward", () => {
    const decision = decideResume(
      { present: false, reason: "not-json", detail: "The checkpoint file is not valid JSON." },
      planFor(["incident"])
    );
    expect(decision).toMatchObject({ resume: false, refusal: "no-checkpoint" });
    expect(decision.detail).toContain("not valid JSON");
    expect(decision.completedTables).toEqual([]);
  });

  it("refuses a checkpoint from a different sweep and says what to do about it", () => {
    const decision = decideResume(
      { present: true, state: stateFor({ sweepId: "sweep-other", completedTables: ["incident"] }) },
      planFor(["incident"])
    );
    expect(decision).toMatchObject({ resume: false, refusal: "different-sweep" });
    expect(decision.detail).toContain(CHECKPOINT_REL_PATH);
    // A refusal grants nothing — a partial inheritance is the outcome it exists to
    // prevent.
    expect(decision.completedTables).toEqual([]);
    expect(decision.inProgress).toBeNull();
  });

  it("refuses across a mode change, because the evidence carries different authority", () => {
    const decision = decideResume(
      { present: true, state: stateFor({ mode: "incremental", completedTables: ["incident"] }) },
      planFor(["incident"])
    );
    expect(decision).toMatchObject({ resume: false, refusal: "mode-changed" });
    expect(decision.detail).toContain("INV-5");
  });

  it("resumes, splitting completed tables by name against the fresh plan", () => {
    // Matched by NAME: the catalog is re-read between runs, so a positional match
    // would resume into whichever table happened to land at the same index.
    const decision = decideResume(
      {
        present: true,
        state: stateFor({
          completedTables: ["sys_user", "incident", "gone_table"],
          inProgress: { table: "problem", lastSysId: sysIdFor(5) },
        }),
      },
      planFor(["incident", "problem", "sys_user"])
    );
    expect(decision.resume).toBe(true);
    expect(decision.refusal).toBeNull();
    expect(decision.completedTables).toEqual(["incident", "sys_user"]);
    expect(decision.vanishedTables).toEqual(["gone_table"]);
    expect(decision.inProgress).toEqual({ table: "problem", lastSysId: sysIdFor(5) });
    expect(decision.droppedInProgress).toBeNull();
    expect(decision.detail).toContain("problem resumes after");
  });

  it("drops an in-progress table the fresh plan no longer holds", () => {
    const decision = decideResume(
      {
        present: true,
        state: stateFor({ inProgress: { table: "u_removed", lastSysId: sysIdFor(1) } }),
      },
      planFor(["incident"])
    );
    expect(decision.resume).toBe(true);
    expect(decision.inProgress).toBeNull();
    expect(decision.droppedInProgress).toBe("u_removed");
  });

  it("lets completedTables win when it contradicts inProgress (INV-4)", () => {
    // A shard on disk is evidence the table's sweep finished; `inProgress` is only a
    // note that a row was written. Resuming mid-table into a finished table would
    // re-fetch it and flush a second shard set over the first.
    const decision = decideResume(
      {
        present: true,
        state: stateFor({
          completedTables: ["incident"],
          inProgress: { table: "incident", lastSysId: sysIdFor(2) },
        }),
      },
      planFor(["incident"])
    );
    expect(decision.inProgress).toBeNull();
    expect(decision.droppedInProgress).toBe("incident");
    expect(decision.completedTables).toEqual(["incident"]);
  });

  it("carries preQuiescence through a granted resume and omits it when there is none", () => {
    const withReadings = decideResume(
      { present: true, state: stateFor({ preQuiescence: { incident: READING } }) },
      planFor(["incident"])
    );
    expect(withReadings.preQuiescence).toEqual({ incident: READING });

    const without = decideResume({ present: true, state: stateFor() }, planFor(["incident"]));
    expect("preQuiescence" in without).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remainingTables
// ---------------------------------------------------------------------------

describe("remainingTables", () => {
  it("drops completed tables, keeps the interrupted one, and preserves plan order", () => {
    // The interrupted table is resumed, not skipped — and §4.5's order is a contract
    // because committed files are rendered from this sequence.
    const plan = planFor(["sys_script", "incident", "problem"]);
    const decision = decideResume(
      {
        present: true,
        state: stateFor({
          completedTables: ["sys_script"],
          inProgress: { table: "incident", lastSysId: sysIdFor(4) },
        }),
      },
      plan
    );
    expect(remainingTables(plan, decision).map((table) => table.entry.name)).toEqual([
      "incident",
      "problem",
    ]);
  });

  it("returns every table when the resume was refused", () => {
    const plan = planFor(["sys_script", "incident"]);
    const decision = decideResume(
      { present: false, reason: "no-file", detail: "none" },
      plan
    );
    expect(remainingTables(plan, decision)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SweepCheckpointSink
// ---------------------------------------------------------------------------

describe("SweepCheckpointSink", () => {
  function sinkFor(fs: WriterFs, state: CheckpointState, flushEvery?: number): SweepCheckpointSink {
    return new SweepCheckpointSink({
      root: ROOT,
      fs,
      state,
      ...(flushEvery === undefined ? {} : { flushEvery }),
    });
  }

  it("refuses a nonsensical flush cadence", () => {
    const fs = new MemoryFs();
    for (const flushEvery of [0, -1, 2.5]) {
      expect(() => sinkFor(fs, stateFor(), flushEvery)).toThrow(/positive integer/);
    }
  });

  it("commits after the configured number of records and not before", () => {
    // Measured at the rename, because a staged write a crash could discard is not
    // durable progress.
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor(), 3);
    return (async () => {
      await sink.recordWritten("incident", sysIdFor(1));
      await sink.recordWritten("incident", sysIdFor(2));
      expect(fs.commitCount()).toBe(0);
      await sink.recordWritten("incident", sysIdFor(3));
      expect(fs.commitCount()).toBe(1);
      expect(presentState(await readCheckpoint(fs, ROOT)).inProgress).toEqual({
        table: "incident",
        lastSysId: sysIdFor(3),
      });
    })();
  });

  it("defaults the cadence to the measured constant", async () => {
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor());
    for (let index = 1; index < CHECKPOINT_FLUSH_EVERY_DEFAULT; index += 1) {
      await sink.recordWritten("incident", sysIdFor(index));
    }
    expect(fs.commitCount()).toBe(0);
    await sink.recordWritten("incident", sysIdFor(CHECKPOINT_FLUSH_EVERY_DEFAULT));
    expect(fs.commitCount()).toBe(1);
  });

  it("commits a completed table immediately and clears the in-progress row", async () => {
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor(), 1000);
    await sink.recordWritten("incident", sysIdFor(1));
    expect(fs.commitCount()).toBe(0);
    await sink.tableCompleted("incident");
    expect(fs.commitCount()).toBe(1);
    const state = presentState(await readCheckpoint(fs, ROOT));
    expect(state.completedTables).toEqual(["incident"]);
    expect(state.inProgress).toBeUndefined();
  });

  it("keeps completedTables sorted and free of duplicates", async () => {
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor({ completedTables: ["problem"] }));
    await sink.tableCompleted("sys_user");
    await sink.tableCompleted("incident");
    await sink.tableCompleted("incident");
    expect(sink.snapshot().completedTables).toEqual(["incident", "problem", "sys_user"]);
  });

  it("does not rewrite the file when nothing changed", async () => {
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor());
    await sink.flush();
    expect(fs.commitCount()).toBe(0);
    await sink.recordWritten("incident", sysIdFor(1));
    await sink.flush();
    await sink.flush();
    expect(fs.commitCount()).toBe(1);
  });

  it("carries preQuiescence untouched through the sweep (D1)", async () => {
    // The whole reason WP-M8 owns a second sink: an interrupted --verify-quiescent
    // run has to still be able to prove quiescence after it resumes.
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor({ preQuiescence: { incident: READING } }), 1);
    await sink.recordWritten("incident", sysIdFor(1));
    await sink.tableCompleted("incident");
    expect(presentState(await readCheckpoint(fs, ROOT)).preQuiescence).toEqual({
      incident: READING,
    });
    expect(sink.snapshot().preQuiescence).toEqual({ incident: READING });
  });

  it("does not alias the state it was handed", async () => {
    const fs = new MemoryFs();
    const original = stateFor({ completedTables: ["problem"] });
    const sink = sinkFor(fs, original);
    await sink.tableCompleted("incident");
    expect(original.completedTables).toEqual(["problem"]);
    const snapshot = sink.snapshot();
    snapshot.completedTables.push("mutated");
    expect(sink.snapshot().completedTables).toEqual(["incident", "problem"]);
  });

  it("snapshots the in-progress row as a copy", async () => {
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor(), 1000);
    await sink.recordWritten("incident", sysIdFor(7));
    const snapshot = sink.snapshot();
    expect(snapshot.inProgress).toEqual({ table: "incident", lastSysId: sysIdFor(7) });
    snapshot.inProgress = { table: "other", lastSysId: sysIdFor(8) };
    expect(sink.snapshot().inProgress).toEqual({ table: "incident", lastSysId: sysIdFor(7) });
  });

  it("writes a file WP-M7's reader still understands", async () => {
    // Byte compatibility in the other direction, so a mixed-build tree does not have
    // two readers disagreeing about the same file.
    const fs = new MemoryFs();
    const sink = sinkFor(fs, stateFor({ preQuiescence: { incident: READING } }), 1);
    await sink.recordWritten("incident", sysIdFor(1));
    const state = await readWriterCheckpoint(fs, ROOT);
    expect(state).toMatchObject({
      formatVersion: 1,
      sweepId: SWEEP_ID,
      mode: "full",
      inProgress: { table: "incident", lastSysId: sysIdFor(1) },
    });
  });
});

// ---------------------------------------------------------------------------
// End to end — the interruption story §4.7 exists for
// ---------------------------------------------------------------------------

describe("interrupted sweep, resumed", () => {
  it("skips what was finished, resumes what was not, and keeps the quiescence proof", async () => {
    const fs = new MemoryFs();
    const plan = planFor(["incident", "problem", "sys_user"], {
      mode: "incremental",
      preQuiescence: { incident: READING },
    });

    const sink = new SweepCheckpointSink({
      root: ROOT,
      fs,
      state: checkpointForPlan(plan, STARTED_AT),
      flushEvery: 1,
    });
    await sink.tableCompleted("incident");
    await sink.recordWritten("problem", sysIdFor(11));
    // The process dies here; everything below is a fresh run reading the disk.

    const decision = decideResume(await readCheckpoint(fs, ROOT), plan);
    expect(decision.resume).toBe(true);
    expect(decision.preQuiescence).toEqual({ incident: READING });
    expect(remainingTables(plan, decision).map((table) => table.entry.name)).toEqual([
      "problem",
      "sys_user",
    ]);
    expect(decision.inProgress).toEqual({ table: "problem", lastSysId: sysIdFor(11) });
  });
});
