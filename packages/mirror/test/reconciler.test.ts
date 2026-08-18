// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reconciler — INV-5 at the module boundary (WP-M10, §5.9).
 *
 * The property under test is asymmetric on purpose: a deletion needs a completed
 * full sweep's authority or a tombstone seconded by a targeted GET, while a
 * refusal needs nothing — so the suite's centre of gravity is the refusals. Every
 * flavour of incomplete evidence (partial, failed, watermark, not-attempted,
 * absent-from-sweep) gets its own test proving ZERO deletions and a NAMED refusal
 * row, each paired against a control where the same disk state WITH authority
 * does delete — so the tests witness that the evidence, not the disk, is what
 * decides.
 *
 * The tombstone ladder (§5.9: advisory, never a blind delete) is walked one rung
 * per test: invalid input stops before any I/O, a full-sweep table supersedes the
 * advice, an unmirrored record needs no GET, a non-empty page keeps the record, a
 * failed GET keeps the record with the failure class named, and only the
 * two-witness case (tombstone + empty primary-key GET) deletes — through the
 * package's single deletion path, observable here as the atomic staging rename.
 *
 * The fake filesystem is the house one: unhelpful on purpose (writes need their
 * parent directory, listings arrive DESCENDING so no sorted assertion can pass by
 * accident) and it logs every call, which is what turns "no shard file was
 * touched" and "the hostile sys_id never reached the filesystem" into assertions
 * rather than hopes. Shard seeding goes through the production `writeShardSet`
 * and verification through the production `loadShardSet`, so the tests cannot
 * drift from the real on-disk format.
 */
import { createHash } from "node:crypto";
import { sep } from "node:path";

import type { RecordEntry, TablePage } from "../src/contracts";
import type { PageRequest } from "../src/http/client";
import { MirrorHttpError } from "../src/http/client";
import {
  MirrorPathRejection,
  ShardManifestCorrupt,
  recordDirRelPath,
} from "../src/shards/shardLayout";
import { loadShardSet, writeShardSet } from "../src/shards/shardStore";
import type { DanglingReference } from "../src/derived/refsView";
import type { TableSweepEvidence, TombstoneAdvisory } from "../src/sync/reconciler";
import { reconcileSweep } from "../src/sync/reconciler";
import type { FetcherPageSource } from "../src/sync/fetcher";
import { STAGING_PREFIX } from "../src/write/atomicWrite";
import { attachmentDirRelPath } from "../src/write/attachments";
import type { SweptScopeEvidence } from "../src/write/deletionAuthority";
import { DeletionAuthority } from "../src/write/deletionAuthority";
import type { WriterDirEntry, WriterFs } from "../src/write/fs";
import { toNativePath } from "../src/write/fs";

/** Virtual repository root; every path in this file hangs off it. */
const ROOT = `${sep}mirror-root`;
const SCOPE = "global";
const TABLE = "sys_script_include";
const SWEEP = "sweep-2026-08-18T12:00:00Z";

// ---------------------------------------------------------------------------
// In-memory filesystem (house pattern; directory renames added because the
// deletion path removes record directories via the atomic staging rename)
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
    if (!this.dirs.has(parentOf(to))) {
      throw new MemoryFsError(`ENOENT: no directory holds ${to}`);
    }
    const bytes = this.files.get(from);
    if (bytes !== undefined) {
      this.files.delete(from);
      this.files.set(to, bytes);
      return;
    }
    if (!this.dirs.has(from)) {
      throw new MemoryFsError(`ENOENT: nothing to rename at ${from}`);
    }
    const prefix = `${from}${sep}`;
    for (const [filePath, content] of [...this.files]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
        this.files.set(`${to}${filePath.slice(from.length)}`, content);
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
// Scripted page source — the injectable stand-in for the GET-only seam
// ---------------------------------------------------------------------------

type ProbeResult = { page: TablePage } | { throws: Error };

/**
 * Answers targeted existence checks from a script keyed by (table, extraQuery)
 * and records every call. An unscripted GET fails the test loudly, which is
 * what makes "this disposition needs NO network" assertable: hand the ladder an
 * empty script and any GET at all is a failure.
 */
class ScriptedProbe implements FetcherPageSource {
  readonly calls: Array<{ table: string; cursor: string | null; request: PageRequest }> = [];
  private readonly results: Map<string, ProbeResult>;

  constructor(results?: Map<string, ProbeResult>) {
    this.results = results ?? new Map();
  }

  async getPage(table: string, cursor: string | null, request: PageRequest): Promise<TablePage> {
    this.calls.push({ table, cursor, request });
    const key = `${table} ${request.extraQuery ?? ""}`;
    const result = this.results.get(key);
    if (result === undefined) {
      throw new Error(`ScriptedProbe: unscripted GET for ${key}`);
    }
    if ("throws" in result) {
      throw result.throws;
    }
    return result.page;
  }
}

function probeFor(entries: Array<[table: string, sysId: string, result: ProbeResult]>): ScriptedProbe {
  const results = new Map<string, ProbeResult>();
  for (const [table, sysId, result] of entries) {
    results.set(`${table} sys_id=${sysId}`, result);
  }
  return new ScriptedProbe(results);
}

function emptyPage(): TablePage {
  return { rows: [], lastSysId: null, done: true };
}

function pageWith(sysId: string): TablePage {
  return { rows: [{ sys_id: sysId }], lastSysId: sysId, done: true };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic, seed-derived sys_ids — valid under INV-6 by construction. */
function sysIdFor(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, 32);
}

function entryFor(args: {
  scope?: string;
  table?: string;
  sysId: string;
  name: string;
}): RecordEntry {
  const scope = args.scope ?? SCOPE;
  const table = args.table ?? TABLE;
  return {
    path: recordDirRelPath({ scope, table, sysId: args.sysId, name: args.name }),
    name: args.name,
    sysUpdatedOn: "2026-08-01 10:00:00",
    sysUpdatedBy: "admin",
    sysModCount: 3,
    contentHash: createHash("sha256").update(`content:${args.sysId}`).digest("hex"),
    files: ["record.json"],
  };
}

const encoder = new TextEncoder();

/** Put the record's directory (and one file in it) on the virtual disk. */
async function seedRecordDir(fs: MemoryFs, entry: RecordEntry): Promise<void> {
  const dir = toNativePath(ROOT, entry.path);
  await fs.makeDir(dir);
  await fs.writeFile(`${dir}${sep}record.json`, encoder.encode("{}"));
}

/** Seed a shard set through the production writer path, never by hand. */
async function seedShards(
  fs: MemoryFs,
  args: {
    scope?: string;
    table?: string;
    entries: Map<string, RecordEntry>;
    complete?: boolean;
  }
): Promise<void> {
  await writeShardSet(fs, {
    root: ROOT,
    scope: args.scope ?? SCOPE,
    table: args.table ?? TABLE,
    fanout: 0,
    complete: args.complete ?? true,
    sweepId: "sweep-prior",
    entries: args.entries,
  });
}

function recordDirExists(fs: MemoryFs, entry: RecordEntry): boolean {
  return fs.dirs.has(toNativePath(ROOT, entry.path));
}

/**
 * Put one attachment binary where design §8.4 says it lives, and answer its path.
 *
 * The directory is derived through the production `attachmentDirRelPath` rather
 * than spelled out here: `attachments/` sits OUTSIDE `instance/`, so a test that
 * restated the layout could keep passing against a tree whose real attachments
 * the deletion never touched.
 */
async function seedAttachmentDir(
  fs: MemoryFs,
  args: { table?: string; sysId: string }
): Promise<string> {
  const dir = toNativePath(ROOT, attachmentDirRelPath(args.table ?? TABLE, args.sysId));
  await fs.makeDir(dir);
  const filePath = `${dir}${sep}${args.sysId}_report.pdf`;
  await fs.writeFile(filePath, encoder.encode("%PDF-1.7"));
  return filePath;
}

function attachmentDirExists(fs: MemoryFs, sysId: string, table = TABLE): boolean {
  return fs.dirs.has(toNativePath(ROOT, attachmentDirRelPath(table, sysId)));
}

function fullSweep(table: string, scopes: SweptScopeEvidence[]): TableSweepEvidence {
  return {
    kind: "full-sweep",
    authority: DeletionAuthority.fromCompletedSweep({
      table,
      sweepId: SWEEP,
      complete: true,
      scopes,
    }),
  };
}

function base(fs: MemoryFs): { fs: WriterFs; root: string; sweepId: string } {
  return { fs, root: ROOT, sweepId: SWEEP };
}

/** Overwrite every shard file of one scope's set with bytes that parse as nothing. */
function corruptShardFiles(fs: MemoryFs, scope: string, table: string): void {
  const shardDir = toNativePath(ROOT, `instance/${scope}/${table}/.shards`);
  let corrupted = 0;
  for (const filePath of [...fs.files.keys()]) {
    if (filePath.startsWith(`${shardDir}${sep}`)) {
      fs.files.set(filePath, encoder.encode("not a shard manifest"));
      corrupted += 1;
    }
  }
  expect(corrupted).toBeGreaterThan(0);
}

/** One record seeded on disk and in shards; the common starting position. */
async function seedOneRecord(
  fs: MemoryFs,
  args: { scope?: string; table?: string; label: string; name: string; complete?: boolean }
): Promise<{ sysId: string; entry: RecordEntry }> {
  const sysId = sysIdFor(args.label);
  const entry = entryFor({ scope: args.scope, table: args.table, sysId, name: args.name });
  await seedRecordDir(fs, entry);
  await seedShards(fs, {
    scope: args.scope,
    table: args.table,
    entries: new Map([[sysId, entry]]),
    complete: args.complete,
  });
  return { sysId, entry };
}

// ---------------------------------------------------------------------------
// A. INV-5 — incomplete evidence never deletes, and every refusal is named
// ---------------------------------------------------------------------------

describe("INV-5: incomplete evidence never deletes", () => {
  async function assertRefused(
    evidence: TableSweepEvidence,
    expected: { reason: string; detailHas: string[] }
  ): Promise<void> {
    const fs = new MemoryFs();
    const { entry } = await seedOneRecord(fs, { label: "vanished", name: "dead_record" });
    const before = fs.calls.length;

    const result = await reconcileSweep({ ...base(fs), evidence: [evidence] });

    expect(result.deletions).toEqual([]);
    expect(result.reconciled).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal.table).toBe(TABLE);
    expect(refusal.reason).toBe(expected.reason);
    for (const fragment of expected.detailHas) {
      expect(refusal.detail).toContain(fragment);
    }
    expect(recordDirExists(fs, entry)).toBe(true);
    const touched = fs.calls.slice(before);
    expect(touched.some((call) => call.startsWith("removeRecursive"))).toBe(false);
    expect(touched.some((call) => call.startsWith("writeFile"))).toBe(false);
  }

  it("a partial sweep is refused with its coverage reason", async () => {
    await assertRefused(
      { kind: "partial", table: TABLE, reason: "acl-403" },
      { reason: "sweep-partial", detailHas: ["acl-403", "could not see"] }
    );
  });

  it("a failed sweep is refused with its coverage reason", async () => {
    await assertRefused(
      { kind: "failed", table: TABLE, reason: "transient-exhausted" },
      { reason: "sweep-failed", detailHas: ["transient-exhausted", "proves nothing"] }
    );
  });

  it("a failed sweep with no assigned reason is still a named refusal", async () => {
    await assertRefused(
      { kind: "failed", table: TABLE, reason: null },
      { reason: "sweep-failed", detailHas: ["proves nothing"] }
    );
    // The detail must not render a literal "null" where a reason would go.
    const fs = new MemoryFs();
    await seedOneRecord(fs, { label: "vanished", name: "dead_record" });
    const result = await reconcileSweep({
      ...base(fs),
      evidence: [{ kind: "failed", table: TABLE, reason: null }],
    });
    expect(result.refusals[0].detail).not.toContain("null");
  });

  it("watermark evidence is refused: filtered silence is not absence", async () => {
    await assertRefused(
      { kind: "watermark", table: TABLE },
      { reason: "watermark-silence", detailHas: ["not changed", "not there"] }
    );
  });

  it("a table the run never reached is refused as not-attempted", async () => {
    await assertRefused(
      { kind: "not-attempted", table: TABLE },
      { reason: "not-attempted", detailHas: ["never reached"] }
    );
  });

  it("a table on disk with no evidence at all is refused as not-in-sweep", async () => {
    const fs = new MemoryFs();
    const { entry } = await seedOneRecord(fs, { label: "vanished", name: "dead_record" });

    const result = await reconcileSweep({ ...base(fs), evidence: [] });

    expect(result.deletions).toEqual([]);
    expect(result.refusals).toEqual([
      {
        table: TABLE,
        reason: "not-in-sweep",
        detail: expect.stringContaining("absence from a plan is not absence from the instance"),
      },
    ]);
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it("control: the same disk state WITH full-sweep authority deletes", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "vanished", name: "dead_record" });

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          { scope: SCOPE, baseline: new Map([[sysId, entry]]), observed: new Map() },
        ]),
      ],
    });

    expect(result.deletions).toEqual([
      { table: TABLE, scope: SCOPE, sysId, path: entry.path, via: "full-sweep" },
    ]);
    expect(result.reconciled).toEqual([TABLE]);
    expect(result.refusals).toEqual([]);
    expect(recordDirExists(fs, entry)).toBe(false);
  });

  it("every evidence table lands in exactly one of reconciled and refusals", async () => {
    const fs = new MemoryFs();
    await seedOneRecord(fs, { label: "unswept", name: "orphan_record", table: "sys_ux_lib" });

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, []),
        { kind: "watermark", table: "sys_ui_action" },
        { kind: "not-attempted", table: "sys_properties" },
      ],
    });

    const accounted = [...result.reconciled, ...result.refusals.map((row) => row.table)].sort();
    expect(accounted).toEqual(["sys_properties", "sys_script_include", "sys_ui_action", "sys_ux_lib"]);
    expect(result.reconciled).toEqual([TABLE]);
  });
});

// ---------------------------------------------------------------------------
// B. Full-sweep deletions — the diff leg of §5.9
// ---------------------------------------------------------------------------

describe("full-sweep deletions", () => {
  it("deletes the vanished record through the authority and leaves the survivor alone", async () => {
    const fs = new MemoryFs();
    const gone = sysIdFor("gone");
    const stays = sysIdFor("stays");
    const goneEntry = entryFor({ sysId: gone, name: "dead_record" });
    const staysEntry = entryFor({ sysId: stays, name: "live_record" });
    await seedRecordDir(fs, goneEntry);
    await seedRecordDir(fs, staysEntry);
    await seedShards(fs, {
      entries: new Map([
        [gone, goneEntry],
        [stays, staysEntry],
      ]),
    });
    const before = fs.calls.length;

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([
              [gone, goneEntry],
              [stays, staysEntry],
            ]),
            observed: new Map([[stays, staysEntry]]),
          },
        ]),
      ],
    });

    expect(result.deletions).toEqual([
      { table: TABLE, scope: SCOPE, sysId: gone, path: goneEntry.path, via: "full-sweep" },
    ]);
    expect(result.reconciled).toEqual([TABLE]);
    expect(result.refusals).toEqual([]);
    expect(result.shardsRewritten).toEqual([]);
    expect(recordDirExists(fs, goneEntry)).toBe(false);
    expect(recordDirExists(fs, staysEntry)).toBe(true);

    const touched = fs.calls.slice(before);
    // The writer owns full-sweep shard flushes; the reconciler writes nothing here.
    expect(touched.some((call) => call.startsWith("writeFile"))).toBe(false);
    // Every removal went through the atomic staging rename — the single
    // deletion path — never a direct recursive delete of a live path.
    const removals = touched.filter((call) => call.startsWith("removeRecursive"));
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((call) => call.includes(STAGING_PREFIX))).toBe(true);
  });

  it("takes the deleted record's attachment bytes with it and leaves the survivor's", async () => {
    const fs = new MemoryFs();
    const gone = sysIdFor("gone");
    const stays = sysIdFor("stays");
    const goneEntry = entryFor({ sysId: gone, name: "dead_record" });
    const staysEntry = entryFor({ sysId: stays, name: "live_record" });
    await seedRecordDir(fs, goneEntry);
    await seedRecordDir(fs, staysEntry);
    const goneBlob = await seedAttachmentDir(fs, { sysId: gone });
    const staysBlob = await seedAttachmentDir(fs, { sysId: stays });
    await seedShards(fs, {
      entries: new Map([
        [gone, goneEntry],
        [stays, staysEntry],
      ]),
    });
    const before = fs.calls.length;

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([
              [gone, goneEntry],
              [stays, staysEntry],
            ]),
            observed: new Map([[stays, staysEntry]]),
          },
        ]),
      ],
    });

    expect(result.deletions).toHaveLength(1);
    // A record's bytes and its attachment bytes leave together. `attachments/`
    // is outside `instance/` (design §8.4), so no later sweep of the table ever
    // walks past this directory to reclaim it, and `verify` walks from the
    // manifests inward and so cannot even NAME a directory no entry points at —
    // which makes an orphan here exactly the unclaimed content INV-4 forbids.
    expect(recordDirExists(fs, goneEntry)).toBe(false);
    expect(attachmentDirExists(fs, gone)).toBe(false);
    expect(fs.files.has(goneBlob)).toBe(false);
    // The survivor keeps both halves; the removal is scoped to one record.
    expect(recordDirExists(fs, staysEntry)).toBe(true);
    expect(attachmentDirExists(fs, stays)).toBe(true);
    expect(fs.files.has(staysBlob)).toBe(true);

    // Both removals went through the same staged path — two of them, never a
    // direct recursive delete of a live directory.
    const removals = fs.calls
      .slice(before)
      .filter((call) => call.startsWith("removeRecursive"));
    expect(removals).toHaveLength(2);
    expect(removals.every((call) => call.includes(STAGING_PREFIX))).toBe(true);
  });

  it("a record with no attachments costs one listing and no removal", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "gone", name: "dead_record" });
    const before = fs.calls.length;

    await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([[sysId, entry]]),
            observed: new Map<string, RecordEntry>(),
          },
        ]),
      ],
    });

    // `atomicRemoveDir` answers `null` from `readDir` and stops, so the common
    // case — most records have no attachments at all — pays one listing and
    // mutates nothing. Asserted so the sweep-wide cost of this fix is pinned
    // rather than assumed.
    expect(recordDirExists(fs, entry)).toBe(false);
    const touched = fs.calls.slice(before);
    expect(
      touched.filter((call) => call === `readDir ${toNativePath(ROOT, attachmentDirRelPath(TABLE, sysId))}`)
    ).toHaveLength(1);
    expect(touched.filter((call) => call.startsWith("removeRecursive"))).toHaveLength(1);
  });

  it("an empty authority reconciles the table with zero deletions", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "stays", name: "live_record" });

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([[sysId, entry]]),
            observed: new Map([[sysId, entry]]),
          },
        ]),
      ],
    });

    expect(result.reconciled).toEqual([TABLE]);
    expect(result.deletions).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it("orders deletions by table, scope, sys_id regardless of evidence order", async () => {
    const fs = new MemoryFs();
    const tables = ["sys_ui_action", "sys_script_include"] as const;
    const scopes = ["x_scope", "global"] as const;
    const seeded: Array<{ table: string; scope: string; sysId: string; entry: RecordEntry }> = [];
    for (const table of tables) {
      for (const scope of scopes) {
        const sysId = sysIdFor(`${table}:${scope}:gone`);
        const entry = entryFor({ scope, table, sysId, name: `dead_${scope}` });
        await seedRecordDir(fs, entry);
        await seedShards(fs, { scope, table, entries: new Map([[sysId, entry]]) });
        seeded.push({ table, scope, sysId, entry });
      }
    }
    const evidenceFor = (table: string): TableSweepEvidence =>
      fullSweep(
        table,
        seeded
          .filter((row) => row.table === table)
          .map((row) => ({
            scope: row.scope,
            baseline: new Map([[row.sysId, row.entry]]),
            observed: new Map<string, RecordEntry>(),
          }))
      );

    // Evidence deliberately in reverse-sorted table order.
    const result = await reconcileSweep({
      ...base(fs),
      evidence: [evidenceFor("sys_ui_action"), evidenceFor("sys_script_include")],
    });

    expect(result.reconciled).toEqual(["sys_script_include", "sys_ui_action"]);
    expect(result.deletions.map((row) => `${row.table}/${row.scope}`)).toEqual([
      "sys_script_include/global",
      "sys_script_include/x_scope",
      "sys_ui_action/global",
      "sys_ui_action/x_scope",
    ]);
    for (const row of seeded) {
      expect(recordDirExists(fs, row.entry)).toBe(false);
    }
  });

  it("orders two deletions inside one scope by sys_id", async () => {
    const fs = new MemoryFs();
    const idA = sysIdFor("gone-a");
    const idB = sysIdFor("gone-b");
    const entryA = entryFor({ sysId: idA, name: "dead_a" });
    const entryB = entryFor({ sysId: idB, name: "dead_b" });
    await seedRecordDir(fs, entryA);
    await seedRecordDir(fs, entryB);
    await seedShards(fs, {
      entries: new Map([
        [idA, entryA],
        [idB, entryB],
      ]),
    });

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([
              [idA, entryA],
              [idB, entryB],
            ]),
            observed: new Map<string, RecordEntry>(),
          },
        ]),
      ],
    });

    expect(result.deletions.map((row) => row.sysId)).toEqual([idA, idB].sort());
    expect(recordDirExists(fs, entryA)).toBe(false);
    expect(recordDirExists(fs, entryB)).toBe(false);
  });

  it("throws on two evidence entries naming the same table", async () => {
    const fs = new MemoryFs();
    await expect(
      reconcileSweep({
        ...base(fs),
        evidence: [
          { kind: "watermark", table: TABLE },
          { kind: "not-attempted", table: TABLE },
        ],
      })
    ).rejects.toThrow(`reconcile evidence names ${TABLE} twice`);
  });
});

// ---------------------------------------------------------------------------
// C. Tombstones — advisory, confirmed by a targeted GET, never blind (§5.9)
// ---------------------------------------------------------------------------

describe("tombstone advisory", () => {
  /** Watermark evidence for TABLE: the §5.9 setting in which tombstones matter. */
  const watermarkEvidence: TableSweepEvidence[] = [{ kind: "watermark", table: TABLE }];

  it("deletes when the tombstone is seconded by an empty primary-key GET", async () => {
    const fs = new MemoryFs();
    const dead = sysIdFor("tombstoned");
    const live = sysIdFor("bystander");
    const deadEntry = entryFor({ sysId: dead, name: "tomb_target" });
    const liveEntry = entryFor({ sysId: live, name: "bystander_record" });
    await seedRecordDir(fs, deadEntry);
    await seedRecordDir(fs, liveEntry);
    await seedShards(fs, {
      entries: new Map([
        [dead, deadEntry],
        [live, liveEntry],
      ]),
    });
    const probe = probeFor([[TABLE, dead, { page: emptyPage() }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId: dead }], source: probe },
    });

    // The GET is targeted: primary-key filter, one row, sys_id only (INV-2).
    expect(probe.calls).toEqual([
      {
        table: TABLE,
        cursor: null,
        request: { fields: ["sys_id"], extraQuery: `sys_id=${dead}`, pageSize: 1 },
      },
    ]);
    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId: dead,
        disposition: "deleted",
        detail: expect.stringContaining("removed 1 stale copy"),
      },
    ]);
    expect(result.deletions).toEqual([
      { table: TABLE, scope: SCOPE, sysId: dead, path: deadEntry.path, via: "tombstone" },
    ]);
    expect(recordDirExists(fs, deadEntry)).toBe(false);
    expect(recordDirExists(fs, liveEntry)).toBe(true);

    // The shard set was rewritten without the entry — and its standing survives:
    // `complete` and the fanout are preserved, the bystander is untouched.
    expect(result.shardsRewritten.length).toBeGreaterThan(0);
    const reloaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(reloaded.entries.has(dead)).toBe(false);
    expect(reloaded.entries.has(live)).toBe(true);
    expect(reloaded.complete).toBe(true);
    expect(reloaded.fanout).toBe(0);
  });

  it("keeps the record when the instance still returns it", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
    const probe = probeFor([[TABLE, sysId, { page: pageWith(sysId) }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
    });

    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId,
        disposition: "still-present",
        detail: expect.stringContaining("still returns"),
      },
    ]);
    expect(result.deletions).toEqual([]);
    expect(result.shardsRewritten).toEqual([]);
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it.each(["transient", "acl"] as const)(
    "a %s failure on the confirming GET is not authority to delete",
    async (failureClass) => {
      const fs = new MemoryFs();
      const { sysId, entry } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
      const probe = probeFor([
        [TABLE, sysId, { throws: new MirrorHttpError(failureClass, "confirm blew up") }],
      ]);

      const result = await reconcileSweep({
        ...base(fs),
        evidence: watermarkEvidence,
        advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
      });

      expect(result.tombstones).toEqual([
        {
          table: TABLE,
          sysId,
          disposition: "confirm-failed",
          failureClass,
          detail: expect.stringContaining("a failed read is not evidence of absence"),
        },
      ]);
      expect(result.deletions).toEqual([]);
      expect(recordDirExists(fs, entry)).toBe(true);
    }
  );

  it("rethrows a non-MirrorHttpError from the page source", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
    const probe = probeFor([[TABLE, sysId, { throws: new TypeError("socket hang up") }]]);

    await expect(
      reconcileSweep({
        ...base(fs),
        evidence: watermarkEvidence,
        advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
      })
    ).rejects.toThrow(TypeError);
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it("a record no shard set claims needs no GET at all", async () => {
    const fs = new MemoryFs();
    await seedOneRecord(fs, { label: "bystander", name: "bystander_record" });
    const probe = new ScriptedProbe();

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: {
        tombstones: [{ table: TABLE, sysId: sysIdFor("never-mirrored") }],
        source: probe,
      },
    });

    expect(result.tombstones[0].disposition).toBe("not-mirrored");
    expect(result.deletions).toEqual([]);
    expect(probe.calls).toEqual([]);
  });

  it("a full-sweep table supersedes its tombstones without a GET", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "stays", name: "live_record" });
    const probe = new ScriptedProbe();

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [
        fullSweep(TABLE, [
          {
            scope: SCOPE,
            baseline: new Map([[sysId, entry]]),
            observed: new Map([[sysId, entry]]),
          },
        ]),
      ],
      advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
    });

    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId,
        disposition: "superseded",
        detail: expect.stringContaining("already decided every deletion"),
      },
    ]);
    expect(probe.calls).toEqual([]);
    // The stale advice lost to the fresher diff: the record stays.
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it("a sys_id failing INV-6 is refused before any I/O", async () => {
    const fs = new MemoryFs();
    await seedOneRecord(fs, { label: "bystander", name: "bystander_record" });
    const probe = new ScriptedProbe();
    const before = fs.calls.length;

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: {
        tombstones: [{ table: TABLE, sysId: "DEADBEEF; DROP TABLE" }],
        source: probe,
      },
    });

    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId: "DEADBEEF; DROP TABLE",
        disposition: "invalid",
        detail: expect.stringContaining("INV-6"),
      },
    ]);
    expect(probe.calls).toEqual([]);
    // The disk enumeration for not-in-sweep still runs; what must never happen
    // is the hostile value reaching a filesystem path.
    const touched = fs.calls.slice(before);
    expect(touched.every((call) => !call.includes("DEADBEEF"))).toBe(true);
    expect(touched.some((call) => call.startsWith("removeRecursive"))).toBe(false);
    expect(result.deletions).toEqual([]);
  });

  it("a table name unusable as a path component is refused before any I/O", async () => {
    const fs = new MemoryFs();
    const probe = new ScriptedProbe();
    const before = fs.calls.length;

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [],
      advisory: {
        tombstones: [{ table: "../../etc", sysId: sysIdFor("hostile") }],
        source: probe,
      },
    });

    expect(result.tombstones).toEqual([
      {
        table: "../../etc",
        sysId: sysIdFor("hostile"),
        disposition: "invalid",
        detail: expect.stringContaining("unusable table"),
      },
    ]);
    expect(probe.calls).toEqual([]);
    // The traversal fragment must never appear in any filesystem path.
    expect(fs.calls.slice(before).every((call) => !call.includes(".."))).toBe(true);
  });

  it("one confirmation removes every scope's stale copy of a moved record", async () => {
    const fs = new MemoryFs();
    const dead = sysIdFor("moved-then-deleted");
    const copyA = entryFor({ scope: "global", sysId: dead, name: "moved_record" });
    const copyB = entryFor({ scope: "x_moved", sysId: dead, name: "moved_record" });
    await seedRecordDir(fs, copyA);
    await seedRecordDir(fs, copyB);
    await seedShards(fs, { scope: "global", entries: new Map([[dead, copyA]]) });
    await seedShards(fs, { scope: "x_moved", entries: new Map([[dead, copyB]]) });
    const probe = probeFor([[TABLE, dead, { page: emptyPage() }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId: dead }], source: probe },
    });

    expect(probe.calls).toHaveLength(1);
    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId: dead,
        disposition: "deleted",
        detail: expect.stringContaining("removed 2 stale copies"),
      },
    ]);
    expect(result.deletions.map((row) => row.scope)).toEqual(["global", "x_moved"]);
    expect(recordDirExists(fs, copyA)).toBe(false);
    expect(recordDirExists(fs, copyB)).toBe(false);
    const reloadedA = await loadShardSet(fs, ROOT, "global", TABLE);
    const reloadedB = await loadShardSet(fs, ROOT, "x_moved", TABLE);
    expect(reloadedA.entries.size).toBe(0);
    expect(reloadedB.entries.size).toBe(0);
  });

  it("refuses when another record claims the same directory (rule-2 hazard)", async () => {
    const fs = new MemoryFs();
    const dead = sysIdFor("renamed-away");
    const usurper = sysIdFor("renamed-into");
    // Same folded name → recordDirRelPath derives the same directory for both.
    const deadEntry = entryFor({ sysId: dead, name: "shared_name" });
    const usurperEntry = entryFor({ sysId: usurper, name: "shared_name" });
    await seedRecordDir(fs, deadEntry);
    await seedShards(fs, {
      entries: new Map([
        [dead, deadEntry],
        [usurper, usurperEntry],
      ]),
    });
    const probe = new ScriptedProbe();

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId: dead }], source: probe },
    });

    expect(result.tombstones).toEqual([
      {
        table: TABLE,
        sysId: dead,
        disposition: "path-conflict",
        detail: expect.stringContaining(usurper),
      },
    ]);
    // Refused before the GET: no page source call, no deletion, directory intact.
    expect(probe.calls).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(recordDirExists(fs, deadEntry)).toBe(true);
  });

  it("duplicate advisories collapse to one outcome and one GET", async () => {
    const fs = new MemoryFs();
    const { sysId } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
    const probe = probeFor([[TABLE, sysId, { page: emptyPage() }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: {
        tombstones: [
          { table: TABLE, sysId },
          { table: TABLE, sysId },
          { table: TABLE, sysId },
        ],
        source: probe,
      },
    });

    expect(result.tombstones).toHaveLength(1);
    expect(result.tombstones[0].disposition).toBe("deleted");
    expect(probe.calls).toHaveLength(1);
  });

  it("an incomplete baseline still honours a confirmed tombstone and stays incomplete", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, {
      label: "tombstoned",
      name: "tomb_target",
      complete: false,
    });
    const probe = probeFor([[TABLE, sysId, { page: emptyPage() }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
    });

    expect(result.tombstones[0].disposition).toBe("deleted");
    expect(recordDirExists(fs, entry)).toBe(false);
    // Preserved, not promoted: removing a proven-dead record is not a full sweep.
    const reloaded = await loadShardSet(fs, ROOT, SCOPE, TABLE);
    expect(reloaded.complete).toBe(false);
  });

  it("a shard entry whose path lies is stopped by the deletion path, loudly", async () => {
    const fs = new MemoryFs();
    const dead = sysIdFor("tombstoned");
    const honest = entryFor({ sysId: dead, name: "tomb_target" });
    // The committed shard claims a DIFFERENT directory than the entry's own
    // name derives — the hand-edit `applyAuthorizedDeletion` re-derivation exists for.
    const lying: RecordEntry = {
      ...honest,
      path: recordDirRelPath({ scope: SCOPE, table: TABLE, sysId: dead, name: "other_name" }),
    };
    await seedRecordDir(fs, lying);
    await seedShards(fs, { entries: new Map([[dead, lying]]) });
    const probe = probeFor([[TABLE, dead, { page: emptyPage() }]]);

    await expect(
      reconcileSweep({
        ...base(fs),
        evidence: watermarkEvidence,
        advisory: { tombstones: [{ table: TABLE, sysId: dead }], source: probe },
      })
    ).rejects.toThrow(MirrorPathRejection);
    expect(recordDirExists(fs, lying)).toBe(true);
  });

  it("a confirmed tombstone removes the record's attachment bytes too", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, {
      label: "tombstoned",
      name: "tomb_target",
    });
    const blob = await seedAttachmentDir(fs, { sysId });
    const probe = probeFor([[TABLE, sysId, { page: emptyPage() }]]);

    const result = await reconcileSweep({
      ...base(fs),
      evidence: watermarkEvidence,
      advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
    });

    // The tombstone leg deletes through the same `applyAuthorizedDeletion`, so
    // it inherits the attachment removal rather than needing its own — asserted
    // here because "inherits" is a claim about a call site, not about a type.
    expect(result.tombstones[0].disposition).toBe("deleted");
    expect(recordDirExists(fs, entry)).toBe(false);
    expect(attachmentDirExists(fs, sysId)).toBe(false);
    expect(fs.files.has(blob)).toBe(false);
  });

  it("a refused removal leaves the attachment bytes exactly where they were", async () => {
    const fs = new MemoryFs();
    const dead = sysIdFor("tombstoned");
    const honest = entryFor({ sysId: dead, name: "tomb_target" });
    const lying: RecordEntry = {
      ...honest,
      path: recordDirRelPath({ scope: SCOPE, table: TABLE, sysId: dead, name: "other_name" }),
    };
    await seedRecordDir(fs, lying);
    const blob = await seedAttachmentDir(fs, { sysId: dead });
    await seedShards(fs, { entries: new Map([[dead, lying]]) });
    const probe = probeFor([[TABLE, dead, { page: emptyPage() }]]);
    const before = fs.calls.length;

    await expect(
      reconcileSweep({
        ...base(fs),
        evidence: watermarkEvidence,
        advisory: { tombstones: [{ table: TABLE, sysId: dead }], source: probe },
      })
    ).rejects.toThrow(MirrorPathRejection);

    // The path check runs before any removal, so a refusal is total: neither
    // half of the record is touched. Ordering matters here — attachments are
    // removed first so that an F8 failure between the two leaves the record
    // directory and its shard entry standing and a re-run repeats both
    // (idempotent) removals; a refusal must precede even that first step.
    expect(recordDirExists(fs, lying)).toBe(true);
    expect(attachmentDirExists(fs, dead)).toBe(true);
    expect(fs.files.has(blob)).toBe(true);
    const touched = fs.calls.slice(before);
    expect(touched.filter((call) => call.startsWith("removeRecursive"))).toEqual([]);
    expect(touched.filter((call) => call.startsWith("rename"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. Corrupt shards — throw where a deletion would follow, refuse where not
// ---------------------------------------------------------------------------

describe("corrupt shard manifests", () => {
  it("a corrupt baseline under a tombstone throws instead of reading as empty", async () => {
    const fs = new MemoryFs();
    const { sysId, entry } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
    corruptShardFiles(fs, SCOPE, TABLE);
    const probe = probeFor([[TABLE, sysId, { page: emptyPage() }]]);

    await expect(
      reconcileSweep({
        ...base(fs),
        evidence: [{ kind: "watermark", table: TABLE }],
        advisory: { tombstones: [{ table: TABLE, sysId }], source: probe },
      })
    ).rejects.toThrow(ShardManifestCorrupt);
    expect(recordDirExists(fs, entry)).toBe(true);
  });

  it("the same corruption in a merely-unswept table is a calm not-in-sweep refusal", async () => {
    const fs = new MemoryFs();
    const { entry } = await seedOneRecord(fs, { label: "tombstoned", name: "tomb_target" });
    corruptShardFiles(fs, SCOPE, TABLE);

    const result = await reconcileSweep({ ...base(fs), evidence: [] });

    expect(result.refusals).toEqual([
      { table: TABLE, reason: "not-in-sweep", detail: expect.any(String) },
    ]);
    expect(result.deletions).toEqual([]);
    expect(recordDirExists(fs, entry)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disk enumeration for not-in-sweep — hostile and racy directory shapes
// ---------------------------------------------------------------------------

describe("on-disk table enumeration", () => {
  it("skips staging names, plain files, shardless tables, and dedupes across scopes", async () => {
    const fs = new MemoryFs();
    // The real thing, twice — one table with shards in two scopes → ONE refusal.
    await seedOneRecord(fs, { label: "a", name: "rec_a", scope: "global" });
    await seedOneRecord(fs, { label: "b", name: "rec_b", scope: "x_two" });
    // A staging scope and a staging table: leftovers, not observations.
    await fs.makeDir(toNativePath(ROOT, `instance/${STAGING_PREFIX}scope/junk/.shards`));
    await fs.makeDir(toNativePath(ROOT, `instance/global/${STAGING_PREFIX}table/.shards`));
    // A stray file where a scope directory would be.
    await fs.writeFile(toNativePath(ROOT, "instance/stray.txt"), encoder.encode("x"));
    // A table directory with no shard set: records nobody indexed are not a table.
    await fs.makeDir(toNativePath(ROOT, "instance/global/sys_no_shards/some_record"));

    const result = await reconcileSweep({ ...base(fs), evidence: [] });

    expect(result.refusals).toEqual([
      { table: TABLE, reason: "not-in-sweep", detail: expect.any(String) },
    ]);
  });

  it("a scope directory that vanishes between the two listings is skipped, not fatal", async () => {
    const fs = new MemoryFs();
    await seedOneRecord(fs, { label: "a", name: "rec_a", scope: "global" });
    const vanishing = toNativePath(ROOT, "instance/global");
    const racyFs: WriterFs = {
      makeDir: (dir) => fs.makeDir(dir),
      writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
      rename: (from, to) => fs.rename(from, to),
      readFile: (filePath) => fs.readFile(filePath),
      readDir: (dir) => (dir === vanishing ? Promise.resolve(null) : fs.readDir(dir)),
      removeRecursive: (target) => fs.removeRecursive(target),
    };

    const result = await reconcileSweep({ fs: racyFs, root: ROOT, sweepId: SWEEP, evidence: [] });

    expect(result.refusals).toEqual([]);
    expect(result.deletions).toEqual([]);
  });

  it("no instance directory at all reconciles to an all-empty result", async () => {
    const fs = new MemoryFs();

    const result = await reconcileSweep({ ...base(fs), evidence: [] });

    expect(result).toEqual({
      reconciled: [],
      deletions: [],
      refusals: [],
      tombstones: [],
      shardsRewritten: [],
      danglingRefsByTable: {},
    });
  });
});

// ---------------------------------------------------------------------------
// F. Dangling references — D2 counts folded for coverage, never acted on
// ---------------------------------------------------------------------------

describe("dangling reference counts", () => {
  function danglingRef(table: string, seed: string): DanglingReference {
    return {
      scope: SCOPE,
      table,
      sysId: sysIdFor(`src:${seed}`),
      field: "assignment_group",
      targetTable: "sys_user_group",
      targetSysId: sysIdFor(`target:${seed}`),
    };
  }

  it("folds the list into per-table counts with sorted keys", async () => {
    const fs = new MemoryFs();

    const result = await reconcileSweep({
      ...base(fs),
      evidence: [],
      danglingRefs: [
        danglingRef("task", "t1"),
        danglingRef("incident", "i1"),
        danglingRef("incident", "i2"),
      ],
    });

    expect(result.danglingRefsByTable).toEqual({ incident: 2, task: 1 });
    expect(Object.keys(result.danglingRefsByTable)).toEqual(["incident", "task"]);
    // Reported, never repaired: counting refs performs no deletions and no writes.
    expect(result.deletions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. Determinism — permuted inputs, identical results, identical GET sequence
// ---------------------------------------------------------------------------

describe("determinism", () => {
  interface Scenario {
    fs: MemoryFs;
    probe: ScriptedProbe;
    evidence: TableSweepEvidence[];
    tombstones: TombstoneAdvisory[];
    danglingRefs: DanglingReference[];
  }

  async function buildScenario(reversed: boolean): Promise<Scenario> {
    const fs = new MemoryFs();
    const t1 = sysIdFor("tomb-confirmed");
    const t2 = sysIdFor("tomb-still-there");
    const t1Entry = entryFor({ sysId: t1, name: "tomb_one" });
    const t2Entry = entryFor({ sysId: t2, name: "tomb_two" });
    await seedRecordDir(fs, t1Entry);
    await seedRecordDir(fs, t2Entry);
    await seedShards(fs, {
      entries: new Map([
        [t1, t1Entry],
        [t2, t2Entry],
      ]),
    });
    const gone = sysIdFor("ui-gone");
    const goneEntry = entryFor({ table: "sys_ui_action", sysId: gone, name: "ui_dead" });
    await seedRecordDir(fs, goneEntry);
    await seedShards(fs, { table: "sys_ui_action", entries: new Map([[gone, goneEntry]]) });

    const probe = probeFor([
      [TABLE, t1, { page: emptyPage() }],
      [TABLE, t2, { page: pageWith(t2) }],
    ]);
    const evidence: TableSweepEvidence[] = [
      { kind: "watermark", table: TABLE },
      fullSweep("sys_ui_action", [
        {
          scope: SCOPE,
          baseline: new Map([[gone, goneEntry]]),
          observed: new Map<string, RecordEntry>(),
        },
      ]),
      { kind: "not-attempted", table: "sys_ux_lib" },
    ];
    const tombstones: TombstoneAdvisory[] = [
      { table: TABLE, sysId: t2 },
      { table: TABLE, sysId: t1 },
      { table: TABLE, sysId: t2 },
    ];
    const danglingRefs: DanglingReference[] = [
      {
        scope: SCOPE,
        table: "task",
        sysId: sysIdFor("dr1"),
        field: "parent",
        targetTable: "task",
        targetSysId: sysIdFor("dr1-target"),
      },
      {
        scope: SCOPE,
        table: "incident",
        sysId: sysIdFor("dr2"),
        field: "caller_id",
        targetTable: "sys_user",
        targetSysId: sysIdFor("dr2-target"),
      },
    ];
    if (reversed) {
      evidence.reverse();
      tombstones.reverse();
      danglingRefs.reverse();
    }
    return { fs, probe, evidence, tombstones, danglingRefs };
  }

  it("permuted inputs produce a deep-equal result and the same GET sequence", async () => {
    const forward = await buildScenario(false);
    const backward = await buildScenario(true);

    const run = (scenario: Scenario) =>
      reconcileSweep({
        fs: scenario.fs,
        root: ROOT,
        sweepId: SWEEP,
        evidence: scenario.evidence,
        advisory: { tombstones: scenario.tombstones, source: scenario.probe },
        danglingRefs: scenario.danglingRefs,
      });

    const resultForward = await run(forward);
    const resultBackward = await run(backward);

    expect(resultBackward).toEqual(resultForward);
    // Not just the report: the SEQUENCE of network calls is input-order-free.
    expect(backward.probe.calls).toEqual(forward.probe.calls);
    // And the scenario exercised all three legs at once, so the equality means something.
    expect(resultForward.deletions.map((row) => row.via).sort()).toEqual([
      "full-sweep",
      "tombstone",
    ]);
    // Outcomes are (table, sysId)-sorted; the two hashes' relative order is
    // incidental, so assert the pair of dispositions, not their sequence.
    expect(resultForward.tombstones.map((row) => row.disposition).sort()).toEqual([
      "deleted",
      "still-present",
    ]);
    expect(resultForward.refusals.map((row) => row.reason)).toEqual([
      "watermark-silence",
      "not-attempted",
    ]);
  });
});
