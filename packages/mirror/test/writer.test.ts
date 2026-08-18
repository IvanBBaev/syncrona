// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Writer — INV-1, INV-4 and the deletion path (§5.8, WP-M7).
 *
 * Two invariants carry this file, and both fail silently in production:
 *
 *  * **INV-4** — a shard on disk always describes a COMPLETED table sweep. A shard
 *    flushed by an interrupted sweep claims the table's index is trustworthy when it
 *    lists only the records the sweep got to, and the next full sweep then reads it
 *    as the baseline and authorises deleting everything it never mentioned. A happy-
 *    path test cannot see any of that, so the tests below run a sweep, kill it
 *    partway, and require the PREVIOUS shard bytes to be unchanged — with a control
 *    that proves the aborted sweep really did do work on disk first.
 *  * **INV-1** — a re-run over identical input produces byte-identical output. The
 *    only assertion that means anything here is the whole tree compared byte for
 *    byte; a file count agrees with itself while every record's contents drift.
 *
 * **The filesystem is faked, deliberately, and then checked against a real one.**
 * {@link MemoryFs} is the `WriterFs` seam, which makes crashes, permutations and
 * "zero writes happened" cheap to express. A fake that only ever agreed with itself
 * would prove nothing, so the last suite runs one fixture through the fake and
 * through `nodeWriterFs()` into a real temporary directory and requires the two trees
 * to be identical. `readDir` returns entries deliberately UNSORTED, because the real
 * `readdir(2)` order is unspecified and code that quietly depends on alphabetical
 * order must not be able to hide behind the fake.
 *
 * Every `RedactedRecord` comes from `serializeAndRedact` — INV-3 means there is no
 * other way to obtain one, and there is deliberately no cast anywhere in this file.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type {
  FieldDescriptor,
  RecordEntry,
  ShardManifest,
  TableCatalogEntry,
} from "../src/contracts";
import { serializeAndRedact } from "../src/pipeline";
import {
  MirrorPathRejection,
  parseShardManifest,
  recordDirRelPath,
  SHARD_DIR_NAME,
  shardDirRelPath,
} from "../src/shards/shardLayout";
import type { AttachmentPayload } from "../src/write/attachments";
import { isStagingName, STAGING_PREFIX } from "../src/write/atomicWrite";
import {
  DeletionAuthority,
  DeletionNotAuthorized,
} from "../src/write/deletionAuthority";
import {
  nodeWriterFs,
  toNativePath,
  type WriterDirEntry,
  type WriterFs,
} from "../src/write/fs";
import {
  applyAuthorizedDeletion,
  MirrorWriter,
  tableDirRelPath,
  type RecordWriteOutcome,
  type RecordWriteRequest,
  type TableCompletion,
} from "../src/write/writer";
import type { MirrorSweepMode } from "../src/write/sweepProgress";

const TABLE = "sys_script_include";
const OTHER_TABLE = "cmdb_ci";
const GLOBAL = "global";
const APP_SCOPE = "x_acme_tools";
const MEMORY_ROOT = resolve(sep, "mirror-under-test");

/** A valid INV-6 sys_id derived from a readable label — never hand-typed hex. */
function sysIdFor(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, 32);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf(sep));
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf(sep) + 1);
}

/**
 * An in-memory `WriterFs` with POSIX-ish semantics and a call log.
 *
 * Faithful where the writer depends on it: `readDir` answers `null` for an absent
 * path (that is how `atomicRemoveDir` decides there is nothing to do and how
 * `loadShardSet` decides a scope has no baseline), `rename` moves a whole subtree in
 * one step, `writeFile` needs its parent directory to exist, and `removeRecursive`
 * is silent about a target that is already gone.
 */
class MemoryFs implements WriterFs {
  readonly log: string[] = [];
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();

  constructor(readonly root: string = MEMORY_ROOT) {
    this.dirs.add(root);
  }

  /**
   * Calls that could have changed the tree.
   *
   * Used by the "this input never reached the filesystem" assertions — the ones that
   * make a rejection meaningfully different from a rejection that happened after the
   * damage was done.
   */
  get mutations(): string[] {
    return this.log.filter(
      (line) => !line.startsWith("readDir ") && !line.startsWith("readFile ")
    );
  }

  resetLog(): void {
    this.log.length = 0;
  }

  async makeDir(dir: string): Promise<void> {
    this.log.push(`makeDir ${this.relative(dir)}`);
    if (this.files.has(dir)) {
      throw new Error(`ENOTDIR: ${dir} already exists as a file`);
    }
    const pending: string[] = [];
    let current = dir;
    while (!this.dirs.has(current)) {
      if (!current.startsWith(`${this.root}${sep}`)) {
        throw new Error(`ENOENT: ${dir} is outside the mirror root`);
      }
      pending.push(current);
      current = parentOf(current);
    }
    for (const created of pending.reverse()) {
      this.dirs.add(created);
    }
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.log.push(`writeFile ${this.relative(filePath)}`);
    if (!this.dirs.has(parentOf(filePath))) {
      throw new Error(`ENOENT: no such directory ${parentOf(filePath)}`);
    }
    if (this.dirs.has(filePath)) {
      throw new Error(`EISDIR: ${filePath} is a directory`);
    }
    this.files.set(filePath, Uint8Array.from(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename ${this.relative(from)} -> ${this.relative(to)}`);
    if (!this.dirs.has(parentOf(to))) {
      throw new Error(`ENOENT: no such directory ${parentOf(to)}`);
    }
    const bytes = this.files.get(from);
    if (bytes !== undefined) {
      if (this.dirs.has(to)) {
        throw new Error(`EISDIR: cannot replace directory ${to} with a file`);
      }
      this.files.delete(from);
      this.files.set(to, bytes);
      return;
    }
    if (!this.dirs.has(from)) {
      throw new Error(`ENOENT: no such file or directory ${from}`);
    }
    if (this.files.has(to)) {
      throw new Error(`ENOTDIR: cannot replace file ${to} with a directory`);
    }
    if (this.dirs.has(to) && this.childrenOf(to).length > 0) {
      // POSIX refuses to rename onto a non-empty directory. The writer's rename pass
      // clears the destination with `atomicRemoveDir` first precisely because of
      // this; a permissive fake would let a regression there pass.
      throw new Error(`ENOTEMPTY: ${to}`);
    }
    const prefix = `${from}${sep}`;
    for (const [path, content] of [...this.files]) {
      if (path.startsWith(prefix)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, content);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === from || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
        this.dirs.add(`${to}${dir.slice(from.length)}`);
      }
    }
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    this.log.push(`readFile ${this.relative(filePath)}`);
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    this.log.push(`readDir ${this.relative(dir)}`);
    if (!this.dirs.has(dir)) {
      return null;
    }
    return this.childrenOf(dir);
  }

  async removeRecursive(target: string): Promise<void> {
    this.log.push(`removeRecursive ${this.relative(target)}`);
    this.files.delete(target);
    const prefix = `${target}${sep}`;
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(prefix)) {
        this.files.delete(path);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
      }
    }
  }

  /** Repo-relative path → bytes, sorted: the value INV-1 compares. */
  snapshot(): Map<string, Uint8Array> {
    const entries: Array<[string, Uint8Array]> = [...this.files].map(
      ([path, bytes]) => [this.relative(path), Uint8Array.from(bytes)]
    );
    entries.sort((left, right) => (left[0] < right[0] ? -1 : 1));
    return new Map(entries);
  }

  /** Every repo-relative path, files and directories alike. */
  paths(): string[] {
    return [
      ...[...this.dirs].map((path) => this.relative(path)),
      ...[...this.files.keys()].map((path) => this.relative(path)),
    ]
      .filter((path) => path !== "")
      .sort();
  }

  text(relative: string): string | null {
    const bytes = this.files.get(toNativePath(this.root, relative));
    return bytes === undefined ? null : Buffer.from(bytes).toString("utf8");
  }

  /** Put a file in the tree without going through the writer (crash leftovers). */
  async seed(relative: string, contents: string): Promise<void> {
    const absolute = toNativePath(this.root, relative);
    await this.makeDir(parentOf(absolute));
    await this.writeFile(absolute, Buffer.from(contents, "utf8"));
    this.resetLog();
  }

  private childrenOf(dir: string): WriterDirEntry[] {
    // Directories first, then files, each in creation order — anything but sorted.
    // `readdir(2)` makes no ordering promise, and a fake that sorted would let a
    // hidden dependence on alphabetical order pass here and fail on a real disk.
    const entries: WriterDirEntry[] = [];
    for (const path of this.dirs) {
      if (path !== dir && parentOf(path) === dir) {
        entries.push({ name: baseOf(path), isDirectory: true });
      }
    }
    for (const path of this.files.keys()) {
      if (parentOf(path) === dir) {
        entries.push({ name: baseOf(path), isDirectory: false });
      }
    }
    return entries;
  }

  private relative(absolute: string): string {
    if (absolute === this.root) {
      return "";
    }
    return absolute.slice(this.root.length + 1).split(sep).join("/");
  }
}

const field = (partial: Partial<FieldDescriptor>): FieldDescriptor => ({
  element: partial.element ?? "",
  internalType: partial.internalType ?? "string",
  extractAs: partial.extractAs ?? null,
  isJsonBlob: partial.isJsonBlob ?? false,
  isNoise: partial.isNoise ?? false,
  isDenied: partial.isDenied ?? false,
  reference: partial.reference ?? null,
  maxLength: partial.maxLength ?? null,
});

const catalogFor = (name: string): TableCatalogEntry => ({
  name,
  sysId: sysIdFor(`table:${name}`),
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: null,
  maxUpdatedOn: null,
  fields: [
    field({ element: "name" }),
    field({ element: "script", internalType: "script", extractAs: "js" }),
  ],
  status: "included",
});

interface Fixture {
  sysId: string;
  displayName: string;
  scope?: string;
  table?: string;
  script?: string;
  sysUpdatedOn?: string;
  sysModCount?: number;
  /**
   * Attachments the sweep fetched for this record.
   *
   * `undefined` and `[]` are different inputs on purpose and the suite below
   * depends on the difference: absent means the sweep never asked (attachments
   * off), empty means it asked and the record has none.
   */
  attachments?: readonly AttachmentPayload[];
}

/** One write request, with a real redacted record behind it (INV-3). */
function requestFor(fixture: Fixture): RecordWriteRequest {
  const table = fixture.table ?? TABLE;
  const { record } = serializeAndRedact(
    {
      sys_id: fixture.sysId,
      name: fixture.displayName,
      script: fixture.script ?? "gs.info('ok');",
    },
    { table: catalogFor(table) }
  );
  return {
    record,
    scope: fixture.scope ?? GLOBAL,
    displayName: fixture.displayName,
    sysUpdatedOn: fixture.sysUpdatedOn ?? "2026-01-01 00:00:00",
    sysUpdatedBy: "admin",
    sysModCount: fixture.sysModCount ?? 1,
    ...(fixture.attachments === undefined ? {} : { attachments: fixture.attachments }),
  };
}

interface SweepOptions {
  sweepId?: string;
  mode?: MirrorSweepMode;
  rewriteUnchanged?: boolean;
  table?: string;
  lfsThresholdBytes?: number;
}

/** Write every request into one table and complete the sweep. */
async function sweep(
  fs: WriterFs & { root: string },
  requests: readonly RecordWriteRequest[],
  options: SweepOptions = {}
): Promise<{ outcomes: RecordWriteOutcome[]; completion: TableCompletion }> {
  const writer = new MirrorWriter({
    root: fs.root,
    sweepId: options.sweepId ?? "sweep-1",
    mode: options.mode,
    fs,
    rewriteUnchanged: options.rewriteUnchanged,
    lfsThresholdBytes: options.lfsThresholdBytes,
  });
  const table = writer.beginTable(options.table ?? TABLE);
  const outcomes: RecordWriteOutcome[] = [];
  for (const request of requests) {
    outcomes.push(await table.writeRecord(request));
  }
  return { outcomes, completion: await table.completeTable() };
}

/** Every shard manifest one scope's shard set currently holds on disk. */
function shardManifests(fs: MemoryFs, scope: string, table = TABLE): ShardManifest[] {
  const dir = `${shardDirRelPath(scope, table)}/`;
  const manifests: ShardManifest[] = [];
  for (const [path, bytes] of fs.snapshot()) {
    if (path.startsWith(dir)) {
      manifests.push(parseShardManifest(Buffer.from(bytes).toString("utf8"), path));
    }
  }
  return manifests;
}

/** The union of every shard's records — what the shard set claims the table holds. */
function shardRecords(
  fs: MemoryFs,
  scope: string,
  table = TABLE
): Map<string, RecordEntry> {
  const records = new Map<string, RecordEntry>();
  for (const manifest of shardManifests(fs, scope, table)) {
    for (const [sysId, entry] of Object.entries(manifest.records)) {
      records.set(sysId, entry);
    }
  }
  return records;
}

function shardFilePaths(fs: MemoryFs): string[] {
  return [...fs.snapshot().keys()].filter((path) =>
    path.split("/").includes(SHARD_DIR_NAME)
  );
}

function stagingPathsIn(fs: MemoryFs): string[] {
  return fs.paths().filter((path) => path.split("/").some(isStagingName));
}

const UTIL = sysIdFor("util-record");
const HELPER = sysIdFor("helper-record");
const EXTRA = sysIdFor("extra-record");

describe("INV-4: a shard on disk describes a completed sweep", () => {
  it("puts no shard on disk until the table's sweep completes", async () => {
    const fs = new MemoryFs();
    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-1", fs });
    const table = writer.beginTable(TABLE);

    await table.writeRecord(requestFor({ sysId: UTIL, displayName: "Util" }));
    await table.writeRecord(requestFor({ sysId: HELPER, displayName: "Helper" }));

    // The records are on disk — this is not a sweep that did nothing.
    expect(fs.snapshot().size).toBeGreaterThan(0);
    expect(shardFilePaths(fs)).toEqual([]);

    await table.completeTable();
    expect(shardFilePaths(fs).length).toBeGreaterThan(0);
  });

  it("leaves the previous shard bytes untouched when a sweep is abandoned", async () => {
    // The invariant in one test: sweep 2 writes real records and then dies, and the
    // index a reader would consult still describes sweep 1 exactly. Were the shard
    // flushed incrementally, the abandoned sweep's partial view would become the
    // baseline and the next full sweep would authorise deleting every record it had
    // not reached.
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Util" }),
        requestFor({ sysId: HELPER, displayName: "Helper" }),
      ],
      { sweepId: "sweep-1" }
    );
    const shardsAfterFirst = new Map(
      [...fs.snapshot()].filter(([path]) => path.split("/").includes(SHARD_DIR_NAME))
    );
    const treeAfterFirst = fs.snapshot();
    expect(shardsAfterFirst.size).toBeGreaterThan(0);

    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-2", fs });
    const table = writer.beginTable(TABLE);
    await table.writeRecord(
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        script: "gs.info('changed');",
        sysModCount: 2,
      })
    );
    const extra = await table.writeRecord(
      requestFor({ sysId: EXTRA, displayName: "Extra" })
    );
    table.abandon();

    const shardsAfterAbandon = new Map(
      [...fs.snapshot()].filter(([path]) => path.split("/").includes(SHARD_DIR_NAME))
    );
    expect(shardsAfterAbandon).toEqual(shardsAfterFirst);

    // Anti-vacuity: the abandoned sweep really did change the tree, so "the shards
    // did not change" is a statement about the shards and not about an idle run.
    expect(fs.snapshot()).not.toEqual(treeAfterFirst);
    const claimed = shardRecords(fs, GLOBAL);
    expect([...claimed.keys()].sort()).toEqual([UTIL, HELPER].sort());
    expect(claimed.has(EXTRA)).toBe(false);
    // …while `Extra`'s directory does exist. Unclaimed bytes are the documented
    // outcome of an interruption (§5.8): correct content that no index vouches for.
    expect(fs.paths()).toContain(extra.path);

    // Anti-vacuity for the comparison itself: the very same second sweep, allowed to
    // finish, does change those bytes. Without this the assertion above would also
    // hold if shard writing had stopped working altogether.
    const completing = new MemoryFs();
    await sweep(
      completing,
      [
        requestFor({ sysId: UTIL, displayName: "Util" }),
        requestFor({ sysId: HELPER, displayName: "Helper" }),
      ],
      { sweepId: "sweep-1" }
    );
    const beforeSecond = shardManifests(completing, GLOBAL);
    await sweep(
      completing,
      [
        requestFor({
          sysId: UTIL,
          displayName: "Util",
          script: "gs.info('changed');",
          sysModCount: 2,
        }),
        requestFor({ sysId: HELPER, displayName: "Helper" }),
        requestFor({ sysId: EXTRA, displayName: "Extra" }),
      ],
      { sweepId: "sweep-2" }
    );
    expect(shardManifests(completing, GLOBAL)).not.toEqual(beforeSecond);
    expect(shardRecords(completing, GLOBAL).has(EXTRA)).toBe(true);
  });

  it("refuses to be used again once completed or abandoned", async () => {
    // Reusing a sweep writer would append records to a shard set that has already
    // claimed to be complete — the false claim R2 forbids, made by an object that
    // looked reusable.
    const fs = new MemoryFs();
    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-1", fs });

    const completed = writer.beginTable(TABLE);
    await completed.completeTable();
    await expect(
      completed.writeRecord(requestFor({ sysId: UTIL, displayName: "Util" }))
    ).rejects.toThrow(/already completed/);
    await expect(completed.completeTable()).rejects.toThrow(/already completed/);
    expect(() => {
      completed.abandon();
    }).toThrow(/already completed/);

    const abandoned = writer.beginTable(TABLE);
    abandoned.abandon();
    await expect(
      abandoned.writeRecord(requestFor({ sysId: UTIL, displayName: "Util" }))
    ).rejects.toThrow(/already abandoned/);
    await expect(abandoned.completeTable()).rejects.toThrow(/already abandoned/);
  });

  it("marks an incremental sweep over no baseline incomplete and mints no authority", async () => {
    // An incremental sweep saw a filtered slice, so absence from it means "not
    // changed recently". Handing out an authority would turn that into "deleted".
    // With no baseline underneath, the slice is also all the set can claim, so the
    // shard flushes incomplete — which is what sends this table back to a full
    // sweep on the next plan (§5.4).
    const fs = new MemoryFs();
    const { completion } = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { mode: "incremental" }
    );

    expect(completion.authority).toBeNull();
    expect(completion.complete).toBe(false);
    expect(shardManifests(fs, GLOBAL).map((manifest) => manifest.complete)).toEqual([
      false,
    ]);
  });

  it("preserves a complete baseline's claim across an incremental flush, still without authority", async () => {
    // The planner reads `complete` for watermark eligibility (§5.4). If the flag
    // followed the sweep's mode, the first incremental flush would stamp a complete
    // baseline `complete: false` and every incremental sync would force a full
    // sweep on the next run — watermark chaining could never happen. Completeness
    // is a property of the entry set: a complete set plus a filtered overlay is
    // still complete. Deletion authority stays full-sweep-only regardless (INV-5).
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })], {
      sweepId: "sweep-1",
    });

    const { completion } = await sweep(
      fs,
      [
        requestFor({
          sysId: UTIL,
          displayName: "Util",
          script: "gs.info('changed');",
          sysModCount: 2,
        }),
      ],
      { sweepId: "sweep-2", mode: "incremental" }
    );

    expect(completion.authority).toBeNull();
    expect(completion.complete).toBe(true);
    expect(shardManifests(fs, GLOBAL).map((manifest) => manifest.complete)).toEqual([
      true,
    ]);
  });

  it("leaves an unchanged complete shard byte-identical across a no-op incremental flush", async () => {
    // The INV-1 corollary of the claim above: with `complete` preserved, a no-op
    // incremental re-flush differs from the baseline only in `sweepId`, which
    // `writeShardSet` declines to rewrite. Were the flag mode-derived, the first
    // incremental sweep would rewrite every shard in the repository.
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })], {
      sweepId: "sweep-1",
    });
    const before = new Map(
      [...fs.snapshot()].filter(([path]) => path.split("/").includes(SHARD_DIR_NAME))
    );

    const { completion } = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { sweepId: "sweep-2", mode: "incremental" }
    );

    expect(completion.shardsWritten).toEqual([]);
    expect(
      new Map(
        [...fs.snapshot()].filter(([path]) => path.split("/").includes(SHARD_DIR_NAME))
      )
    ).toEqual(before);
  });

  it("keeps records an incremental sweep did not re-fetch in the shard set", async () => {
    // The merge in `entriesToFlush`. Dropping the un-refetched record would orphan
    // its directory — no shard would claim it, `mirror repair` would call it garbage,
    // and the record would disappear from the mirror without ever being deleted from
    // the instance.
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Util" }),
        requestFor({ sysId: HELPER, displayName: "Helper" }),
      ],
      { sweepId: "sweep-1" }
    );

    await sweep(
      fs,
      [
        requestFor({
          sysId: UTIL,
          displayName: "Util",
          script: "gs.info('changed');",
          sysModCount: 2,
        }),
      ],
      { sweepId: "sweep-2", mode: "incremental" }
    );

    expect([...shardRecords(fs, GLOBAL).keys()].sort()).toEqual(
      [UTIL, HELPER].sort()
    );
  });
});

describe("INV-1: identical input, identical bytes", () => {
  const fixtures = [
    requestFor({ sysId: UTIL, displayName: "Util" }),
    requestFor({ sysId: HELPER, displayName: "Helper", scope: APP_SCOPE }),
    requestFor({ sysId: EXTRA, displayName: "Extra", script: "gs.info('extra');" }),
  ];

  it("produces the same tree twice, byte for byte", async () => {
    // Same sweep id on both runs because the sweep id is an INPUT — §4.3 puts it in
    // every manifest. What must not differ is anything else: hash iteration order,
    // `Date.now`, the order a `Map` happens to enumerate.
    const first = new MemoryFs();
    const second = new MemoryFs();
    await sweep(first, fixtures, { sweepId: "sweep-1" });
    await sweep(second, fixtures, { sweepId: "sweep-1" });

    expect(second.snapshot()).toEqual(first.snapshot());
    expect(second.paths()).toEqual(first.paths());
    expect(first.snapshot().size).toBeGreaterThan(3);
  });

  it("re-sweeping the same tree changes nothing in it", async () => {
    const fs = new MemoryFs();
    await sweep(fs, fixtures, { sweepId: "sweep-1" });
    const afterFirst = fs.snapshot();
    await sweep(fs, fixtures, { sweepId: "sweep-1" });

    expect(fs.snapshot()).toEqual(afterFirst);
  });

  it("would notice a single changed byte (anti-vacuity control)", async () => {
    // If this ever stops failing, every comparison above is comparing two things
    // that cannot differ and the suite proves nothing.
    const first = new MemoryFs();
    const second = new MemoryFs();
    await sweep(first, fixtures, { sweepId: "sweep-1" });
    const { outcomes } = await sweep(
      second,
      [
        fixtures[0],
        fixtures[1],
        requestFor({ sysId: EXTRA, displayName: "Extra", script: "gs.info('extra!');" }),
      ],
      { sweepId: "sweep-1" }
    );

    expect(second.snapshot()).not.toEqual(first.snapshot());
    // …and the difference is confined to the record that changed plus the shard that
    // indexes it, which is what makes the mirror's git history readable: a one-field
    // edit that rewrote a neighbour would show up here as an unrelated path.
    const changedRecordDir = `${outcomes[2].path}/`;
    const differing = [...first.snapshot()]
      .filter(([path, bytes]) => {
        const other = second.snapshot().get(path);
        return other === undefined || Buffer.compare(bytes, other) !== 0;
      })
      .map(([path]) => path);
    expect(differing.length).toBeGreaterThan(0);
    expect(
      differing.every(
        (path) =>
          path.startsWith(changedRecordDir) || path.split("/").includes(SHARD_DIR_NAME)
      )
    ).toBe(true);
  });

  it("does not depend on the order the instance paged the records back", async () => {
    // The fold group is what makes this bite: two records competing for one name get
    // their `_<sysId>` suffixes only if the decision is order-independent. A writer
    // that let the first arrival keep the plain name would produce two different
    // trees from the same instance depending on the API's paging order.
    const colliding = [
      requestFor({ sysId: UTIL, displayName: "Shared Name" }),
      requestFor({ sysId: HELPER, displayName: "Shared Name" }),
      requestFor({ sysId: EXTRA, displayName: "Distinct" }),
    ];
    const forward = new MemoryFs();
    const backward = new MemoryFs();
    await sweep(forward, colliding, { sweepId: "sweep-1" });
    await sweep(backward, [...colliding].reverse(), { sweepId: "sweep-1" });

    expect(backward.snapshot()).toEqual(forward.snapshot());
    expect(backward.paths()).toEqual(forward.paths());
  });

  it("changes nothing at all when only the sweep id differs", async () => {
    // The whole tree, not a subset: this is INV-1 stated at the writer's own level,
    // and the shard manifests are the part that had to be argued for. `sweepId` is
    // the one field of §4.3 that varies between two runs over identical data, so a
    // flush that stamped it unconditionally would put a diff in every shard file in
    // the repository on every sync — INV-1 failing not because the mirror observed
    // something different but because it wrote down which run did the observing.
    const fs = new MemoryFs();
    await sweep(fs, fixtures, { sweepId: "sweep-1" });
    const afterFirst = fs.snapshot();
    await sweep(fs, fixtures, { sweepId: "sweep-2" });

    expect(fs.snapshot()).toEqual(afterFirst);
    // And the surviving id is the first sweep's, which is the reading that makes the
    // field mean "the sweep that last changed this shard" — the one a reader can
    // check against `git blame`.
    expect(shardManifests(fs, GLOBAL).map((manifest) => manifest.sweepId)).toEqual([
      "sweep-1",
    ]);
  });

  it("stamps the new sweep id on the shard whose contents the sweep changed", async () => {
    // The complement, and the reason the skip is a comparison rather than a blanket
    // "never rewrite a shard": a shard that did change must carry the sweep that
    // changed it, or the provenance the previous test relies on is worthless.
    const fs = new MemoryFs();
    await sweep(fs, fixtures, { sweepId: "sweep-1" });
    await sweep(
      fs,
      fixtures.map((request, index) =>
        index === 0 ? { ...request, sysModCount: 99 } : request
      ),
      { sweepId: "sweep-2" }
    );

    expect(shardManifests(fs, GLOBAL).map((manifest) => manifest.sweepId)).toEqual([
      "sweep-2",
    ]);
  });
});

describe("staging files never become content", () => {
  it("leaves no staging artefact behind after a successful sweep", async () => {
    const fs = new MemoryFs();
    await sweep(fs, [
      requestFor({ sysId: UTIL, displayName: "Util" }),
      requestFor({ sysId: HELPER, displayName: "Helper" }),
    ]);

    expect(stagingPathsIn(fs)).toEqual([]);
  });

  it("prunes a crashed run's leftovers instead of mirroring them as content", async () => {
    // A `.mirror-tmp-…` file is a half-written record from a process that died. If
    // the next sweep left it in place it would be committed, would show up in
    // `git log` as instance content, and would never be cleaned up — while a stale
    // extracted file (a field that stopped being extracted) would read as current.
    const fs = new MemoryFs();
    const { outcomes } = await sweep(fs, [
      requestFor({ sysId: UTIL, displayName: "Util" }),
    ]);
    const recordDir = outcomes[0].path;

    await fs.seed(`${recordDir}/${STAGING_PREFIX}crashed-run`, "half a record");
    await fs.seed(`${recordDir}/legacy_field.js`, "// no longer extracted\n");
    await fs.seed(`${recordDir}/.gitattributes`, "* -text\n");
    await fs.seed(
      `${shardDirRelPath(GLOBAL, TABLE)}/${STAGING_PREFIX}crashed-shard`,
      "{}"
    );

    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })], {
      sweepId: "sweep-2",
      rewriteUnchanged: true,
    });

    expect(stagingPathsIn(fs)).toEqual([]);
    expect(fs.text(`${recordDir}/legacy_field.js`)).toBeNull();
    // A dotfile the mirror did not write is a user's, not garbage: "the mirror owns
    // this directory" is a claim about the files it writes.
    expect(fs.text(`${recordDir}/.gitattributes`)).toBe("* -text\n");
    // And none of it was ever claimed as a record's field file.
    const entry = shardRecords(fs, GLOBAL).get(UTIL);
    expect(entry?.files).toEqual(["script.js"]);
  });
});

describe("the record tree the writer builds", () => {
  it("writes the envelope and each extracted field, and nothing else", async () => {
    const fs = new MemoryFs();
    const { outcomes } = await sweep(fs, [
      requestFor({ sysId: UTIL, displayName: "Util" }),
    ]);
    const dir = outcomes[0].path;

    expect([...fs.snapshot().keys()].filter((path) => path.startsWith(`${dir}/`))).toEqual(
      [`${dir}/record.json`, `${dir}/script.js`]
    );
    // The field's value, verbatim, plus exactly one trailing newline — a text file
    // git will not flag with "\\ No newline at end of file" on every commit.
    const script = fs.text(`${dir}/script.js`) ?? "";
    expect(script.trimEnd()).toBe("gs.info('ok');");
    expect(script).toBe("gs.info('ok');\n");
    // The shard's hash is a claim about the envelope on disk, checkable with
    // `sha256sum` and derived here from the bytes rather than copied from the code.
    const bytes = fs.snapshot().get(`${dir}/record.json`) ?? new Uint8Array();
    expect(outcomes[0].entry.contentHash).toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });

  it("suffixes every member of a colliding group and leaves no plain directory", async () => {
    // D18/F9. The failure this catches is the quiet one: the second record written
    // into the first record's directory, overwriting it, with a shard that claims
    // both records live at the same path.
    const fs = new MemoryFs();
    const { outcomes } = await sweep(fs, [
      requestFor({ sysId: UTIL, displayName: "Shared Name" }),
      requestFor({ sysId: HELPER, displayName: "Shared Name" }),
    ]);

    const first = outcomes[0];
    const second = outcomes[1];
    expect(second.renames).toEqual([
      { sysId: UTIL, from: first.entry.name, to: `${first.entry.name}_${UTIL}` },
    ]);

    const entries = shardRecords(fs, GLOBAL);
    const utilPath = entries.get(UTIL)?.path;
    const helperPath = entries.get(HELPER)?.path;
    expect(utilPath?.endsWith(`_${UTIL}`)).toBe(true);
    expect(helperPath?.endsWith(`_${HELPER}`)).toBe(true);
    expect(utilPath).not.toBe(helperPath);
    // The pre-collision directory is gone rather than left as an orphan next to the
    // renamed one.
    expect(fs.paths()).not.toContain(first.path);
    expect(fs.paths()).toContain(utilPath);
    expect(fs.text(`${utilPath ?? ""}/record.json`)).not.toBe(
      fs.text(`${helperPath ?? ""}/record.json`)
    );
  });

  it("skips the write when the shard already describes what is on disk", async () => {
    // The property the incremental sweep exists for: an unchanged record costs no
    // write and therefore produces no git diff. If this regressed, every sweep would
    // rewrite every record and the mirror's history would become unreadable.
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })]);

    const writer = new MirrorWriter({
      root: fs.root,
      sweepId: "sweep-2",
      mode: "incremental",
      fs,
    });
    const table = writer.beginTable(TABLE);
    fs.resetLog();
    const outcome = await table.writeRecord(
      requestFor({ sysId: UTIL, displayName: "Util" })
    );

    expect(outcome.status).toBe("unchanged");
    expect(fs.mutations).toEqual([]);
    table.abandon();
  });

  it("rewrites the same record when `mirror repair` distrusts the shard", async () => {
    // The control for the test above, and the behaviour `repair` depends on: with
    // `rewriteUnchanged` the shortcut must not fire even though nothing changed.
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })]);

    const writer = new MirrorWriter({
      root: fs.root,
      sweepId: "sweep-2",
      mode: "incremental",
      fs,
      rewriteUnchanged: true,
    });
    const table = writer.beginTable(TABLE);
    fs.resetLog();
    const outcome = await table.writeRecord(
      requestFor({ sysId: UTIL, displayName: "Util" })
    );

    expect(outcome.status).toBe("written");
    expect(fs.mutations.filter((line) => line.startsWith("writeFile ")).length).toBe(2);
    table.abandon();
  });

  it("agrees with `recordDirRelPath` about where a table's records live", async () => {
    // Two derivations of the same layout, from two functions, cross-checked. A change
    // to one that missed the other would put shards and records in different trees.
    expect(
      recordDirRelPath({ scope: GLOBAL, table: TABLE, sysId: UTIL, name: "util" })
    ).toBe(`${tableDirRelPath(GLOBAL, TABLE)}/util`);
    expect(shardDirRelPath(GLOBAL, TABLE).startsWith(tableDirRelPath(GLOBAL, TABLE))).toBe(
      true
    );
    expect(() => tableDirRelPath("..", TABLE)).toThrow(MirrorPathRejection);
    expect(() => tableDirRelPath(GLOBAL, "../../etc")).toThrow(MirrorPathRejection);
  });
});

describe("R3: refusals are loud, and happen before the filesystem", () => {
  it("rejects a record that belongs to another table", async () => {
    // Filing it under this table's shards would make both tables lie: one claims a
    // record it does not own, the other never mentions it and would authorise its
    // deletion on the next full sweep.
    const fs = new MemoryFs();
    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-1", fs });
    const table = writer.beginTable(TABLE);
    fs.resetLog();

    await expect(
      table.writeRecord(
        requestFor({ sysId: UTIL, displayName: "Util", table: OTHER_TABLE })
      )
    ).rejects.toThrow(MirrorPathRejection);
    expect(fs.mutations).toEqual([]);
    expect(fs.snapshot().size).toBe(0);
  });

  it("rejects a hostile sys_id before deriving any path from it (INV-6)", async () => {
    const fs = new MemoryFs();
    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-1", fs });
    const table = writer.beginTable(TABLE);
    fs.resetLog();

    await expect(
      table.writeRecord(
        requestFor({ sysId: "../../../etc/passwd", displayName: "Util" })
      )
    ).rejects.toThrow(MirrorPathRejection);
    // Nothing at all reached the filesystem, which is only true because the
    // validation happens above the derivation rather than beside it.
    expect(fs.log).toEqual([]);
  });

  it("rejects an unusable table name at the sweep's boundary", async () => {
    const fs = new MemoryFs();
    const writer = new MirrorWriter({ root: fs.root, sweepId: "sweep-1", fs });

    expect(() => writer.beginTable("../evil")).toThrow(MirrorPathRejection);
    expect(fs.log).toEqual([]);
  });
});

describe("INV-5: the only deletion path there is", () => {
  /** Sweep 1 writes both records; sweep 2 sees only `UTIL`, so `HELPER` is gone. */
  async function sweepThatLostHelper(): Promise<{
    fs: MemoryFs;
    authority: DeletionAuthority;
  }> {
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Util" }),
        requestFor({ sysId: HELPER, displayName: "Helper" }),
      ],
      { sweepId: "sweep-1" }
    );
    const { completion } = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { sweepId: "sweep-2" }
    );
    const authority = completion.authority;
    if (authority === null) {
      throw new Error("a completed full sweep must mint an authority");
    }
    return { fs, authority };
  }

  it("removes exactly the directory the sweep proved empty", async () => {
    const { fs, authority } = await sweepThatLostHelper();
    const before = fs.snapshot();

    const deletion = await applyAuthorizedDeletion(fs, fs.root, authority, GLOBAL, HELPER);

    // The expectation is derived from the returned path, not written out: whatever
    // lived under that directory is gone and nothing else moved.
    const expected = new Map(
      [...before].filter(([path]) => !path.startsWith(`${deletion.path}/`))
    );
    expect(fs.snapshot()).toEqual(expected);
    expect(before.size - fs.snapshot().size).toBe(2);
    expect(fs.paths()).not.toContain(deletion.path);
    expect(stagingPathsIn(fs)).toEqual([]);
  });

  it("refuses a sys_id the sweep did not prove absent, and touches nothing", async () => {
    const { fs, authority } = await sweepThatLostHelper();
    const before = fs.snapshot();
    fs.resetLog();

    await expect(
      applyAuthorizedDeletion(fs, fs.root, authority, GLOBAL, UTIL)
    ).rejects.toThrow(DeletionNotAuthorized);

    expect(fs.mutations).toEqual([]);
    expect(fs.snapshot()).toEqual(before);
  });

  it("refuses a shard entry whose path is not where its name lives", async () => {
    // A shard file is committed to git, so its contents arrive through pull requests.
    // An entry that says `name: "util"` but `path: <somewhere else>` is an attempt to
    // aim the removal, and the path is re-derived from the components precisely so
    // that the file cannot direct it.
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })]);
    const honest = shardRecords(fs, GLOBAL).get(UTIL);
    if (honest === undefined) {
      throw new Error("the sweep must have indexed the record");
    }
    const authority = DeletionAuthority.fromCompletedSweep({
      table: TABLE,
      sweepId: "sweep-2",
      complete: true,
      scopes: [
        {
          scope: GLOBAL,
          baseline: new Map([
            [
              UTIL,
              {
                ...honest,
                path: recordDirRelPath({
                  scope: GLOBAL,
                  table: TABLE,
                  sysId: UTIL,
                  name: "somewhere_else",
                }),
              },
            ],
          ]),
          observed: new Map<string, RecordEntry>(),
        },
      ],
    });
    const before = fs.snapshot();
    fs.resetLog();

    await expect(
      applyAuthorizedDeletion(fs, fs.root, authority, GLOBAL, UTIL)
    ).rejects.toThrow(MirrorPathRejection);
    expect(fs.mutations).toEqual([]);
    expect(fs.snapshot()).toEqual(before);
  });

  it("refuses a shard entry whose name is not a path component at all", async () => {
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util" })]);
    const authority = DeletionAuthority.fromCompletedSweep({
      table: TABLE,
      sweepId: "sweep-2",
      complete: true,
      scopes: [
        {
          scope: GLOBAL,
          baseline: new Map([
            [
              UTIL,
              {
                path: `${tableDirRelPath(GLOBAL, TABLE)}/..`,
                name: "..",
                sysUpdatedOn: "2026-01-01 00:00:00",
                sysUpdatedBy: "admin",
                sysModCount: 1,
                contentHash: "0".repeat(64),
                files: [],
              },
            ],
          ]),
          observed: new Map<string, RecordEntry>(),
        },
      ],
    });
    const before = fs.snapshot();
    fs.resetLog();

    await expect(
      applyAuthorizedDeletion(fs, fs.root, authority, GLOBAL, UTIL)
    ).rejects.toThrow(MirrorPathRejection);
    expect(fs.mutations).toEqual([]);
    expect(fs.snapshot()).toEqual(before);
  });

  it("proves a scope empty even when that scope produced no records", async () => {
    // Without the `listScopesWithShards` pass, a scope whose every record was deleted
    // never appears in the sweep's own output, so its shard set is never rewritten
    // and its records stay claimed — and undeletable — forever.
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Util" }),
        requestFor({ sysId: HELPER, displayName: "Helper", scope: APP_SCOPE }),
      ],
      { sweepId: "sweep-1" }
    );
    expect(shardRecords(fs, APP_SCOPE).has(HELPER)).toBe(true);

    const { completion } = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { sweepId: "sweep-2" }
    );

    const authority = completion.authority;
    expect(authority?.has(APP_SCOPE, HELPER)).toBe(true);
    expect(authority?.authorize(APP_SCOPE, HELPER).scope).toBe(APP_SCOPE);
    // Named by the scope it was stale in, and not reachable under any other — the
    // record only ever existed in `x_acme_tools`.
    expect(authority?.has(GLOBAL, HELPER)).toBe(false);
    expect(shardRecords(fs, APP_SCOPE).size).toBe(0);
  });

  it("does not authorise a record that merely moved to another name", async () => {
    // A renamed record is absent from its old path but present in the sweep, so it is
    // an update and not a deletion — a rule that has to be stated, because the naive
    // "the baseline claimed a path nothing occupies now" test would delete the record
    // and then re-add it under the new name on the same commit.
    const fs = new MemoryFs();
    const before = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { sweepId: "sweep-1" }
    );
    const after = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Renamed Util" })],
      { sweepId: "sweep-2" }
    );

    expect(after.completion.authority?.size).toBe(0);
    expect(after.outcomes[0].path).not.toBe(before.outcomes[0].path);
    expect(shardRecords(fs, GLOBAL).get(UTIL)?.path).toBe(after.outcomes[0].path);
  });
});

describe("a renamed record leaves nothing of itself behind", () => {
  const RENAMED = [requestFor({ sysId: UTIL, displayName: "Renamed Util" })];

  it("produces the tree a first-time sweep of the same instance would (full)", async () => {
    // INV-1 read the way that matters operationally: the mirror is a function of the
    // instance, not of the mirror's own history. A record whose display name changes
    // is written under its new name — and the directory it left must go, or the tree
    // keeps a stale copy of the record forever: same sys_id, wrong name, wrong
    // content, claimed by no shard, and invisible to every consistency check that
    // starts from the shard set.
    const rewritten = new MemoryFs();
    await sweep(rewritten, [requestFor({ sysId: UTIL, displayName: "Util" })], {
      sweepId: "sweep-1",
    });
    await sweep(rewritten, RENAMED, { sweepId: "sweep-2" });

    const fresh = new MemoryFs();
    await sweep(fresh, RENAMED, { sweepId: "sweep-2" });

    expect(rewritten.snapshot()).toEqual(fresh.snapshot());
    expect(rewritten.paths()).toEqual(fresh.paths());
  });

  it("produces the tree a first-time sweep would (incremental, via rename)", async () => {
    // Same property through the other mechanism: an incremental sweep seeds the
    // resolver from the baseline, so the rename is reported and the directory moves.
    // Both paths have to arrive at the same tree, or the mirror's shape depends on
    // which sweep mode happened to notice the change. The fresh-world comparator is
    // a FULL sweep: a first-time incremental has no baseline and correctly flushes
    // an incomplete shard, so its bytes differ in exactly that claim — the
    // incremental world here has full-sweep knowledge underneath, and the fresh
    // world must too for the trees to be comparable.
    const rewritten = new MemoryFs();
    await sweep(rewritten, [requestFor({ sysId: UTIL, displayName: "Util" })], {
      sweepId: "sweep-1",
    });
    await sweep(rewritten, RENAMED, { sweepId: "sweep-2", mode: "incremental" });

    const fresh = new MemoryFs();
    await sweep(fresh, RENAMED, { sweepId: "sweep-2" });

    expect(rewritten.snapshot()).toEqual(fresh.snapshot());
  });

  it("renames a baseline record whose directory was deleted behind its back", async () => {
    // The rename path has to survive the old directory not being there. It is not a
    // hypothetical: an incremental sweep seeds the resolver from the baseline shard,
    // which describes what the PREVIOUS run wrote — and between the two runs a human
    // can `rm -rf` a record, a partial checkout can omit it, or a merge can drop it.
    // If a later record then collides with its name, the writer is asked to move a
    // directory that does not exist.
    //
    // A `rename(2)` on a missing source raises ENOENT, so without the readDir check
    // one absent directory would abort the whole sweep — and an aborted sweep is not
    // a complete one, so INV-4 keeps its shard set at the previous run forever and
    // the mirror silently stops advancing until someone deletes the tree by hand.
    const fs = new MemoryFs();
    const { outcomes } = await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util" })],
      { sweepId: "sweep-1" }
    );
    const vanished = outcomes[0].path;
    expect(fs.paths()).toContain(vanished);
    await fs.removeRecursive(toNativePath(fs.root, vanished));
    expect(fs.paths()).not.toContain(vanished);

    const second = await sweep(fs, [requestFor({ sysId: HELPER, displayName: "Util" })], {
      sweepId: "sweep-2",
      mode: "incremental",
    });

    // The collision resolved: neither record kept the bare name.
    const claimed = shardRecords(fs, GLOBAL);
    expect([...claimed.keys()].sort()).toEqual([UTIL, HELPER].sort());
    expect(claimed.get(UTIL)?.path).not.toBe(vanished);
    expect(claimed.get(UTIL)?.path).not.toBe(claimed.get(HELPER)?.path);

    // The record that WAS written this sweep is on disk under its resolved name, and
    // no staging leftover was stranded by the skipped move.
    expect(fs.text(`${second.outcomes[0].path}/record.json`)).not.toBeNull();
    expect(stagingPathsIn(fs)).toEqual([]);

    // And the honest part: UTIL's entry now names a path with nothing behind it. The
    // writer cannot do better — an incremental sweep never fetched UTIL, so it holds
    // no bytes to rewrite — and inventing an empty directory would be worse, because
    // a directory with no `record.json` is indistinguishable from a truncated write.
    // Reconciling that is `repair`'s job, which is why it re-downloads what the
    // manifest claims and the tree lacks rather than trusting either one alone.
    expect(fs.text(`${claimed.get(UTIL)?.path}/record.json`)).toBeNull();
  });

  it("keeps a vacated directory that another record has taken over", async () => {
    // The dangerous case for any "clean up what I left" rule: two records swap names
    // in one sweep. Each vacates a directory the other now occupies, so a writer that
    // removed a vacated path unconditionally would delete a record it had just
    // written — and the shard set would claim a directory that no longer exists.
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Alpha" }),
        requestFor({ sysId: HELPER, displayName: "Beta" }),
      ],
      { sweepId: "sweep-1" }
    );
    const { outcomes } = await sweep(
      fs,
      [
        requestFor({ sysId: UTIL, displayName: "Beta", script: "gs.info('alpha');" }),
        requestFor({ sysId: HELPER, displayName: "Alpha", script: "gs.info('beta');" }),
      ],
      { sweepId: "sweep-2" }
    );

    const claimed = shardRecords(fs, GLOBAL);
    expect([...claimed.keys()].sort()).toEqual([UTIL, HELPER].sort());
    for (const outcome of outcomes) {
      expect(fs.paths()).toContain(outcome.path);
      expect(fs.text(`${outcome.path}/record.json`)).not.toBeNull();
      expect(claimed.get(outcome.sysId)?.path).toBe(outcome.path);
    }
    expect(outcomes[0].path).not.toBe(outcomes[1].path);
    expect(fs.text(`${outcomes[0].path}/script.js`)).toBe("gs.info('alpha');\n");
    expect(fs.text(`${outcomes[1].path}/script.js`)).toBe("gs.info('beta');\n");
  });
});

describe("attachments the sweep hands over (WP-M12)", () => {
  const ATT_A = sysIdFor("attachment-a");
  const ATT_B = sysIdFor("attachment-b");
  const attachmentDir = `attachments/${TABLE}/${UTIL}`;

  const payload = (sysId: string, fileName: string, size: number): AttachmentPayload => ({
    sysId,
    fileName,
    bytes: new Uint8Array(size).fill(0x41),
  });

  it("writes the binary beside the tree and lists it in the shard entry", async () => {
    const fs = new MemoryFs();
    await sweep(fs, [
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        attachments: [payload(ATT_A, "spec.pdf", 6)],
      }),
    ]);

    expect(fs.text(`${attachmentDir}/${ATT_A}_spec.pdf`)).toBe("AAAAAA");
    expect(shardRecords(fs, GLOBAL).get(UTIL)?.attachments).toEqual([
      {
        sysId: ATT_A,
        fileName: "spec.pdf",
        sizeBytes: 6,
        sha256: createHash("sha256").update(Buffer.from("AAAAAA")).digest("hex"),
        lfs: false,
      },
    ]);
  });

  it("keeps attachments out of the record directory the pruner owns", async () => {
    // The record directory is pruned down to `record.json` plus the extracted
    // fields on every write. An attachment written there would be deleted by the
    // very next sweep of the same record — silently, since the shard would still
    // claim it.
    const fs = new MemoryFs();
    const { outcomes } = await sweep(fs, [
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        attachments: [payload(ATT_A, "spec.pdf", 6)],
      }),
    ]);

    expect(fs.text(`${outcomes[0].path}/${ATT_A}_spec.pdf`)).toBeNull();
    expect(outcomes[0].path.startsWith("instance/")).toBe(true);
  });

  it("routes an attachment at or above the threshold to LFS", async () => {
    const fs = new MemoryFs();
    await sweep(
      fs,
      [
        requestFor({
          sysId: UTIL,
          displayName: "Util",
          attachments: [payload(ATT_A, "small.bin", 7), payload(ATT_B, "big.bin", 8)],
        }),
      ],
      { lfsThresholdBytes: 8 }
    );

    const listed = shardRecords(fs, GLOBAL).get(UTIL)?.attachments ?? [];
    expect(new Map(listed.map((item) => [item.fileName, item.lfs]))).toEqual(
      new Map([
        ["small.bin", false],
        ["big.bin", true],
      ])
    );
    expect(fs.text(`${attachmentDir}/.gitattributes`)).toContain(
      `${ATT_B}_* filter=lfs`
    );
  });

  it("omits the key entirely for a record with no attachments", async () => {
    // "Absent in, absent out" — the shard parser treats a missing key and an
    // empty array as the same fact, so writing `[]` would put a key in every
    // entry of every table for nothing, on a file that is committed.
    const fs = new MemoryFs();
    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util", attachments: [] })]);

    expect(shardRecords(fs, GLOBAL).get(UTIL)).not.toHaveProperty("attachments");
  });

  it("rewrites a record whose attachments changed but whose columns did not", async () => {
    // An attachment lives in `sys_attachment`, so adding one does not touch the
    // parent record's `sys_updated_on` or `sys_mod_count`. Without the attachment
    // list in the unchanged comparison, the shortcut would report this record
    // unchanged on this sweep and on every sweep after it.
    const fs = new MemoryFs();
    const base = { sysId: UTIL, displayName: "Util" };
    await sweep(fs, [requestFor({ ...base, attachments: [] })]);

    const { outcomes } = await sweep(
      fs,
      [requestFor({ ...base, attachments: [payload(ATT_A, "late.pdf", 4)] })],
      { sweepId: "sweep-2" }
    );

    expect(outcomes[0].status).toBe("written");
    expect(fs.text(`${attachmentDir}/${ATT_A}_late.pdf`)).toBe("AAAA");
  });

  it("takes the shortcut when the attachments are identical too", async () => {
    const fs = new MemoryFs();
    const withAttachment = requestFor({
      sysId: UTIL,
      displayName: "Util",
      attachments: [payload(ATT_A, "spec.pdf", 6)],
    });
    await sweep(fs, [withAttachment]);

    const { outcomes } = await sweep(fs, [withAttachment], { sweepId: "sweep-2" });
    expect(outcomes[0].status).toBe("unchanged");
  });

  it("removes an attachment the instance no longer has", async () => {
    const fs = new MemoryFs();
    await sweep(fs, [
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        attachments: [payload(ATT_A, "spec.pdf", 6)],
      }),
    ]);

    await sweep(fs, [requestFor({ sysId: UTIL, displayName: "Util", attachments: [] })], {
      sweepId: "sweep-2",
    });

    expect(fs.text(`${attachmentDir}/${ATT_A}_spec.pdf`)).toBeNull();
    expect(shardRecords(fs, GLOBAL).get(UTIL)).not.toHaveProperty("attachments");
  });

  it("leaves mirrored attachments alone when the sweep did not fetch any", async () => {
    // A sweep run with attachments disabled knows nothing about attachments. It
    // must not conclude from its own silence that the record has none, or turning
    // the feature off for one run would delete every attachment the mirror holds.
    const fs = new MemoryFs();
    await sweep(fs, [
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        attachments: [payload(ATT_A, "spec.pdf", 6)],
      }),
    ]);

    await sweep(
      fs,
      [requestFor({ sysId: UTIL, displayName: "Util", script: "gs.info('changed');" })],
      { sweepId: "sweep-2" }
    );

    expect(fs.text(`${attachmentDir}/${ATT_A}_spec.pdf`)).toBe("AAAAAA");
  });

  it("produces a byte-identical tree on a re-sweep (INV-1)", async () => {
    const requests = [
      requestFor({
        sysId: UTIL,
        displayName: "Util",
        attachments: [payload(ATT_B, "b.bin", 9), payload(ATT_A, "a.bin", 3)],
      }),
      requestFor({
        sysId: HELPER,
        displayName: "Helper",
        attachments: [payload(ATT_A, "a.bin", 3)],
      }),
    ];
    const first = new MemoryFs();
    await sweep(first, requests, { lfsThresholdBytes: 8 });
    const second = new MemoryFs();
    await sweep(second, [...requests].reverse(), { lfsThresholdBytes: 8 });

    expect([...second.snapshot()]).toEqual([...first.snapshot()]);
  });
});

describe("the fake filesystem is not the thing under test", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "syncrona-writer-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("produces on a real disk exactly the tree the fake produced", async () => {
    // Everything above trusts `MemoryFs` to behave like a filesystem. This is the
    // only test that can catch the fake being wrong — and with it, an assertion
    // above that holds only because the fake was lenient about renames, parents or
    // recursive removal.
    const fixtures = [
      requestFor({ sysId: UTIL, displayName: "Shared Name" }),
      requestFor({ sysId: HELPER, displayName: "Shared Name", scope: APP_SCOPE }),
      requestFor({ sysId: EXTRA, displayName: "Shared Name" }),
    ];
    const memory = new MemoryFs();
    await sweep(memory, fixtures, { sweepId: "sweep-1" });

    const real = { ...nodeWriterFs(), root: workspace };
    const { completion } = await sweep(real, fixtures, { sweepId: "sweep-1" });

    expect(await realTreeOf(workspace)).toEqual(memory.snapshot());

    // And the deletion path behaves the same against a real `rename`.
    const { completion: second } = await sweep(
      real,
      [requestFor({ sysId: UTIL, displayName: "Shared Name" })],
      { sweepId: "sweep-2" }
    );
    expect(completion.authority?.size).toBe(0);
    const authority = second.authority;
    if (authority === null) {
      throw new Error("a completed full sweep must mint an authority");
    }
    const removed = await applyAuthorizedDeletion(real, workspace, authority, GLOBAL, EXTRA);
    const tree = await realTreeOf(workspace);
    expect([...tree.keys()].some((path) => path.startsWith(`${removed.path}/`))).toBe(
      false
    );
    expect([...tree.keys()].some((path) => path.split("/").some(isStagingName))).toBe(
      false
    );
  });

  it("defaults to the real filesystem when no seam is supplied", async () => {
    // Everything else in this file injects an `fs`, which means the default is the
    // one code path the whole suite could be green without exercising — and it is
    // the path every real caller takes. A default that had drifted (or that a
    // refactor had left as a no-op stub) would be invisible here and would show up
    // as a CLI that reports a successful sweep and writes nothing.
    const writer = new MirrorWriter({ root: workspace, sweepId: "sweep-1" });
    const table = writer.beginTable(TABLE);
    const outcome = await table.writeRecord(
      requestFor({ sysId: UTIL, displayName: "Default Seam" })
    );
    await table.completeTable();

    const tree = await realTreeOf(workspace);
    expect(tree.has(`${outcome.path}/record.json`)).toBe(true);
    expect([...tree.keys()].some((path) => path.split("/").includes(SHARD_DIR_NAME))).toBe(
      true
    );
  });
});

/** Repo-relative path → bytes for a real directory, in the same shape as the fake. */
async function realTreeOf(root: string): Promise<Map<string, Uint8Array>> {
  const collected: Array<[string, Uint8Array]> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else {
        collected.push([relative, new Uint8Array(await readFile(absolute))]);
      }
    }
  };
  await walk(root, "");
  collected.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return new Map(collected);
}
