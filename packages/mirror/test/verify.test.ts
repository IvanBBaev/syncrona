// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Verifier — `mirror verify` (§5.10, WP-M11).
 *
 * The whole suite runs against the recording in-memory filesystem, and every
 * fixture tree is written by the REAL shard store and hashed for real
 * (`plantRecord`), so a passing check means the verifier agrees with the
 * writer, not with a hand-rolled imitation. Damage is then planted by editing
 * the fake's backing maps directly — edits the call log never sees — which
 * keeps the log clean for the suite's central assertion:
 *
 * - §12 WP-M11: "verify reports and provably performs zero writes (fs spy)" —
 *   `mutatingCalls(fs)` must come back EMPTY after every verify run, clean or
 *   damaged, while read lines prove the walk actually happened. The seam-level
 *   half of the proof (`readOnlyWriterFs` detonating on any mutator) gets its
 *   own unit test at the bottom.
 *
 * The rest of the suite pins the reporting vocabulary one finding kind at a
 * time — a planted `record.json` corruption is detected AND named with both
 * hashes, every-Kth sampling is exact (K=2 provably misses what K=1 catches),
 * and the walk refuses damage the way the shard reader prescribes:
 * INV-5 (a corrupt pair gets a finding and NO outcome row — never "0 records,
 * verified"), INV-4 (completion read off `complete`; a set whose shard files
 * provably carry DIFFERENT sweepIds — asserted test-side by parsing them — is
 * ordinary steady state and yields zero findings).
 */
import type { RecordEntry } from "../src/contracts";
import {
  buildShardManifest,
  parseShardManifest,
  renderShardManifest,
  shardFileName,
} from "../src/shards/shardLayout";
import {
  MirrorReadOnlyViolation,
  readOnlyWriterFs,
} from "../src/status/readOnlyFs";
import { verifyMirror, type MirrorVerifyResult } from "../src/status/verifier";
import { STAGING_PREFIX } from "../src/write/atomicWrite";
import {
  MemoryFs,
  ROOT,
  mutatingCalls,
  plantRecord,
  relToNative,
  resetCalls,
  seedDir,
  seedFile,
  sha256HexOf,
  testSysId,
  writeShardFixture,
} from "./statusFixtures";

/** A clean single-scope pair: three planted records, manifests via the store. */
async function plantCleanPair(
  fs: MemoryFs,
  table: string
): Promise<Map<string, RecordEntry>> {
  const entries = new Map<string, RecordEntry>([
    await plantRecord(fs, { scope: "global", table, sysId: testSysId(1) }),
    await plantRecord(fs, {
      scope: "global",
      table,
      sysId: testSysId(2),
      files: { "script.js": "answer();\n" },
    }),
    await plantRecord(fs, {
      scope: "global",
      table,
      sysId: testSysId(3),
      attachments: [
        { sysId: testSysId(0x31), fileName: "logo.png", body: "png-bytes" },
      ],
    }),
  ]);
  await writeShardFixture(fs, { scope: "global", table, entries });
  return entries;
}

describe("mirror verify — clean trees and the zero-writes proof", () => {
  it("verifies a clean pair with zero findings and provably zero writes (§12)", async () => {
    const fs = new MemoryFs();
    await plantCleanPair(fs, "x_syn_clean");
    resetCalls(fs);
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result).toEqual<MirrorVerifyResult>({
      tables: [
        {
          scope: "global",
          table: "x_syn_clean",
          complete: true,
          recordsClaimed: 3,
          recordsSampled: 3,
          findings: 0,
        },
      ],
      findings: [],
      exitCode: 0,
    });
    // The fs spy: the walk really read things, and mutated nothing.
    expect(fs.calls.some((line) => line.startsWith("readFile "))).toBe(true);
    expect(fs.calls.some((line) => line.startsWith("readDir "))).toBe(true);
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("reports an empty mirror as an empty result, not an error", async () => {
    const fs = new MemoryFs();
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result).toEqual({ tables: [], findings: [], exitCode: 0 });
  });

  it("reports a checkpointed (complete: false) pair in the outcome, not as a finding (INV-4)", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_checkpoint";
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, { scope: "global", table, sysId: testSysId(7) }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries, complete: false });
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.tables).toEqual([
      {
        scope: "global",
        table,
        complete: false,
        recordsClaimed: 1,
        recordsSampled: 1,
        findings: 0,
      },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("treats a shard set whose files carry different sweepIds as ordinary steady state (INV-4)", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_sweeps";
    const lowId = testSysId(1);
    const highId = `f${"0".repeat(31)}`;
    const [, lowEntry] = await plantRecord(fs, { scope: "global", table, sysId: lowId });
    const [, highEntry] = await plantRecord(fs, { scope: "global", table, sysId: highId });
    await writeShardFixture(fs, {
      scope: "global",
      table,
      entries: new Map([
        [lowId, lowEntry],
        [highId, highEntry],
      ]),
      fanout: 1,
      sweepId: "sweep-alpha",
    });
    // The incremental sweep: only the f bucket's content moves, so the store
    // rewrites that one shard under the new sweepId and SKIPS the rest — the
    // documented restamp-avoidance that makes mixed sweepIds the steady state.
    await writeShardFixture(fs, {
      scope: "global",
      table,
      entries: new Map([
        [lowId, lowEntry],
        [highId, { ...highEntry, sysUpdatedOn: "2026-03-04 05:06:07" }],
      ]),
      fanout: 1,
      sweepId: "sweep-beta",
    });
    const shardText = (key: string): string =>
      Buffer.from(
        fs.files.get(
          relToNative(`instance/global/${table}/.shards/${shardFileName(key, 1)}`)
        ) as Uint8Array
      ).toString("utf8");
    // Proof the fixture is what INV-4 talks about: the sweepIds really differ.
    expect(parseShardManifest(shardText("0"), "0.json").sweepId).toBe("sweep-alpha");
    expect(parseShardManifest(shardText("f"), "f.json").sweepId).toBe("sweep-beta");

    resetCalls(fs);
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([]);
    expect(result.tables).toEqual([
      {
        scope: "global",
        table,
        complete: true,
        recordsClaimed: 2,
        recordsSampled: 2,
        findings: 0,
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("walks past staging leftovers, unsafe names and shard-less directories without inventing findings", async () => {
    const fs = new MemoryFs();
    // None of these is mirror content, and none is this command's to judge:
    await seedDir(fs, `instance/${STAGING_PREFIX}scope`); // crashed write, scope level
    await seedDir(fs, "instance/global/..."); // unsafe name: writer cannot have made it
    await seedDir(fs, `instance/global/${STAGING_PREFIX}tbl`); // crashed write, table level
    await seedDir(fs, "instance/global/empty_shards/.shards"); // shard dir, no shard files
    await seedDir(fs, "instance/global/no_shards_dir"); // table dir, no shard dir
    await seedDir(fs, "instance/global/staging_only/.shards/subdir"); // dir inside .shards
    await seedFile(
      fs,
      `instance/global/staging_only/.shards/${STAGING_PREFIX}crash`,
      Buffer.from("{}", "utf8")
    );
    await seedFile(
      fs,
      "instance/global/staging_only/.shards/notes.txt",
      Buffer.from("not a shard", "utf8")
    );
    await seedFile(fs, "instance/stray.txt", Buffer.from("stray", "utf8")); // file at scope level
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result).toEqual({ tables: [], findings: [], exitCode: 0 });
  });

  it("rejects an invalid sampling interval as a caller bug", async () => {
    const fs = new MemoryFs();
    for (const sampleEvery of [0, 2.5]) {
      await expect(verifyMirror({ fs, root: ROOT, sampleEvery })).rejects.toThrow(
        "verify sampling interval must be an integer >= 1"
      );
    }
  });

  it("propagates an unexpected filesystem failure instead of converting it into a finding", async () => {
    const base = new MemoryFs();
    await plantCleanPair(base, "x_syn_onfire");
    const firewalled = {
      readFile: (filePath: string): Promise<Uint8Array | null> => {
        if (filePath.endsWith("all.json")) {
          return Promise.reject(new Error("disk on fire"));
        }
        return base.readFile(filePath);
      },
      readDir: (dir: string) => base.readDir(dir),
    };
    await expect(
      verifyMirror({ fs: firewalled, root: ROOT, sampleEvery: 1 })
    ).rejects.toThrow("disk on fire");
  });
});

describe("mirror verify — content findings", () => {
  it("detects a planted record.json corruption and names both hashes (§12)", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_bitrot";
    const entries = await plantCleanPair(fs, table);
    const victim = testSysId(2);
    const claimed = (entries.get(victim) as RecordEntry).contentHash;
    const corrupted = Buffer.from('{"sys_id":"tampered"}\n', "utf8");
    // Direct map edit: no fs call is logged, so the zero-writes assertion
    // below still covers the verify run alone.
    fs.files.set(
      relToNative(`instance/global/${table}/${victim}/record.json`),
      corrupted
    );
    resetCalls(fs);
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "content-hash-mismatch",
        scope: "global",
        table,
        sysId: victim,
        path: `instance/global/${table}/${victim}/record.json`,
        detail: expect.stringContaining(claimed),
      },
    ]);
    expect(result.findings[0].detail).toContain(sha256HexOf(corrupted));
    expect(result.tables[0].findings).toBe(1);
    expect(result.exitCode).toBe(2);
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("samples every Kth claimed record: K=2 provably misses what K=1 catches", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_kth";
    await plantCleanPair(fs, table);
    // Damage the MIDDLE record of the three (bytewise order): K=2 samples
    // indices 0 and 2, so the damage sits exactly in the gap.
    fs.files.set(
      relToNative(`instance/global/${table}/${testSysId(2)}/record.json`),
      Buffer.from("gap damage", "utf8")
    );

    const sparse = await verifyMirror({ fs, root: ROOT, sampleEvery: 2 });
    expect(sparse.findings).toEqual([]);
    expect(sparse.tables[0].recordsSampled).toBe(2);
    expect(sparse.exitCode).toBe(0);

    const full = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(full.findings).toHaveLength(1);
    expect(full.findings[0].kind).toBe("content-hash-mismatch");
    expect(full.exitCode).toBe(2);

    const sparser = await verifyMirror({ fs, root: ROOT, sampleEvery: 5 });
    expect(sparser.tables[0].recordsSampled).toBe(1);
    expect(sparser.exitCode).toBe(0);
  });

  it("reports a hand-deleted record directory once, as record-dir-missing", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_deleted";
    await plantCleanPair(fs, table);
    const victim = testSysId(1);
    const dirRel = `instance/global/${table}/${victim}`;
    fs.dirs.delete(relToNative(dirRel));
    fs.files.delete(relToNative(`${dirRel}/record.json`));
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "record-dir-missing",
        scope: "global",
        table,
        sysId: victim,
        path: dirRel,
        detail: expect.stringContaining(victim),
      },
    ]);
    // Selected but not re-read: the one finding already says everything.
    expect(result.tables[0].recordsSampled).toBe(3);
    expect(result.exitCode).toBe(2);
  });

  it("reports a missing record.json under a present directory as record-json-missing", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_gutted";
    const entries = await plantCleanPair(fs, table);
    const victim = testSysId(3);
    fs.files.delete(relToNative(`instance/global/${table}/${victim}/record.json`));
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    // The gutted record still lists an attachment; only the record.json check
    // may fail here, and the attachment check still runs and passes.
    expect(result.findings).toEqual([
      {
        kind: "record-json-missing",
        scope: "global",
        table,
        sysId: victim,
        path: `instance/global/${table}/${victim}/record.json`,
        detail: expect.stringContaining(
          (entries.get(victim) as RecordEntry).contentHash
        ),
      },
    ]);
    expect(result.exitCode).toBe(2);
  });

  it("reports a listed extracted file that is not on disk, and only that one", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_extracted";
    const sysId = testSysId(0xe1);
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, {
        scope: "global",
        table,
        sysId,
        files: { "kept.js": "still here\n" },
        filesListedButAbsent: ["gone.js"],
      }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries });
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "extracted-file-missing",
        scope: "global",
        table,
        sysId,
        path: `instance/global/${table}/${sysId}/gone.js`,
        detail: expect.stringContaining("gone.js"),
      },
    ]);
    expect(result.exitCode).toBe(2);
  });

  it("never reads an extracted file whose manifest name would escape the record directory", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_hostile";
    const sysId = testSysId(0xf1);
    const [, entry] = await plantRecord(fs, { scope: "global", table, sysId });
    // Plantable for real — a shard file is committed to git, so this is content an
    // attacker can put in front of `verify`. `parseShardManifest` holds every member
    // of `files` to the same component rule as `name`, so the manifest is refused
    // WHOLE rather than one entry at a time: the finding names the shard, not the
    // record, and no entry from it is walked at all.
    await writeShardFixture(fs, {
      scope: "global",
      table,
      entries: new Map([[sysId, { ...entry, files: ["../evil"] }]]),
    });
    resetCalls(fs);
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "shard-corrupt",
        scope: "global",
        table,
        sysId: null,
        path: `instance/global/${table}/.shards/all.json`,
        detail: expect.stringContaining('"../evil"'),
      },
    ]);
    expect(result.exitCode).toBe(2);
    // The point of the whole test: no logged call ever touched a path containing
    // the hostile name. Rejecting the shard is only better than defending at the
    // read if the read genuinely never happens.
    expect(fs.calls.some((line) => line.includes("evil"))).toBe(false);
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("checks attachments: present-and-matching, missing, and hash-mismatching", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_attach";
    const sysId = testSysId(0xa0);
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, {
        scope: "global",
        table,
        sysId,
        attachments: [
          { sysId: testSysId(0xa1), fileName: "ok.pdf", body: "fine bytes" },
          { sysId: testSysId(0xa2), fileName: "lost.pdf", body: "never written", absent: true },
          { sysId: testSysId(0xa3), fileName: "rotten.pdf", body: "actual bytes", sha256: "0".repeat(64) },
        ],
      }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries });
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "attachment-missing",
        scope: "global",
        table,
        sysId,
        path: `attachments/${table}/${sysId}/${testSysId(0xa2)}_lost.pdf`,
        detail: expect.stringContaining("lost.pdf"),
      },
      {
        kind: "attachment-hash-mismatch",
        scope: "global",
        table,
        sysId,
        path: `attachments/${table}/${sysId}/${testSysId(0xa3)}_rotten.pdf`,
        detail: expect.stringContaining("0".repeat(64)),
      },
    ]);
    expect(result.tables[0].findings).toBe(2);
    expect(result.exitCode).toBe(2);
  });

  it("checks LFS attachments for existence only — a pointer file cannot be hash-checked", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_lfs";
    const sysId = testSysId(0xb0);
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, {
        scope: "global",
        table,
        sysId,
        attachments: [
          // Present with a WRONG recorded hash: lfs means the disk bytes may be
          // a pointer text, so no hash finding may be raised.
          { sysId: testSysId(0xb1), fileName: "big.bin", body: "pointer text", sha256: "f".repeat(64), lfs: true },
          // Absent is still absent, lfs or not.
          { sysId: testSysId(0xb2), fileName: "big2.bin", body: "", lfs: true, absent: true },
        ],
      }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries });
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "attachment-missing",
        scope: "global",
        table,
        sysId,
        path: `attachments/${table}/${sysId}/${testSysId(0xb2)}_big2.bin`,
        detail: expect.stringContaining("big2.bin"),
      },
    ]);
    expect(result.exitCode).toBe(2);
  });

  it("reports children no manifest claims, in bytewise order, skipping staging leftovers", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_orphans";
    const claimed = testSysId(0xc1);
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, { scope: "global", table, sysId: claimed }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries });
    await seedDir(fs, `instance/global/${table}/zz_orphan`);
    await seedFile(fs, `instance/global/${table}/notes.txt`, Buffer.from("n", "utf8"));
    await seedFile(
      fs,
      `instance/global/${table}/${STAGING_PREFIX}leftover`,
      Buffer.from("crash", "utf8")
    );
    // A FILE wearing the claimed record's name: the claim is for a directory,
    // so the file is unclaimed even though the name matches.
    fs.files.set(relToNative(`instance/global/${table}/${claimed}`), Buffer.from("imposter", "utf8"));
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "unclaimed-path",
        scope: "global",
        table,
        sysId: null,
        path: `instance/global/${table}/${claimed}`,
        detail: expect.stringContaining(claimed),
      },
      {
        kind: "unclaimed-path",
        scope: "global",
        table,
        sysId: null,
        path: `instance/global/${table}/notes.txt`,
        detail: expect.stringContaining("notes.txt"),
      },
      {
        kind: "unclaimed-path",
        scope: "global",
        table,
        sysId: null,
        path: `instance/global/${table}/zz_orphan`,
        detail: expect.stringContaining("zz_orphan"),
      },
    ]);
    expect(result.tables[0].recordsSampled).toBe(1);
    expect(result.exitCode).toBe(2);
  });
});

describe("mirror verify — damaged shard sets (INV-5)", () => {
  it("gives a corrupt pair a finding and NO outcome row, and keeps walking", async () => {
    const fs = new MemoryFs();
    await seedFile(
      fs,
      "instance/global/aaa_corrupt/.shards/all.json",
      Buffer.from("not json", "utf8")
    );
    await plantCleanPair(fs, "bbb_ok");
    resetCalls(fs);
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "shard-corrupt",
        scope: "global",
        table: "aaa_corrupt",
        sysId: null,
        path: "instance/global/aaa_corrupt/.shards/all.json",
        detail: expect.stringContaining("unusable"),
      },
    ]);
    // INV-5: no outcome row for the corrupt pair — never "0 records, verified".
    expect(result.tables).toEqual([
      {
        scope: "global",
        table: "bbb_ok",
        complete: true,
        recordsClaimed: 3,
        recordsSampled: 3,
        findings: 0,
      },
    ]);
    expect(result.exitCode).toBe(2);
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("gives a fan-out-conflicted pair a finding naming the shard directory, and no outcome row", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_conflicted";
    const entries = new Map<string, RecordEntry>([
      await plantRecord(fs, { scope: "global", table, sysId: testSysId(5) }),
    ]);
    await writeShardFixture(fs, { scope: "global", table, entries, fanout: 0 });
    // A second shard file at a different fan-out, through the real renderer so
    // only the conflict is synthetic, not the file format.
    await seedFile(
      fs,
      `instance/global/${table}/.shards/0.json`,
      renderShardManifest(
        buildShardManifest({
          table,
          shardKey: "0",
          fanout: 1,
          complete: true,
          sweepId: "sweep-other",
          records: {},
        })
      )
    );
    const result = await verifyMirror({ fs, root: ROOT, sampleEvery: 1 });
    expect(result.findings).toEqual([
      {
        kind: "shard-fanout-conflict",
        scope: "global",
        table,
        sysId: null,
        path: `instance/global/${table}/.shards`,
        detail: expect.stringContaining("mixes fan-out levels"),
      },
    ]);
    expect(result.tables).toEqual([]);
    expect(result.exitCode).toBe(2);
  });
});

describe("readOnlyWriterFs — the seam-level half of the read-only proof", () => {
  it("delegates reads and detonates on every mutator", async () => {
    const backing = new MemoryFs();
    await seedFile(backing, "instance/probe.txt", Buffer.from("probe", "utf8"));
    resetCalls(backing);
    const sealed = readOnlyWriterFs(backing);

    const bytes = await sealed.readFile(relToNative("instance/probe.txt"));
    expect(Buffer.from(bytes as Uint8Array).toString("utf8")).toBe("probe");
    const listing = await sealed.readDir(relToNative("instance"));
    expect(listing).toEqual([{ name: "probe.txt", isDirectory: false }]);

    const violation: unknown = await sealed
      .makeDir("/anywhere")
      .then(() => null, (error: unknown) => error);
    expect(violation).toBeInstanceOf(MirrorReadOnlyViolation);
    expect(violation).toMatchObject({
      name: "MirrorReadOnlyViolation",
      operation: "makeDir",
      target: "/anywhere",
    });
    expect((violation as Error).message).toContain("read-only");

    await expect(sealed.writeFile("/anywhere/f", new Uint8Array())).rejects.toMatchObject({
      name: "MirrorReadOnlyViolation",
      operation: "writeFile",
      target: "/anywhere/f",
    });
    await expect(sealed.rename("/a", "/b")).rejects.toMatchObject({
      name: "MirrorReadOnlyViolation",
      operation: "rename",
      target: "/a -> /b",
    });
    await expect(sealed.removeRecursive("/anywhere")).rejects.toMatchObject({
      name: "MirrorReadOnlyViolation",
      operation: "removeRecursive",
      target: "/anywhere",
    });
    // The detonations never reached the backing fs; only the reads did.
    expect(mutatingCalls(backing)).toEqual([]);
    expect(backing.calls.some((line) => line.startsWith("readFile "))).toBe(true);
  });
});
