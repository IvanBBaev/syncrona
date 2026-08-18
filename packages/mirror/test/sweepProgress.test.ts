// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The checkpoint half of INV-4 — WP-M7, §4.7, §5.8.
 *
 * INV-4 forbids flushing shards before a table's sweep completes, which means that
 * for the whole duration of a 400 000-row table the only durable record of progress
 * is this file. Two failure modes follow from that, and everything below is aimed at
 * one or the other:
 *
 *  - *Losing the progress.* If the sink never writes, or writes too rarely, a crash
 *    costs a whole table of API calls. The cadence tests measure when the bytes
 *    actually reach disk, not what the class says it intends to do.
 *  - *Believing the wrong progress.* A checkpoint whose `completedTables` says a
 *    table is finished lets a resume skip it entirely — so a stale `inProgress`, a
 *    half-parsed `completedTables`, or a checkpoint from another format version read
 *    as if it were this one turns a partial tree into one that reports itself
 *    complete. Every parser test below is about refusing to half-believe a file.
 *
 * Progress is observed through the `WriterFs` seam, and specifically through the
 * `rename` calls, because that is where `atomicWriteFile` commits: counting
 * `recordWritten` calls would measure the caller, and counting `writeFile` calls
 * would count staging writes that a crash could still throw away. A commit is a
 * rename onto the checkpoint path, and nothing else.
 *
 * The in-memory filesystem refuses to create a file whose parent directory was never
 * made, the way `open(2)` does — so a flush that forgot its `makeDir` fails here
 * rather than passing against a forgiving fake.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  CHECKPOINT_FLUSH_EVERY_DEFAULT,
  CHECKPOINT_REL_PATH,
  CheckpointProgressSink,
  nullProgressSink,
  readWriterCheckpoint,
  type WriterCheckpointState,
} from "../src/write/sweepProgress";
import { nodeWriterFs, toNativePath, type WriterDirEntry, type WriterFs } from "../src/write/fs";

const ROOT = `${sep}mirror-root`;
const SWEEP_ID = "sweep-7f3a";
const STARTED_AT = "2026-08-18T09:00:00.000Z";
const TABLE = "sys_script_include";

/** The checkpoint's native path, spelled out from §3 rather than re-derived. */
const CHECKPOINT_NATIVE = [ROOT, ".mirror", "state", "checkpoint.json"].join(sep);
const CHECKPOINT_DIR_NATIVE = [ROOT, ".mirror", "state"].join(sep);

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
}

function makeSink(fs: WriterFs, flushEvery?: number): CheckpointProgressSink {
  return new CheckpointProgressSink({
    root: ROOT,
    sweepId: SWEEP_ID,
    mode: "full",
    startedAt: STARTED_AT,
    fs,
    ...(flushEvery === undefined ? {} : { flushEvery }),
  });
}

/** A sys_id-shaped resume point, distinct per index. */
function sysIdFor(index: number): string {
  return index.toString(16).padStart(32, "0");
}

/** Put a handwritten checkpoint on disk, bypassing the sink entirely. */
async function seedCheckpoint(fs: MemoryFs, text: string): Promise<void> {
  await fs.makeDir(CHECKPOINT_DIR_NATIVE);
  await fs.writeFile(CHECKPOINT_NATIVE, new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Flush cadence
// ---------------------------------------------------------------------------

describe("CheckpointProgressSink: when progress reaches disk", () => {
  it("writes nothing until the cadence comes round, then writes the current position", async () => {
    // The first half is what stops a flush-per-record regression: three records at a
    // cadence of four must leave NO file at all, and `readWriterCheckpoint` reading
    // `null` is the same answer a resume would get.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 4);

    for (let index = 0; index < 3; index += 1) {
      await sink.recordWritten(TABLE, sysIdFor(index));
    }
    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();

    await sink.recordWritten(TABLE, sysIdFor(3));
    const persisted = await readWriterCheckpoint(fs, ROOT);
    // The position written is the LAST record, not the one that opened the window —
    // a resume from the window's first sys_id would re-fetch rows it already had and,
    // worse, would suggest the checkpoint lags by a whole flush interval.
    expect(persisted?.inProgress).toEqual({ table: TABLE, lastSysId: sysIdFor(3) });
  });

  it("commits exactly once per window at the default cadence", async () => {
    // Both regressions this catches are silent. Flushing per record shows up as 750
    // commits instead of 3; never flushing shows up as an empty list. The expected
    // positions are derived from the observed commit points, so the assertion is
    // about behaviour rather than about the constant restating itself.
    const fs = new MemoryFs();
    const sink = makeSink(fs);
    const total = CHECKPOINT_FLUSH_EVERY_DEFAULT * 3;

    const committedAfter: number[] = [];
    let seen = 0;
    for (let index = 0; index < total; index += 1) {
      const before = fs.commitCount();
      await sink.recordWritten(TABLE, sysIdFor(index));
      if (fs.commitCount() > before) {
        committedAfter.push(index + 1);
      }
      seen += 1;
    }

    expect(seen).toBe(total);
    expect(committedAfter).toEqual([
      CHECKPOINT_FLUSH_EVERY_DEFAULT,
      CHECKPOINT_FLUSH_EVERY_DEFAULT * 2,
      CHECKPOINT_FLUSH_EVERY_DEFAULT * 3,
    ]);
  });

  it("does not commit for a batch of fifty records", async () => {
    // Fifty is this test's own number, chosen independently of the default. It fails
    // the day someone drops the default to a handful "to be safe" and quietly puts a
    // write-and-rename in the inner loop of every sweep.
    const fs = new MemoryFs();
    const sink = makeSink(fs);
    for (let index = 0; index < 50; index += 1) {
      await sink.recordWritten(TABLE, sysIdFor(index));
    }
    expect(fs.commitCount()).toBe(0);
  });

  it("persists the tail on an explicit flush", async () => {
    // The sweep ends between cadence points far more often than on one. Without this
    // the last partial window is always lost — which is the case a resume needs most,
    // because it is the case a crash produces.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 100);
    await sink.recordWritten(TABLE, sysIdFor(41));
    expect(fs.commitCount()).toBe(0);

    await sink.flush();
    expect((await readWriterCheckpoint(fs, ROOT))?.inProgress?.lastSysId).toBe(
      sysIdFor(41)
    );
  });

  it("does not rewrite the file when nothing changed since the last flush", async () => {
    // `flush()` is called on every table boundary and at the end of the sweep. Making
    // each call rewrite an identical file would put a needless write-and-rename on the
    // path of every table, and would touch the file's mtime for no reason.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(1));
    const after = fs.commitCount();
    expect(after).toBe(1);

    await sink.flush();
    await sink.flush();
    expect(fs.commitCount()).toBe(after);
  });

  it("flushes a completed table immediately, whatever the cadence says", async () => {
    // `completedTables` is the entry that authorises a resume to SKIP the table, and
    // it is only true because the shards are already on disk (INV-4). Deferring it to
    // the next cadence point would leave a window in which the shards exist and the
    // checkpoint denies it — a resume that re-sweeps a finished table.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1000);
    await sink.recordWritten(TABLE, sysIdFor(2));
    expect(fs.commitCount()).toBe(0);

    await sink.tableCompleted(TABLE);
    expect(fs.commitCount()).toBe(1);
    expect((await readWriterCheckpoint(fs, ROOT))?.completedTables).toEqual([TABLE]);
  });

  it("clears the in-progress position when the table completes", async () => {
    // A stale `inProgress` would tell a resume to restart mid-table in a table that
    // `completedTables` says is finished — the same file contradicting itself, and
    // the reader has no way to know which clause to believe.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 2);
    await sink.recordWritten(TABLE, sysIdFor(9));
    await sink.tableCompleted(TABLE);

    const persisted = await readWriterCheckpoint(fs, ROOT);
    expect(persisted?.inProgress).toBeUndefined();
    expect(sink.snapshot().inProgress).toBeUndefined();
  });

  it("keeps completedTables sorted and free of duplicates", async () => {
    // Completion order is the planner's scheduling order — not a property anyone
    // reading the checkpoint should have to reason about — and a table completed
    // twice by a reconcile pass must not appear twice.
    const fs = new MemoryFs();
    const sink = makeSink(fs);
    for (const table of ["sys_ui_policy", "sys_script_include", "sys_ui_policy"]) {
      await sink.tableCompleted(table);
    }
    expect((await readWriterCheckpoint(fs, ROOT))?.completedTables).toEqual([
      "sys_script_include",
      "sys_ui_policy",
    ]);
  });

  it("creates .mirror/state rather than assuming it exists", async () => {
    // The directory is gitignored, so a fresh clone of a mirror repo does not have
    // it. Assuming it would make the first sweep after every clone lose its progress
    // to an ENOENT.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(0));

    expect(fs.calls).toContain(`makeDir ${CHECKPOINT_DIR_NATIVE}`);
    expect(fs.checkpointText()).not.toBeNull();
  });

  it("commits through a staging file and a rename, never straight onto the path (R4)", async () => {
    // The file the crash-recovery story depends on may not itself have a
    // crash-corruption window: a half-written checkpoint is unparseable, an
    // unparseable checkpoint is treated as absent, and an absent checkpoint restarts
    // the interrupted table from row one.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(5));

    expect(fs.calls).not.toContain(`writeFile ${CHECKPOINT_NATIVE}`);
    const renames = fs.calls.filter((call) => call.startsWith("rename "));
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatch(
      new RegExp(`^rename .*\\.mirror-tmp-[^ ]+ -> ${escapeForRegExp(CHECKPOINT_NATIVE)}$`)
    );
  });

  it("writes canonical bytes: sorted keys, one trailing newline (§8)", async () => {
    // The checkpoint sits in the user's tree, and §8's rules are what make every file
    // the mirror writes byte-stable. The expected key order is computed here by
    // sorting, so this fails if the renderer ever falls back to insertion order.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(3));

    const text = fs.checkpointText() ?? "";
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("}\n\n")).toBe(false);
    expect(text).not.toContain("\r");

    const emitted = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((match) => match[1]);
    expect(emitted).toEqual([...emitted].sort());
    expect(emitted).toEqual([
      "completedTables",
      "formatVersion",
      "inProgress",
      "mode",
      "startedAt",
      "sweepId",
    ]);
  });

  it("hands out a snapshot the caller cannot use to edit the sink's state", async () => {
    // The run report keeps a snapshot around while the sweep continues. If the arrays
    // were shared, a report that sorted or trimmed its copy would silently rewrite
    // what the next flush persists.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(1));
    await sink.tableCompleted(TABLE);

    const snapshot = sink.snapshot();
    snapshot.completedTables.push("injected");
    snapshot.sweepId = "tampered";

    await sink.recordWritten("sys_ui_policy", sysIdFor(2));
    const persisted = await readWriterCheckpoint(fs, ROOT);
    expect(persisted?.completedTables).toEqual([TABLE]);
    expect(persisted?.sweepId).toBe(SWEEP_ID);
  });

  it("rejects a cadence that is not a positive integer", async () => {
    // `flushEvery: 0` would make `sinceFlush >= flushEvery` true before any record was
    // written and turn the sweep into an unbounded rewrite loop of one file; a
    // fractional value would never compare equal and could silently never flush.
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => makeSink(new MemoryFs(), bad)).toThrow(/positive integer/);
    }
    // Control: the boundary value is accepted, so the guard is rejecting the right
    // side of the line.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 1);
    await sink.recordWritten(TABLE, sysIdFor(0));
    expect(fs.commitCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

describe("readWriterCheckpoint: what a resume is allowed to believe", () => {
  it("round-trips a checkpoint exactly", async () => {
    // Compared against the sink's own snapshot rather than a hand-written literal:
    // the point is that the file loses nothing on the way through the renderer and
    // the parser, not that both agree with a third copy in this test.
    const fs = new MemoryFs();
    const sink = makeSink(fs, 2);
    await sink.tableCompleted("sys_ui_policy");
    await sink.recordWritten(TABLE, sysIdFor(88));
    await sink.flush();

    expect(await readWriterCheckpoint(fs, ROOT)).toEqual(sink.snapshot());
  });

  it("answers null when there is no checkpoint", async () => {
    const fs = new MemoryFs();
    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
  });

  it("answers null for a corrupt file and leaves it on disk", async () => {
    // Collapsing corrupt to `null` is safe in this direction and only this one: no
    // resume means a full re-sweep, which costs API calls and never skips a table.
    // Leaving the bytes in place is what keeps "absent" and "corrupt" distinguishable
    // at all — a caller that needs to tell them apart can still ask the filesystem,
    // and a checkpoint deleted on read would destroy the only evidence of the crash.
    const fs = new MemoryFs();
    await seedCheckpoint(fs, '{"formatVersion":1,"sweepId":"a",');

    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
    expect(fs.checkpointText()).toBe('{"formatVersion":1,"sweepId":"a",');
  });

  it("answers null for a checkpoint written in another format version", async () => {
    // INV-8's whole purpose. A WP-M8 checkpoint carries `preQuiescence`, and reading
    // it with this parser would silently drop that field and resume on a state whose
    // author assumed it was being honoured.
    const fs = new MemoryFs();
    await seedCheckpoint(
      fs,
      `${JSON.stringify({
        formatVersion: 2,
        sweepId: SWEEP_ID,
        mode: "full",
        startedAt: STARTED_AT,
        completedTables: [TABLE],
      })}\n`
    );
    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
  });

  it("never half-believes a completedTables list", async () => {
    // The dangerous leniency. Salvaging `["a"]` out of `["a", 7]` would hand a resume
    // a shorter list than the file meant to express — and every table missing from
    // that list gets re-swept, while every table wrongly IN it gets skipped. Refusing
    // the whole file is the only answer that cannot skip anything.
    const fs = new MemoryFs();
    await seedCheckpoint(
      fs,
      `${JSON.stringify({
        formatVersion: 1,
        sweepId: SWEEP_ID,
        mode: "full",
        startedAt: STARTED_AT,
        completedTables: ["sys_script_include", 7],
      })}\n`
    );
    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
  });

  it("rejects a checkpoint whose sweep mode it does not recognise", async () => {
    // Mode decides what a resume DOES — a `full` resume carries INV-5 deletion
    // authority that an `incremental` one does not. An unknown mode passed through as
    // a string would reach that branch as neither.
    const fs = new MemoryFs();
    await seedCheckpoint(
      fs,
      `${JSON.stringify({
        formatVersion: 1,
        sweepId: SWEEP_ID,
        mode: "quick",
        startedAt: STARTED_AT,
        completedTables: [],
      })}\n`
    );
    expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
  });

  it("rejects a payload that is not an object at all", async () => {
    const fs = new MemoryFs();
    for (const payload of ["null", "[1,2,3]", '"a string"', "42"]) {
      await seedCheckpoint(fs, payload);
      expect(await readWriterCheckpoint(fs, ROOT)).toBeNull();
    }
  });

  it("drops a malformed in-progress marker but keeps the rest of the state", async () => {
    // The asymmetry is deliberate and worth pinning: `completedTables` grants
    // permission to SKIP work, so a doubtful one voids the file, while `inProgress`
    // only saves work, so a doubtful one costs a table restart and nothing more.
    // Voiding the whole checkpoint over it would throw away a valid completedTables
    // list and re-sweep every table the run had already finished.
    const fs = new MemoryFs();
    const base = {
      formatVersion: 1,
      sweepId: SWEEP_ID,
      mode: "incremental",
      startedAt: STARTED_AT,
      completedTables: ["sys_ui_policy"],
    };
    for (const broken of [
      { table: TABLE },
      { table: 7, lastSysId: sysIdFor(1) },
      "not an object",
      null,
    ]) {
      await seedCheckpoint(fs, `${JSON.stringify({ ...base, inProgress: broken })}\n`);
      const parsed = await readWriterCheckpoint(fs, ROOT);
      expect(parsed?.completedTables).toEqual(["sys_ui_policy"]);
      expect(parsed?.mode).toBe("incremental");
      expect(parsed?.inProgress).toBeUndefined();
    }

    // Control: the same envelope with a well-formed marker keeps it, so the drops
    // above are caused by the malformation and not by the envelope.
    await seedCheckpoint(
      fs,
      `${JSON.stringify({
        ...base,
        inProgress: { table: TABLE, lastSysId: sysIdFor(4) },
      })}\n`
    );
    expect((await readWriterCheckpoint(fs, ROOT))?.inProgress).toEqual({
      table: TABLE,
      lastSysId: sysIdFor(4),
    });
  });

  it("reads the checkpoint from the path §3 names", async () => {
    // Written as a literal: every existing mirror on disk already keeps its state
    // here, and `.gitignore` in the generated repo matches this path. Moving it is a
    // migration, not a refactor.
    expect(CHECKPOINT_REL_PATH).toBe(".mirror/state/checkpoint.json");
    expect(toNativePath(ROOT, CHECKPOINT_REL_PATH)).toBe(CHECKPOINT_NATIVE);
  });
});

// ---------------------------------------------------------------------------
// The null sink
// ---------------------------------------------------------------------------

describe("nullProgressSink", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "syncrona-progress-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("writes nothing anywhere when a whole sweep is reported through it", async () => {
    // Run against a REAL directory, because "inert" is a claim about the filesystem
    // and the sink takes no seam through which a fake could observe it. If the
    // default sink ever grew a write — to a hard-coded path, to the repo root, to
    // anywhere — this directory would stop being empty.
    const sink = nullProgressSink();
    for (let index = 0; index < 5; index += 1) {
      await expect(sink.recordWritten(TABLE, sysIdFor(index))).resolves.toBeUndefined();
    }
    await expect(sink.tableCompleted(TABLE)).resolves.toBeUndefined();
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(await readdir(workspace)).toEqual([]);
    expect(await readWriterCheckpoint(nodeWriterFs(), workspace)).toBeNull();
  });

  it("keeps two sinks independent of each other", async () => {
    // Returning a shared singleton would be an easy "optimisation" and would make the
    // discarding behaviour depend on nobody ever giving the object state.
    const first = nullProgressSink();
    const second = nullProgressSink();
    expect(first).not.toBe(second);
  });
});

/** Escape a native path for embedding in a RegExp — Windows separators included. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile-time check that the exported state type still says what §4.7 says. */
const SHAPE_CHECK: WriterCheckpointState = {
  formatVersion: 1,
  sweepId: SWEEP_ID,
  mode: "reconcile",
  startedAt: STARTED_AT,
  completedTables: [],
};
void SHAPE_CHECK;
