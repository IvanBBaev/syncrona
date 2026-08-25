// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The run counter — §5.4's cadence position on disk (INV-5, INV-8, R3, R4).
 *
 * The counter is the smallest state file the mirror keeps and the one with the
 * least obvious failure mode: nothing crashes when it is wrong. A count that is
 * silently reset, silently frozen or silently misread produces runs that all
 * succeed, all report `incremental`, and all refuse every deletion — which is the
 * exact defect this module was added to remove, reintroduced. So the tests below
 * are organised around the four ways the number can lie:
 *
 *  - *Half-believing a file.* A counter whose `formatVersion` parsed but whose
 *    `completedSyncs` did not would resume a cadence from a value nobody wrote.
 *    Validation is all-or-nothing, exactly as the checkpoint's is, and the parser
 *    tests assert the "or-nothing" half one damaged field at a time.
 *  - *Accepting a number that cannot count.* A float, a negative or a value past
 *    2^53 would make `ordinal % everyN` either meaningless or never zero — a
 *    cadence that appears to advance and never fires.
 *  - *Advancing from the wrong base.* {@link advanceSyncCounter} adds one to the
 *    value that was READ, never to the ordinal the run used, so an operator's
 *    `syncOrdinal` override cannot rewrite the mirror's history.
 *  - *Degrading quietly.* Every absence except `no-file` means the cadence just
 *    restarted, which R3 forbids doing in silence; {@link syncCounterWarning} is
 *    that sentence, and it must name the escape hatch rather than merely complain.
 *
 * The in-memory filesystem is `statusFixtures`' recording fake, so the write path
 * is asserted through the call log: a counter written by anything other than
 * `makeDir` + staged write + rename would show up here as the missing rename.
 */
import { canonicalJsonBytes } from "../src/serialize/serializer";
import {
  advanceSyncCounter,
  nextSyncOrdinal,
  parseSyncCounter,
  readSyncCounter,
  syncCounterWarning,
  SYNC_COUNTER_REL_PATH,
  type SyncCounterRead,
} from "../src/syncCounter";
import type { WriterFs } from "../src/write/fs";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
import {
  MemoryFs,
  ROOT,
  mutatingCalls,
  relToNative,
  resetCalls,
  seedFile,
} from "./statusFixtures";

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** Put counter TEXT on disk, parent directory and all. */
const seedCounter = async (fs: MemoryFs, text: string): Promise<void> => {
  await seedFile(fs, SYNC_COUNTER_REL_PATH, Buffer.from(text, "utf8"));
};

/** The bytes an honest count of `n` completed runs has on disk. */
const counterText = (completedSyncs: number): string =>
  textOf(canonicalJsonBytes({ formatVersion: 1, completedSyncs }));

/**
 * A filesystem whose `readFile` always rejects — the stale-owner / device-error
 * case, which is the only way to reach the `unreadable` arm through the seam.
 */
const refusingFs = (failure: unknown): WriterFs => {
  const fs = new MemoryFs();
  const refuse = (): Promise<never> => Promise.reject(failure);
  return {
    makeDir: (dir) => fs.makeDir(dir),
    writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
    rename: (from, to) => fs.rename(from, to),
    readDir: (dir) => fs.readDir(dir),
    removeRecursive: (target) => fs.removeRecursive(target),
    readFile: refuse,
  };
};

const present = (completedSyncs: number): SyncCounterRead => ({
  present: true,
  state: { formatVersion: 1, completedSyncs },
});

// ---------------------------------------------------------------------------
// parseSyncCounter
// ---------------------------------------------------------------------------

describe("parseSyncCounter (§5.4)", () => {
  it("reads a well-formed count", () => {
    expect(parseSyncCounter(counterText(9))).toEqual(present(9));
  });

  it("reads a zero, which is a real answer and not an absence", () => {
    // A tree whose only completed run was rolled back by hand still has a file,
    // and "zero completed runs" has to survive the round trip as a PRESENT count
    // — otherwise the falsy value would read as damage and produce a warning.
    expect(parseSyncCounter(counterText(0))).toEqual(present(0));
  });

  it("reports a truncated file as not-json rather than throwing", () => {
    const read = parseSyncCounter('{"formatVersion":1,"completedSyncs":');
    expect(read).toMatchObject({ present: false, reason: "not-json" });
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["[]", "null", "7", '"nine"']) {
      expect(parseSyncCounter(text)).toMatchObject({
        present: false,
        reason: "not-an-object",
      });
    }
  });

  it("refuses a foreign format version and names it (INV-8)", () => {
    const read = parseSyncCounter('{"formatVersion":2,"completedSyncs":4}');
    expect(read).toMatchObject({ present: false, reason: "foreign-format-version" });
    expect(read.present ? "" : read.detail).toContain("2");
  });

  it("refuses every completedSyncs that is not a count of finished runs", () => {
    const rejected = [
      '{"formatVersion":1}',
      '{"formatVersion":1,"completedSyncs":"4"}',
      '{"formatVersion":1,"completedSyncs":null}',
      // A float and a negative both survive `typeof === "number"` and both break
      // the modulo: 4.5 % 10 is never 0, and -1 % 10 is -1.
      '{"formatVersion":1,"completedSyncs":4.5}',
      '{"formatVersion":1,"completedSyncs":-1}',
      // Past 2^53 every increment is a no-op, so the cadence freezes forever.
      '{"formatVersion":1,"completedSyncs":9007199254740992}',
      '{"formatVersion":1,"completedSyncs":1e999}',
    ];
    for (const text of rejected) {
      expect(parseSyncCounter(text)).toMatchObject({
        present: false,
        reason: "malformed-fields",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// readSyncCounter
// ---------------------------------------------------------------------------

describe("readSyncCounter", () => {
  it("reports no-file on a mirror that has never completed a sync", async () => {
    const read = await readSyncCounter(new MemoryFs(), ROOT);
    expect(read).toMatchObject({ present: false, reason: "no-file" });
    expect(read.present ? "" : read.detail).toContain(SYNC_COUNTER_REL_PATH);
  });

  it("reports an unreadable counter as its own reason instead of failing the sync", async () => {
    // The file is machine-local and regenerable; refusing to mirror an instance
    // because a bookkeeping file has the wrong owner would turn a cosmetic
    // problem into an outage. The cost of degrading is a deferred reconcile, and
    // the detail is what keeps that from being invisible.
    const read = await readSyncCounter(refusingFs(new Error("EACCES: denied")), ROOT);
    expect(read).toMatchObject({ present: false, reason: "unreadable" });
    expect(read.present ? "" : read.detail).toContain("EACCES: denied");
  });

  it("reports a non-Error read rejection without losing the value", async () => {
    const read = await readSyncCounter(refusingFs("disk on fire"), ROOT);
    expect(read).toMatchObject({ present: false, reason: "unreadable" });
    expect(read.present ? "" : read.detail).toContain("disk on fire");
  });

  it("round-trips what advanceSyncCounter wrote", async () => {
    const fs = new MemoryFs();
    await seedCounter(fs, counterText(3));
    expect(await readSyncCounter(fs, ROOT)).toEqual(present(3));
  });

  it("carries a damaged file's reason through the reader", async () => {
    const fs = new MemoryFs();
    await seedCounter(fs, "not json at all");
    expect(await readSyncCounter(fs, ROOT)).toMatchObject({
      present: false,
      reason: "not-json",
    });
  });
});

// ---------------------------------------------------------------------------
// nextSyncOrdinal
// ---------------------------------------------------------------------------

describe("nextSyncOrdinal", () => {
  it("counts the run in progress, so the Nth run is the one that reconciles", () => {
    expect(nextSyncOrdinal(present(9))).toBe(10);
  });

  it("starts a fresh mirror at 1", () => {
    expect(nextSyncOrdinal({ present: false, reason: "no-file", detail: "" })).toBe(1);
  });

  it("restarts at 1 for every absence, damaged or not", () => {
    // Deliberate: a count that cannot be trusted is treated as no count at all,
    // never as "keep the old position". The alternative — guessing — would let a
    // corrupt file push a reconcile arbitrarily far out with nobody able to say
    // when. Restarting is at worst one extra cycle of waiting, and it is LOUD
    // (see `syncCounterWarning`).
    for (const reason of ["unreadable", "not-json", "malformed-fields"] as const) {
      expect(nextSyncOrdinal({ present: false, reason, detail: "" })).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// advanceSyncCounter
// ---------------------------------------------------------------------------

describe("advanceSyncCounter (R4)", () => {
  it("records the first completed run of a fresh mirror as 1", async () => {
    const fs = new MemoryFs();
    const state = await advanceSyncCounter(fs, ROOT, await readSyncCounter(fs, ROOT));

    expect(state).toEqual({ formatVersion: 1, completedSyncs: 1 });
    expect(await readSyncCounter(fs, ROOT)).toEqual(present(1));
  });

  it("advances from the value that was READ, not from anything else", async () => {
    // The distinction is what makes `RunMirrorCommandOptions.syncOrdinal` an
    // override of THIS run rather than an edit of the mirror's history: a run
    // told to plan as sync 40 still leaves the count at 4.
    const fs = new MemoryFs();
    await seedCounter(fs, counterText(3));

    const state = await advanceSyncCounter(fs, ROOT, await readSyncCounter(fs, ROOT));
    expect(state.completedSyncs).toBe(4);
  });

  it("treats a damaged count as zero and writes the honest 1 over it", async () => {
    const fs = new MemoryFs();
    await seedCounter(fs, "{ truncated");

    const state = await advanceSyncCounter(fs, ROOT, await readSyncCounter(fs, ROOT));
    expect(state.completedSyncs).toBe(1);
    expect(await readSyncCounter(fs, ROOT)).toEqual(present(1));
  });

  it("writes canonical bytes atomically into the state directory", async () => {
    const fs = new MemoryFs();
    resetCalls(fs);
    await advanceSyncCounter(fs, ROOT, { present: false, reason: "no-file", detail: "" });

    // R4: the bytes arrive by renaming a staging sibling into place, never by a
    // direct write onto the live path.
    expect(
      mutatingCalls(fs).some(
        (line) =>
          line.startsWith("rename ") &&
          line.includes(".mirror-tmp-") &&
          line.endsWith(relToNative(SYNC_COUNTER_REL_PATH))
      )
    ).toBe(true);
    // Canonical rendering, like every other file the mirror writes — never
    // `JSON.stringify`, so two builds produce the same bytes.
    expect(fs.files.get(relToNative(SYNC_COUNTER_REL_PATH))).toEqual(
      canonicalJsonBytes({ formatVersion: 1, completedSyncs: 1 })
    );
  });

  it("lands beside the checkpoint, in the directory the ignore file hides", async () => {
    // Not decoration: the counter is only invisible to git because `.mirror/`
    // is, and a counter that drifted out of that directory would be committed on
    // the next `git add -A` — one machine's cadence becoming everyone's.
    const stateDir = CHECKPOINT_REL_PATH.slice(0, CHECKPOINT_REL_PATH.lastIndexOf("/"));
    expect(SYNC_COUNTER_REL_PATH.startsWith(`${stateDir}/`)).toBe(true);
  });

  it("keeps advancing one at a time across many runs", async () => {
    const fs = new MemoryFs();
    for (let run = 1; run <= 5; run += 1) {
      const read = await readSyncCounter(fs, ROOT);
      expect(nextSyncOrdinal(read)).toBe(run);
      await advanceSyncCounter(fs, ROOT, read);
    }
    expect(await readSyncCounter(fs, ROOT)).toEqual(present(5));
  });
});

// ---------------------------------------------------------------------------
// syncCounterWarning (R3)
// ---------------------------------------------------------------------------

describe("syncCounterWarning", () => {
  it("says nothing about a count it could read", () => {
    expect(syncCounterWarning(present(4))).toBeNull();
  });

  it("says nothing about a mirror's first sync", () => {
    // `no-file` is the ordinary case, not an incident: every mirror has one.
    expect(
      syncCounterWarning({ present: false, reason: "no-file", detail: "no counter" })
    ).toBeNull();
  });

  it("speaks up for every damaged count, carrying the reason and the remedy", () => {
    for (const reason of [
      "unreadable",
      "not-json",
      "not-an-object",
      "foreign-format-version",
      "malformed-fields",
    ] as const) {
      const warning = syncCounterWarning({
        present: false,
        reason,
        detail: `detail for ${reason}.`,
      });
      // The reason survives — a warning that only said "cadence restarted" would
      // leave the operator unable to tell a permissions problem from a build
      // mismatch.
      expect(warning).toContain(`detail for ${reason}.`);
      // And the sentence names the escape hatch, because the consequence of the
      // restart is a reconcile that is now up to N runs further away.
      expect(warning).toContain("--reconcile");
    }
  });
});
