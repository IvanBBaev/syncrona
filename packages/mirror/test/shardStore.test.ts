// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The shard set on disk — §4.3, INV-1, INV-4, INV-6 (WP-M7).
 *
 * The store is the half of §4.3 that touches a filesystem, and every question it
 * answers is a question about the mirror's *baseline*: which records the tree
 * already claims, at which fan-out, and whether a completed sweep vouched for them.
 * Getting any of those wrong is not a cosmetic failure — a baseline that reads as
 * empty when it is merely unreadable authorises deleting every record it described
 * (INV-5), and a fan-out that changes by accident rewrites every path in the table.
 * So the tests below are organised around those failure modes rather than around
 * the function list.
 *
 * The seam is exercised with an in-memory `WriterFs`, not a temp directory, and the
 * fake is deliberately *unhelpful* in two ways so that it cannot flatter the code
 * under test:
 *
 *  - `writeFile` refuses to create a file whose parent directory was never made, the
 *    way `open(2)` does. A `writeShardSet` that dropped its `makeDir` would fail here
 *    rather than quietly succeed against a forgiving fake.
 *  - `readDir` returns its entries in DESCENDING order. Nothing in these tests can
 *    therefore pass because a listing happened to arrive sorted; every sorted result
 *    asserted below was sorted by the production code.
 *
 * Atomicity itself is not re-tested here — `atomicWrite.test.ts` owns R4 against a
 * real `rename(2)`, and repeating it against a fake would prove only that the fake
 * agrees with itself.
 */
import { createHash } from "node:crypto";
import { sep } from "node:path";

import type { RecordEntry } from "../src/contracts";
import {
  MirrorPathRejection,
  ShardManifestCorrupt,
} from "../src/shards/shardLayout";
import {
  listScopesWithShards,
  loadShardSet,
  ShardFanoutConflict,
  writeShardSet,
} from "../src/shards/shardStore";
import { STAGING_PREFIX } from "../src/write/atomicWrite";
import { toNativePath, type WriterDirEntry, type WriterFs } from "../src/write/fs";

/** Virtual repository root; every path in this file hangs off it. */
const ROOT = `${sep}mirror-root`;
const SCOPE = "global";
const TABLE = "sys_script_include";
const SWEEP = "sweep-2026-08-18T00:00:00Z";

/** The hex alphabet, spelled out here so the expected file names are the test's own. */
const HEX = "0123456789abcdef";

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

class MemoryFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryFsError";
  }
}

function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

/**
 * A filesystem that lives in two Maps and keeps a log of everything asked of it.
 *
 * The log is what makes "no shard file was written" and "the hostile key never
 * reached a filesystem call" assertable rather than inferred.
 */
class MemoryFs implements WriterFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly calls: string[] = [];

  async makeDir(dir: string): Promise<void> {
    this.calls.push(`makeDir ${dir}`);
    this.addDir(dir);
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`writeFile ${filePath}`);
    if (!this.dirs.has(parentOf(filePath))) {
      throw new MemoryFsError(`ENOENT: no directory holds ${filePath}`);
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      // The store only ever renames the staging file `atomicWriteFile` just made.
      // Anything else is a change of behaviour that should stop the test, loudly.
      throw new MemoryFsError(`ENOENT: nothing to rename at ${from}`);
    }
    if (!this.dirs.has(parentOf(to))) {
      throw new MemoryFsError(`ENOENT: no directory holds ${to}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    this.calls.push(`readFile ${filePath}`);
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    this.calls.push(`readDir ${dir}`);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const entries: WriterDirEntry[] = [];
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        entries.push({ name: filePath.slice(dir.length + sep.length), isDirectory: false });
      }
    }
    for (const child of this.dirs) {
      if (child !== dir && parentOf(child) === dir) {
        entries.push({ name: child.slice(dir.length + sep.length), isDirectory: true });
      }
    }
    // Descending, on purpose — see the module docblock.
    return entries.sort((left, right) => (left.name < right.name ? 1 : -1));
  }

  async removeRecursive(target: string): Promise<void> {
    this.calls.push(`removeRecursive ${target}`);
    this.files.delete(target);
    const prefix = `${target}${sep}`;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
      }
    }
  }

  private addDir(dir: string): void {
    const parts = dir.split(sep);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = parts.slice(0, depth).join(sep);
      if (candidate !== "") {
        this.dirs.add(candidate);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A sys_id with a chosen hex prefix and a deterministic, seed-derived tail. */
function sysIdWith(prefix: string, seed: string): string {
  const tail = createHash("sha256").update(seed).digest("hex");
  return `${prefix}${tail}`.slice(0, 32);
}

function entryFor(sysId: string, name: string): RecordEntry {
  return {
    path: `instance/${SCOPE}/${TABLE}/${name}`,
    name,
    sysUpdatedOn: "2026-01-02 03:04:05",
    sysUpdatedBy: "admin",
    sysModCount: 7,
    contentHash: createHash("sha256").update(`body:${sysId}`).digest("hex"),
    files: ["script.js"],
  };
}

/** `n` records whose sys_ids fan out over the whole hex space. */
function spreadEntries(count: number): Map<string, RecordEntry> {
  const entries = new Map<string, RecordEntry>();
  for (let index = 0; index < count; index += 1) {
    const prefix = `${HEX[index % 16]}${HEX[(index * 7 + 3) % 16]}`;
    const sysId = sysIdWith(prefix, `record-${index}`);
    entries.set(sysId, entryFor(sysId, `record_${index}`));
  }
  return entries;
}

const SHARD_DIR_REL = `instance/${SCOPE}/${TABLE}/.shards`;

function relToNative(relPath: string): string {
  return toNativePath(ROOT, relPath);
}

/** Put arbitrary bytes at a repo-relative path, creating the directory chain. */
async function seedFile(fs: WriterFs, relPath: string, text: string): Promise<void> {
  const segments = relPath.split("/");
  await fs.makeDir(relToNative(segments.slice(0, -1).join("/")));
  await fs.writeFile(relToNative(relPath), new TextEncoder().encode(text));
}

/** A hand-written shard manifest — deliberately not built with the renderer. */
function manifestText(fields: {
  formatVersion?: unknown;
  table?: string;
  shard: string;
  fanout: number;
  complete?: boolean;
  sweepId?: string;
  records?: Record<string, RecordEntry>;
}): string {
  return `${JSON.stringify(
    {
      formatVersion: fields.formatVersion ?? 1,
      table: fields.table ?? TABLE,
      shard: fields.shard,
      fanout: fields.fanout,
      complete: fields.complete ?? true,
      sweepId: fields.sweepId ?? "handwritten",
      records: fields.records ?? {},
    },
    null,
    2
  )}\n`;
}

/** Every file in the fake, as repo-relative path → text. */
function treeSnapshot(fs: MemoryFs): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const decoder = new TextDecoder("utf-8");
  for (const [nativePath, bytes] of fs.files) {
    const relative = nativePath.slice(ROOT.length + sep.length).split(sep).join("/");
    snapshot[relative] = decoder.decode(bytes);
  }
  return snapshot;
}

function shardFilesOnDisk(fs: MemoryFs, shardDirRel = SHARD_DIR_REL): string[] {
  return Object.keys(treeSnapshot(fs))
    .filter((relPath) => relPath.startsWith(`${shardDirRel}/`))
    .map((relPath) => relPath.slice(shardDirRel.length + 1))
    .sort();
}

function readManifest(fs: MemoryFs, relPath: string): Record<string, unknown> {
  const text = treeSnapshot(fs)[relPath];
  if (text === undefined) {
    throw new Error(`expected a shard file at ${relPath}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function writeSet(
  fs: WriterFs,
  fanout: 0 | 1 | 2,
  entries: Map<string, RecordEntry>,
  complete = true,
  sweepId = SWEEP
): Promise<string[]> {
  return writeShardSet(fs, {
    root: ROOT,
    scope: SCOPE,
    table: TABLE,
    fanout,
    complete,
    sweepId,
    entries,
  });
}

// ---------------------------------------------------------------------------
// loadShardSet
// ---------------------------------------------------------------------------

describe("loadShardSet: what the tree already claims", () => {
  it("reports no baseline and no completeness for a directory that was never written", async () => {
    // `complete: true` here would be the worst possible answer: INV-5 reads it as
    // "a finished sweep vouched for this set", and a set that vouches for nothing
    // authorises deleting everything the table has.
    const fs = new MemoryFs();
    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);

    expect(loaded.fanout).toBeNull();
    expect(loaded.complete).toBe(false);
    expect(loaded.entries.size).toBe(0);
    expect(loaded.fileNames).toEqual([]);
  });

  it("gives the same answer for a shard directory that exists but is empty", async () => {
    // A directory left behind by `mirror migrate` or by a half-removed table is not
    // a baseline. "Exists" and "says something" have to stay different questions.
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(SHARD_DIR_REL));

    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.fanout).toBeNull();
    expect(loaded.complete).toBe(false);
    expect(loaded.entries.size).toBe(0);
  });

  it("reads back every record a completed write put there, at the fan-out it used", async () => {
    const fs = new MemoryFs();
    const entries = spreadEntries(12);
    await writeSet(fs, 1, entries);

    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.fanout).toBe(1);
    expect(loaded.complete).toBe(true);
    expect([...loaded.entries.entries()].sort()).toEqual([...entries.entries()].sort());
    // 16 shard file names, derived from this file's own hex alphabet rather than
    // from the layout module the store shares.
    expect(loaded.fileNames).toEqual([...HEX].map((digit) => `${digit}.json`));
  });

  it("refuses to call the set complete when one of its shards is not", async () => {
    // Completeness is conjunctive. A set where fifteen shards say `true` and one
    // says `false` was not produced by a finished sweep, and reporting `true` would
    // let INV-5 delete records the sweep never got round to observing.
    const fs = new MemoryFs();
    const entries = spreadEntries(12);
    await writeSet(fs, 1, entries);
    await seedFile(
      fs,
      `${SHARD_DIR_REL}/7.json`,
      manifestText({ shard: "7", fanout: 1, complete: false })
    );

    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.complete).toBe(false);
    // The baseline itself survives: the caller loses its authority to delete, not
    // its knowledge of what is on disk.
    expect(loaded.fanout).toBe(1);
    expect(loaded.entries.size).toBeGreaterThan(0);
  });

  it("surfaces a torn set as the surviving files rather than inventing the missing ones", async () => {
    // The SET is not written atomically (only each file is), so a crash can leave a
    // directory short of shards. What load must not do is fabricate the absent ones:
    // `fileNames` is what is really there, so a caller can compare it against the
    // fan-out's full complement and see that the set is torn.
    const fs = new MemoryFs();
    await writeSet(fs, 1, spreadEntries(16));
    await fs.removeRecursive(relToNative(`${SHARD_DIR_REL}/0.json`));
    await fs.removeRecursive(relToNative(`${SHARD_DIR_REL}/1.json`));

    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.fileNames).toEqual([...HEX].slice(2).map((digit) => `${digit}.json`));
    expect(loaded.fanout).toBe(1);
    for (const sysId of loaded.entries.keys()) {
      expect(sysId.startsWith("0") || sysId.startsWith("1")).toBe(false);
    }
  });

  it("stops on a corrupt shard instead of reading it as an empty baseline", async () => {
    // F8's contract, and the single most expensive mistake this module could make:
    // an unparseable shard read as "no records here" tells the deletion logic that
    // every record it used to describe has vanished from the instance.
    const fs = new MemoryFs();
    await writeSet(fs, 1, spreadEntries(12));
    // Control: the fixture loads cleanly before it is damaged, so the rejection
    // below is caused by the corruption and not by the way the set was built.
    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).resolves.toBeDefined();

    await seedFile(fs, `${SHARD_DIR_REL}/3.json`, "{ this is not json");
    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).rejects.toThrow(
      ShardManifestCorrupt
    );
  });

  it("rejects a shard whose file name disagrees with the manifest inside it", async () => {
    // A shard file that was renamed — by a merge, by a human, by a bad migration —
    // would otherwise re-home its records into a shard whose key they do not match,
    // and the next flush would write them somewhere else again and lose them.
    const fs = new MemoryFs();
    await seedFile(
      fs,
      `${SHARD_DIR_REL}/4.json`,
      manifestText({ shard: "3", fanout: 1 })
    );

    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).rejects.toThrow(
      ShardManifestCorrupt
    );
  });

  it("rejects a shard that claims a table other than the directory it sits in", async () => {
    // A copied shard file would otherwise import another table's records into this
    // table's baseline — and INV-5 would then authorise deleting them from here.
    const fs = new MemoryFs();
    await seedFile(
      fs,
      `${SHARD_DIR_REL}/2.json`,
      manifestText({ shard: "2", fanout: 1, table: "sys_ui_policy" })
    );

    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).rejects.toThrow(
      ShardManifestCorrupt
    );
  });

  it("ignores staging leftovers and foreign files in the shard directory", async () => {
    // A crashed run leaves a staging file beside the shards. It is garbage, and it
    // holds whatever bytes the crash interrupted — so it must be excluded by NAME,
    // before anything tries to parse it. The `.json` suffix on the leftover below is
    // what makes this test bite: a filter that only looked at the suffix would try
    // to parse it and turn a crashed run into a hard failure on the next sweep.
    const fs = new MemoryFs();
    await writeSet(fs, 0, spreadEntries(3));
    await seedFile(fs, `${SHARD_DIR_REL}/${STAGING_PREFIX}9f2c.json`, "{ truncated");
    await seedFile(fs, `${SHARD_DIR_REL}/README.md`, "notes about this directory\n");

    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.fileNames).toEqual(["all.json"]);
    expect(loaded.entries.size).toBe(3);
  });

  it("throws on a directory that mixes fan-out levels, and repairs nothing", async () => {
    // A half-finished `mirror migrate` is the only way this happens, and the two
    // wrong answers are symmetrical: picking one level would silently delete the
    // other's records on the next flush, and merging them would produce a set whose
    // file names contradict their contents. The writer reaches `writeShardSet` only
    // through this function (it needs the baseline for `stickyFanout`), so throwing
    // here is what stops a whole-table rewrite nobody asked for.
    const fs = new MemoryFs();
    await writeSet(fs, 1, spreadEntries(12));
    await seedFile(
      fs,
      `${SHARD_DIR_REL}/all.json`,
      manifestText({ shard: "", fanout: 0 })
    );
    const before = treeSnapshot(fs);

    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).rejects.toThrow(
      ShardFanoutConflict
    );
    await expect(loadShardSet(fs, ROOT, SCOPE, TABLE)).rejects.toThrow(/0, 1/);
    // Not one byte moved. A read that "helpfully" unified the levels would be a
    // full-tree churn triggered by a diagnostic.
    expect(treeSnapshot(fs)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// writeShardSet
// ---------------------------------------------------------------------------

describe("writeShardSet: what lands on disk", () => {
  it("puts the shard set where §3 says it goes", async () => {
    // Spelled as a literal path rather than assembled from the layout constants:
    // this is the location every mirror on disk already uses, so a rename of
    // `SHARD_DIR_NAME` or `INSTANCE_DIR_NAME` is a migration, not a refactor.
    const fs = new MemoryFs();
    await writeSet(fs, 0, spreadEntries(2));

    expect(Object.keys(treeSnapshot(fs))).toEqual([
      "instance/global/sys_script_include/.shards/all.json",
    ]);
  });

  it("writes every shard the fan-out names, including the empty ones", async () => {
    // Skipping empty shards would make the expected file set a function of the DATA
    // rather than of the fan-out, so the pruning pass could no longer tell an
    // intentional absence from a leftover — and a directory swept to empty would
    // have no shards at all, erasing both the sticky fan-out and INV-5's evidence
    // that the sweep completed.
    const fs = new MemoryFs();
    const entries = new Map([
      [sysIdWith("3", "only-a"), entryFor(sysIdWith("3", "only-a"), "only_a")],
      [sysIdWith("c", "only-b"), entryFor(sysIdWith("c", "only-b"), "only_b")],
    ]);
    await writeSet(fs, 1, entries);

    expect(shardFilesOnDisk(fs)).toEqual([...HEX].map((digit) => `${digit}.json`));
    const empties = [...HEX]
      .filter((digit) => digit !== "3" && digit !== "c")
      .map((digit) => readManifest(fs, `${SHARD_DIR_REL}/${digit}.json`).records);
    expect(empties).toHaveLength(14);
    for (const records of empties) {
      expect(records).toEqual({});
    }
  });

  it("returns exactly the paths it wrote, in the order it wrote them", async () => {
    const fs = new MemoryFs();
    const written = await writeSet(fs, 1, spreadEntries(20));

    // Every returned path names a file that is really there …
    for (const relPath of written) {
      expect(treeSnapshot(fs)[relPath]).toEqual(expect.any(String));
    }
    // … and nothing landed that the return value failed to mention.
    expect([...written].sort()).toEqual(
      shardFilesOnDisk(fs).map((name) => `${SHARD_DIR_REL}/${name}`)
    );
    // Ascending, which is what makes two identical runs write in the same order —
    // an order that followed a `Map`'s insertion sequence would follow the API's
    // paging order, and INV-1 exists to keep that kind of hidden input out.
    expect(written).toEqual([...written].sort());
  });

  it("files each record into the shard its own sys_id prefix names", async () => {
    // The mapping is derived here from the sys_id string itself, not from
    // `shardKeyFor`, so a change to the prefix rule shows up as a failure rather
    // than as two modules agreeing with each other.
    const fs = new MemoryFs();
    const entries = spreadEntries(40);
    await writeSet(fs, 2, entries);

    const seen = new Set<string>();
    for (const fileName of shardFilesOnDisk(fs)) {
      const manifest = readManifest(fs, `${SHARD_DIR_REL}/${fileName}`);
      const expectedPrefix = fileName.slice(0, 2);
      for (const sysId of Object.keys(manifest.records as Record<string, unknown>)) {
        expect(sysId.slice(0, 2)).toBe(expectedPrefix);
        expect(seen.has(sysId)).toBe(false);
        seen.add(sysId);
      }
    }
    expect(seen).toEqual(new Set(entries.keys()));
  });

  it("deletes the previous fan-out's files so a migration converges", async () => {
    // Without this the old level's files stay behind and the very next load throws
    // ShardFanoutConflict — a migration that leaves the tree permanently unreadable.
    const fs = new MemoryFs();
    const entries = spreadEntries(9);
    await writeSet(fs, 1, entries);
    expect(shardFilesOnDisk(fs)).toHaveLength(16);

    const written = await writeSet(fs, 0, entries);

    expect(shardFilesOnDisk(fs)).toEqual(["all.json"]);
    const reloaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(reloaded.fanout).toBe(0);
    expect([...reloaded.entries.keys()].sort()).toEqual([...entries.keys()].sort());
    // The return value is "what was written", so the sixteen deletions are NOT in
    // it. Stated as an assertion because a caller that reported this list as
    // "files changed" would under-report a migration by every file it removed.
    expect(written).toEqual([`${SHARD_DIR_REL}/all.json`]);
  });

  it("sweeps up staging leftovers but leaves foreign files and subdirectories alone", async () => {
    // Two rules pulling in opposite directions, both worth keeping: a crashed run's
    // staging file is garbage and must not accumulate, while a directory inside
    // `.shards/` was put there by someone else — and deleting a user's tree because
    // it sits under a mirror-managed path is a far worse outcome than an untidy
    // listing.
    const fs = new MemoryFs();
    await seedFile(fs, `${SHARD_DIR_REL}/${STAGING_PREFIX}dead`, "half a shard");
    await seedFile(fs, `${SHARD_DIR_REL}/7.json`, manifestText({ shard: "7", fanout: 1 }));
    await seedFile(fs, `${SHARD_DIR_REL}/notes.txt`, "mine, not the mirror's\n");
    await seedFile(fs, `${SHARD_DIR_REL}/sub/keep.json`, "{}\n");

    await writeSet(fs, 0, spreadEntries(2));

    expect(shardFilesOnDisk(fs).sort()).toEqual([
      "all.json",
      "notes.txt",
      "sub/keep.json",
    ]);
  });

  it("refuses a record key that is not a sys_id before writing any shard (INV-6)", async () => {
    // The key becomes a shard key and a file name one frame later, so `../../..`
    // must stop here. The second assertion is the part that matters: nothing may be
    // half written when it does, or the directory is left holding a set that claims
    // some of the records and none of the rest.
    const fs = new MemoryFs();
    const hostile = new Map<string, RecordEntry>([
      ["../../../etc/passwd", entryFor(sysIdWith("a", "hostile"), "hostile")],
    ]);

    await expect(writeSet(fs, 1, hostile)).rejects.toThrow(MirrorPathRejection);
    expect(shardFilesOnDisk(fs)).toEqual([]);
    expect(fs.calls.filter((call) => call.startsWith("writeFile"))).toEqual([]);
  });

  it("refuses a scope that would escape the instance directory", async () => {
    const fs = new MemoryFs();
    await expect(
      writeShardSet(fs, {
        root: ROOT,
        scope: "..",
        table: TABLE,
        fanout: 0,
        complete: true,
        sweepId: SWEEP,
        entries: new Map(),
      })
    ).rejects.toThrow(MirrorPathRejection);
    expect(fs.calls).toEqual([]);
  });

  it("INV-1: writes byte-identical files for the same set, whatever order it is given in", async () => {
    // The strong form of the invariant. Feeding the same records in reverse makes
    // the `Map`'s iteration order — which in production follows the instance's
    // paging order — a different input, and the bytes must not notice. A renderer
    // that emitted keys in insertion order would pass a naive "run it twice" test
    // and fail this one.
    const first = new MemoryFs();
    const second = new MemoryFs();
    const entries = spreadEntries(24);
    const reversed = new Map([...entries.entries()].reverse());

    await writeSet(first, 1, entries);
    await writeSet(second, 1, reversed);

    expect(treeSnapshot(second)).toEqual(treeSnapshot(first));

    // Non-vacuity: the comparison above is only meaningful if these files react to
    // their content at all. One changed hash must move exactly one shard file.
    const third = new MemoryFs();
    const [firstSysId] = [...entries.keys()];
    const changed = new Map(entries);
    const original = entries.get(firstSysId) as RecordEntry;
    changed.set(firstSysId, { ...original, contentHash: "0".repeat(64) });
    await writeSet(third, 1, changed);

    const before = treeSnapshot(first);
    const after = treeSnapshot(third);
    const differing = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(differing).toEqual([`${SHARD_DIR_REL}/${firstSysId.slice(0, 1)}.json`]);
  });

  it("INV-1: an unchanged set rewritten in place produces the same bytes", async () => {
    // The plain form, against the same directory rather than two fresh ones, so a
    // write that read something back off disk and folded it in would show up.
    const fs = new MemoryFs();
    const entries = spreadEntries(11);
    await writeSet(fs, 2, entries);
    const first = treeSnapshot(fs);

    await writeSet(fs, 2, entries);
    expect(treeSnapshot(fs)).toEqual(first);
  });

  it("INV-1: leaves a shard alone when the sweep id is the only thing that changed", async () => {
    // The case that made the skip necessary. Both runs observed the same instance;
    // all that differs is which run did the observing, and if that reached disk every
    // sync of an unchanged instance would rewrite every shard file in the repository.
    const fs = new MemoryFs();
    const entries = spreadEntries(11);
    await writeSet(fs, 2, entries, true, "sweep-first");
    const first = treeSnapshot(fs);

    const written = await writeSet(fs, 2, entries, true, "sweep-second");

    expect(treeSnapshot(fs)).toEqual(first);
    // Not merely "the bytes are the same": nothing was written at all, which is what
    // the caller reports and what keeps a no-op sync out of the git history.
    expect(written).toEqual([]);
    expect(readManifest(fs, `${SHARD_DIR_REL}/00.json`).sweepId).toBe("sweep-first");
  });

  it("stamps the new sweep id on the one shard whose records changed", async () => {
    // The complement, and the reason the skip compares rather than blanket-refuses:
    // a shard that did change must name the sweep that changed it. The edit keeps the
    // file's byte length identical, so a comparison that only checked length would
    // pass this test by skipping the write.
    const fs = new MemoryFs();
    const entries = spreadEntries(11);
    await writeSet(fs, 2, entries, true, "sweep-first");

    const [firstSysId] = [...entries.keys()];
    const changed = new Map(entries);
    changed.set(firstSysId, {
      ...(entries.get(firstSysId) as RecordEntry),
      contentHash: "0".repeat(64),
    });
    const written = await writeSet(fs, 2, changed, true, "sweep-second");

    const touched = `${SHARD_DIR_REL}/${firstSysId.slice(0, 2)}.json`;
    expect(written).toEqual([touched]);
    expect(readManifest(fs, touched).sweepId).toBe("sweep-second");
    expect(readManifest(fs, `${SHARD_DIR_REL}/ff.json`).sweepId).toBe("sweep-first");
  });

  it("rewrites a shard that gained a record, even though the sweep id also moved", async () => {
    // Same shard file, one record longer. Separate from the test above because the
    // lengths now differ, and "same length, one byte apart" and "different lengths"
    // are two different ways for the comparison to have to say no.
    const fs = new MemoryFs();
    const entries = spreadEntries(4);
    await writeSet(fs, 0, entries, true, "sweep-first");

    const grown = new Map(entries);
    grown.set(sysIdWith("a", "newcomer"), entryFor(sysIdWith("a", "newcomer"), "Newcomer"));
    const written = await writeSet(fs, 0, grown, true, "sweep-second");

    expect(written).toEqual([`${SHARD_DIR_REL}/all.json`]);
    expect(readManifest(fs, `${SHARD_DIR_REL}/all.json`).sweepId).toBe("sweep-second");
  });

  it("overwrites a shard file that is not JSON instead of trying to preserve it", async () => {
    // A corrupt shard stops `loadShardSet`, because there it is a deletion baseline.
    // Here the sweep has already computed the correct content on its own, so the
    // corrupt file is just garbage in the way — refusing to write would leave the
    // tree broken with no way for a later sweep to fix it.
    const fs = new MemoryFs();
    await seedFile(fs, `${SHARD_DIR_REL}/all.json`, "{ not json at all");

    const written = await writeSet(fs, 0, spreadEntries(3), true, "sweep-second");

    expect(written).toEqual([`${SHARD_DIR_REL}/all.json`]);
    expect(readManifest(fs, `${SHARD_DIR_REL}/all.json`).sweepId).toBe("sweep-second");
  });

  it("overwrites a shard file whose sweep id is missing or not a string", async () => {
    // Parseable but not a manifest this code could have written. There is no id to
    // carry forward, so there is nothing to preserve and the write proceeds.
    const fs = new MemoryFs();
    await seedFile(fs, `${SHARD_DIR_REL}/all.json`, JSON.stringify({ sweepId: 7 }));

    const written = await writeSet(fs, 0, spreadEntries(3), true, "sweep-second");

    expect(written).toEqual([`${SHARD_DIR_REL}/all.json`]);
    expect(readManifest(fs, `${SHARD_DIR_REL}/all.json`).sweepId).toBe("sweep-second");
  });

  it("overwrites a shard file whose top level is an array", async () => {
    // `typeof [] === "object"`, so an array reaches the `sweepId` check with no
    // property to fail on; it is rejected on its own terms rather than by accident.
    const fs = new MemoryFs();
    await seedFile(fs, `${SHARD_DIR_REL}/all.json`, "[]");

    const written = await writeSet(fs, 0, spreadEntries(3), true, "sweep-second");

    expect(written).toEqual([`${SHARD_DIR_REL}/all.json`]);
  });

  it("records the completeness it was told, not the completeness it would like", async () => {
    // An incremental sweep flushes shards too; they must say `complete: false` so
    // that INV-5 never mistakes a partial observation for authority to delete.
    const fs = new MemoryFs();
    await writeSet(fs, 0, spreadEntries(4), false);

    expect(readManifest(fs, `${SHARD_DIR_REL}/all.json`).complete).toBe(false);
    const loaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(loaded.complete).toBe(false);
    expect(loaded.entries.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// listScopesWithShards
// ---------------------------------------------------------------------------

describe("listScopesWithShards: the scopes a full sweep must still visit", () => {
  it("finds every scope that holds a shard set for the table, sorted", async () => {
    // Sorted output cannot come from the listing here: the fake returns entries in
    // descending order precisely so that this assertion tests the production code.
    const fs = new MemoryFs();
    for (const scope of ["x_zzz_late", "global", "x_aaa_early"]) {
      await fs.makeDir(relToNative(`instance/${scope}/${TABLE}/.shards`));
    }

    expect(await listScopesWithShards(fs, ROOT, TABLE)).toEqual([
      "global",
      "x_aaa_early",
      "x_zzz_late",
    ]);
  });

  it("ignores scopes that hold no shard set for this table", async () => {
    // The answer drives a full sweep's extra visits, and visiting a scope that has
    // no set for this table would flush a brand-new empty set into it — inventing a
    // directory in the user's repo for a table that scope never had.
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(`instance/has_it/${TABLE}/.shards`));
    await fs.makeDir(relToNative("instance/other_table_only/sys_ui_policy/.shards"));
    await fs.makeDir(relToNative(`instance/no_shards_yet/${TABLE}`));

    expect(await listScopesWithShards(fs, ROOT, TABLE)).toEqual(["has_it"]);
  });

  it("ignores files sitting beside the scope directories", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(`instance/global/${TABLE}/.shards`));
    await seedFile(fs, "instance/README.md", "# mirrored instance\n");

    expect(await listScopesWithShards(fs, ROOT, TABLE)).toEqual(["global"]);
  });

  it("ignores a staging leftover even when it still holds a shard set", async () => {
    // A staged removal that was interrupted leaves a directory whose whole meaning
    // is "garbage awaiting deletion". Treating it as a scope would make a full sweep
    // flush a fresh shard set into it — promoting the leftover to permanent, committed
    // tree content — and mint deletion evidence for records nobody is mirroring.
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(`instance/global/${TABLE}/.shards`));
    await fs.makeDir(relToNative(`instance/${STAGING_PREFIX}7a1f/${TABLE}/.shards`));

    expect(await listScopesWithShards(fs, ROOT, TABLE)).toEqual(["global"]);
  });

  it("answers nothing when the instance directory does not exist yet", async () => {
    const fs = new MemoryFs();
    expect(await listScopesWithShards(fs, ROOT, TABLE)).toEqual([]);
  });

  it("refuses a table name that would escape the instance directory, before any I/O", async () => {
    // This function joins the table into a path itself, so it cannot rely on a
    // caller having validated first. The call log assertion is the point: the
    // hostile component must never reach a filesystem call at all (INV-6's rule for
    // the components that are not sys_ids).
    const fs = new MemoryFs();
    await fs.makeDir(relToNative("instance/global"));
    fs.calls.length = 0;

    await expect(listScopesWithShards(fs, ROOT, "../../etc")).rejects.toThrow(
      MirrorPathRejection
    );
    expect(fs.calls).toEqual([]);
  });
});
