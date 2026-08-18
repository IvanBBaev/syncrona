// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * DriftDetector — `mirror status` (§5.10, WP-M11).
 *
 * The suite is fake-instance-driven on purpose: every shallow scenario runs
 * the shipped `MirrorHttpClient` against `FakeInstanceServer` over the
 * committed corpus, and each drifted case is produced by MOVING the instance
 * (a scripted mutation) after the disk fixture was minted from its earlier
 * state — never by hand-editing the fixture to disagree. A comparison test
 * whose two sides were both authored by the test can only prove the test
 * agrees with itself; one whose live side actually moved proves the detector
 * sees movement. `assertNoViolations()` closes every server-backed test, which
 * is how INV-2 (GET only) is asserted here rather than assumed.
 *
 * What each block pins, by acceptance:
 *  - §12 WP-M11: "status detects each of count-drift, watermark-drift, and
 *    clean (exit 0/2 contract)" — the first three tests, one per verdict.
 *  - §12 WP-M11: "`--deep` sampling finds a planted hash mismatch" — the
 *    silent-edit test: a row changed WITHOUT its `sys_updated_on` moving is
 *    invisible to the aggregate comparison (asserted, not assumed: the shallow
 *    run exits 0 first) and caught by the row-hash sample.
 *  - R3: a `null` Aggregate answer becomes a named `cannot-tell` verdict and
 *    exit 0, never a manufactured drift claim — likewise an unreadable shard
 *    set, and a `--deep` request whose catalog entry is missing.
 *  - R1: the three run-stopping failure classes propagate as the client's
 *    `MirrorHttpError` (the CLI maps them to exit 1); they never become
 *    per-table verdicts.
 *  - Both asymmetries of the table universe: live-but-unmirrored versus
 *    mirrored-but-vanished, the latter without spending an aggregate call.
 */
import type { TableAggregate, TableCatalogEntry } from "../src/contracts";
import { MirrorHttpClient, MirrorHttpError } from "../src/http/client";
import {
  buildShardManifest,
  renderShardManifest,
} from "../src/shards/shardLayout";
import {
  detectDrift,
  type DriftAggregateSource,
  type MirrorStatusResult,
} from "../src/status/driftDetector";
import {
  FakeInstanceServer,
  loadCommittedCorpus,
  type FixtureCorpus,
} from "./fakeInstance";
import {
  MemoryFs,
  ROOT,
  entriesByName,
  fakeEntryForRow,
  realEntriesFromInstance,
  seedFile,
  statusClientFor,
  statusEntryFromCorpus,
  testSysId,
  writeShardFixture,
} from "./statusFixtures";

const corpus: FixtureCorpus = loadCommittedCorpus();

/**
 * An aggregate source that must never be consulted — for the verdicts the
 * detector owes without an instance round-trip (vanished tables, unreadable
 * shard sets). A recorded call is the test failure, not a stubbed answer.
 */
const untouchableAggregates = (): DriftAggregateSource & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    getAggregate(table: string): Promise<TableAggregate | null> {
      calls.push(table);
      return Promise.resolve(null);
    },
  };
};

/** Start a server, run the test body, assert GET-only, always close. */
async function withServer(
  options: Parameters<typeof FakeInstanceServer.start>[0],
  body: (server: FakeInstanceServer, client: MirrorHttpClient) => Promise<void>
): Promise<void> {
  const server = await FakeInstanceServer.start({ corpus, ...options });
  try {
    await body(server, statusClientFor(server));
    server.assertNoViolations();
  } finally {
    await server.close();
  }
}

describe("mirror status — aggregate comparison", () => {
  it("judges an unchanged table in-sync and exits 0", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_script";
      const rows = server.rowsOf(table);
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(rows, "global", table),
      });
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result).toEqual<MirrorStatusResult>({
        verdicts: [
          {
            kind: "in-sync",
            table,
            liveCount: rows.length,
            mirroredCount: rows.length,
            sampledRecords: 0,
          },
        ],
        driftDetected: false,
        exitCode: 0,
      });
    });
  });

  it("reports a row inserted after the sweep as count-drift and exits 2", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_script";
      const rows = server.rowsOf(table);
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(rows, "global", table),
      });
      server.mutate({
        table,
        insertRows: [
          {
            sys_id: testSysId(0x9001),
            name: "inserted after the sweep",
            sys_updated_on: "2026-01-01 00:00:00",
          },
        ],
      });
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result.verdicts).toEqual([
        {
          kind: "count-drift",
          table,
          liveCount: rows.length + 1,
          mirroredCount: rows.length,
        },
      ]);
      expect(result.driftDetected).toBe(true);
      expect(result.exitCode).toBe(2);
    });
  });

  it("reports a row deleted after the sweep as count-drift", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_script";
      const rows = server.rowsOf(table);
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(rows, "global", table),
      });
      server.mutate({ table, deleteSysIds: [rows[0].sys_id] });
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result.verdicts).toEqual([
        {
          kind: "count-drift",
          table,
          liveCount: rows.length - 1,
          mirroredCount: rows.length,
        },
      ]);
      expect(result.exitCode).toBe(2);
    });
  });

  it("reports a moved watermark as watermark-drift when counts still agree", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_script";
      const rows = server.rowsOf(table);
      const mirroredMax = rows
        .map((row) => row.sys_updated_on)
        .filter((value) => value !== "")
        .sort()
        .at(-1) as string;
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(rows, "global", table),
      });
      const bumped = "2031-01-01 00:00:00";
      server.mutate({
        table,
        updateRows: [{ sysId: rows[0].sys_id, fields: { sys_updated_on: bumped } }],
      });
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result.verdicts).toEqual([
        {
          kind: "watermark-drift",
          table,
          liveCount: rows.length,
          liveMaxUpdatedOn: bumped,
          mirroredMaxUpdatedOn: mirroredMax,
        },
      ]);
      expect(result.exitCode).toBe(2);
    });
  });

  it("judges a live table with no shards not-mirrored, unless the live table is empty", async () => {
    await withServer({}, async (server, client) => {
      // A fresh MemoryFs: no instance/ directory at all. The populated live
      // table is drift (the mirror is missing it); the empty live table is
      // in-sync (there is nothing to mirror). Verdicts arrive sorted bytewise.
      const fs = new MemoryFs();
      const scriptRows = server.rowsOf("sys_script");
      expect(server.rowsOf("x_syn_demo_empty")).toHaveLength(0);
      const result = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: ["sys_script", "x_syn_demo_empty"],
      });
      expect(result.verdicts).toEqual([
        { kind: "table-not-mirrored", table: "sys_script", liveCount: scriptRows.length },
        {
          kind: "in-sync",
          table: "x_syn_demo_empty",
          liveCount: 0,
          mirroredCount: 0,
          sampledRecords: 0,
        },
      ]);
      expect(result.exitCode).toBe(2);
    });
  });

  it("judges a mirrored table the live list no longer names table-vanished, without an aggregate call", async () => {
    // No server at all: the caller's table list is authoritative for what the
    // instance has, so the verdict is owed before any request could be made.
    const fs = new MemoryFs();
    const table = "x_syn_retired";
    const rows = [
      { sys_id: testSysId(1), sys_updated_on: "2026-01-01 00:00:00" },
      { sys_id: testSysId(2), sys_updated_on: "2026-01-02 00:00:00" },
    ];
    await writeShardFixture(fs, {
      scope: "global",
      table,
      entries: entriesByName(rows, "global", table),
    });
    const client = untouchableAggregates();
    const result = await detectDrift({ fs, root: ROOT, client, tables: [] });
    expect(result.verdicts).toEqual([
      { kind: "table-vanished", table, mirroredCount: 2 },
    ]);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toEqual([]);
  });

  it("turns a null Aggregate answer into cannot-tell, never into a drift claim (R3)", async () => {
    await withServer(
      { aggregateDeniedTables: ["sys_script"] },
      async (server, client) => {
        const table = "sys_script";
        const fs = new MemoryFs();
        await writeShardFixture(fs, {
          scope: "global",
          table,
          entries: entriesByName(server.rowsOf(table), "global", table),
        });
        const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
        expect(result.verdicts).toEqual([
          {
            kind: "cannot-tell",
            table,
            reason: "aggregate-unavailable",
            detail: expect.stringContaining("sys_script"),
          },
        ]);
        expect(result.driftDetected).toBe(false);
        expect(result.exitCode).toBe(0);
      }
    );
  });

  it("returns cannot-tell when counts agree but the live watermark is absent", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_ui_action";
      const rows = server.rowsOf(table);
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(rows, "global", table),
      });
      // Blank every live sys_updated_on: the Aggregate MAX comes back empty and
      // the client maps that to null. Comparing null against the mirrored max
      // would fabricate watermark-drift out of an absent answer.
      for (const row of rows) {
        server.mutate({
          table,
          updateRows: [{ sysId: row.sys_id, fields: { sys_updated_on: "" } }],
        });
      }
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result.verdicts).toEqual([
        {
          kind: "cannot-tell",
          table,
          reason: "watermark-unavailable",
          detail: expect.stringContaining(String(rows.length)),
        },
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  it("merges a table mirrored across two scopes into one comparison", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_update_set_source";
      const rows = server.rowsOf(table);
      expect(rows).toHaveLength(2);
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName([rows[0]], "global", table),
      });
      // The second scope's entry carries no watermark, mirroring a row whose
      // sys_updated_on came off the wire empty — blank it live too, so both
      // sides agree the only watermark is the first row's.
      const blanked = { ...fakeEntryForRow("x_custom", table, rows[1]), sysUpdatedOn: "" };
      await writeShardFixture(fs, {
        scope: "x_custom",
        table,
        entries: new Map([[rows[1].sys_id, blanked]]),
      });
      server.mutate({
        table,
        updateRows: [{ sysId: rows[1].sys_id, fields: { sys_updated_on: "" } }],
      });
      const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(result.verdicts).toEqual([
        { kind: "in-sync", table, liveCount: 2, mirroredCount: 2, sampledRecords: 0 },
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  it("reports an unreadable shard set as cannot-tell without touching the instance", async () => {
    const fs = new MemoryFs();
    await seedFile(
      fs,
      "instance/global/sys_script/.shards/all.json",
      Buffer.from("this is not a shard manifest", "utf8")
    );
    const client = untouchableAggregates();
    const result = await detectDrift({
      fs,
      root: ROOT,
      client,
      tables: ["sys_script"],
    });
    expect(result.verdicts).toEqual([
      {
        kind: "cannot-tell",
        table: "sys_script",
        reason: "shard-corrupt",
        detail: expect.stringContaining("all.json"),
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it("reports a shard fan-out conflict as cannot-tell", async () => {
    const fs = new MemoryFs();
    const table = "x_syn_conflicted";
    await writeShardFixture(fs, {
      scope: "global",
      table,
      entries: entriesByName(
        [{ sys_id: testSysId(3), sys_updated_on: "2026-01-01 00:00:00" }],
        "global",
        table
      ),
    });
    // A second shard file at a different fan-out, planted through the real
    // renderer so only the conflict is synthetic, not the file format.
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
    const client = untouchableAggregates();
    const result = await detectDrift({ fs, root: ROOT, client, tables: [table] });
    expect(result.verdicts).toEqual([
      {
        kind: "cannot-tell",
        table,
        reason: "shard-fanout-conflict",
        detail: expect.stringContaining(table),
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it("propagates run-stopping client failures instead of inventing verdicts (R1)", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_script";
      const fs = new MemoryFs();
      await writeShardFixture(fs, {
        scope: "global",
        table,
        entries: entriesByName(server.rowsOf(table), "global", table),
      });
      const badAuthClient = new MirrorHttpClient({
        instance: server.baseUrl,
        headers: {
          Authorization: `Basic ${Buffer.from("mirror.svc:wrong", "utf8").toString("base64")}`,
        },
        pageSize: 100,
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      });
      const authFailure: unknown = await detectDrift({
        fs,
        root: ROOT,
        client: badAuthClient,
        tables: [table],
      }).then(
        () => null,
        (error: unknown) => error
      );
      expect(authFailure).toBeInstanceOf(MirrorHttpError);
      expect((authFailure as MirrorHttpError).failureClass).toBe("auth");

      server.setHibernating(true);
      const hibernation: unknown = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
      }).then(
        () => null,
        (error: unknown) => error
      );
      expect(hibernation).toBeInstanceOf(MirrorHttpError);
      expect((hibernation as MirrorHttpError).failureClass).toBe("hibernating");
    });
  });

  it("propagates an unexpected filesystem failure instead of converting it into a verdict", async () => {
    const base = new MemoryFs();
    const table = "x_syn_ondisk";
    await writeShardFixture(base, {
      scope: "global",
      table,
      entries: entriesByName(
        [{ sys_id: testSysId(4), sys_updated_on: "2026-01-01 00:00:00" }],
        "global",
        table
      ),
    });
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
      detectDrift({
        fs: firewalled,
        root: ROOT,
        client: untouchableAggregates(),
        tables: [table],
      })
    ).rejects.toThrow("disk on fire");
  });

  it("rejects an invalid deep sampling interval as a caller bug", async () => {
    const fs = new MemoryFs();
    const deepBase = {
      client: { getPage: () => Promise.reject(new Error("must not be called")) },
      catalog: new Map<string, TableCatalogEntry>(),
    };
    for (const sampleEvery of [0, -1, 1.5]) {
      await expect(
        detectDrift({
          fs,
          root: ROOT,
          client: untouchableAggregates(),
          tables: [],
          deep: { ...deepBase, sampleEvery },
        })
      ).rejects.toThrow("deep sampling interval must be an integer >= 1");
    }
  });
});

describe("mirror status --deep", () => {
  it("finds a silently edited row that the aggregate comparison provably cannot see (§12)", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_ui_action";
      const entry = statusEntryFromCorpus(corpus, table);
      const entries = await realEntriesFromInstance(client, entry, "global");
      const fs = new MemoryFs();
      await writeShardFixture(fs, { scope: "global", table, entries });
      const target = [...entries.keys()].sort()[0];
      // The silent edit: content moves, sys_updated_on does not (the fake
      // applies update fields verbatim, bumping nothing).
      server.mutate({
        table,
        updateRows: [{ sysId: target, fields: { name: "silently edited" } }],
      });

      const shallow = await detectDrift({ fs, root: ROOT, client, tables: [table] });
      expect(shallow.verdicts[0].kind).toBe("in-sync");
      expect(shallow.exitCode).toBe(0);

      const deep = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map([[table, entry]]), sampleEvery: 1 },
      });
      expect(deep.verdicts).toEqual([
        {
          kind: "deep-drift",
          table,
          sampledRecords: entries.size,
          mismatches: [{ sysId: target, reason: "content-hash-mismatch" }],
        },
      ]);
      expect(deep.driftDetected).toBe(true);
      expect(deep.exitCode).toBe(2);
    });
  });

  it("reports a sampled record the instance no longer returns as row-missing", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_choice";
      const entry = statusEntryFromCorpus(corpus, table);
      const entries = await realEntriesFromInstance(client, entry, "global");
      const fs = new MemoryFs();
      await writeShardFixture(fs, { scope: "global", table, entries });
      // Swap one row for a fresh one carrying the same sys_updated_on: COUNT
      // and MAX both hold still, so only sampling can see the substitution.
      const deleted = "381ae8dec7b8b0219c49c73d0d5c01c6";
      server.mutate({
        table,
        deleteSysIds: [deleted],
        insertRows: [
          {
            sys_id: testSysId(0xd1),
            sys_updated_on: "2026-02-15 05:39:29",
          },
        ],
      });
      const result = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map([[table, entry]]), sampleEvery: 1 },
      });
      expect(result.verdicts).toEqual([
        {
          kind: "deep-drift",
          table,
          sampledRecords: entries.size,
          mismatches: [{ sysId: deleted, reason: "row-missing" }],
        },
      ]);
      expect(result.exitCode).toBe(2);
    });
  });

  it("samples every Kth record in bytewise order: K=2 misses what K=1 catches", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_ui_action";
      const entry = statusEntryFromCorpus(corpus, table);
      const entries = await realEntriesFromInstance(client, entry, "global");
      expect(entries.size).toBe(3);
      const fs = new MemoryFs();
      await writeShardFixture(fs, { scope: "global", table, entries });
      // Damage the middle record of the sorted three: indices 0 and 2 are the
      // K=2 sample, so the edit sits exactly in the gap.
      const middle = [...entries.keys()].sort()[1];
      server.mutate({
        table,
        updateRows: [{ sysId: middle, fields: { name: "edited in the gap" } }],
      });

      const sparse = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map([[table, entry]]), sampleEvery: 2 },
      });
      expect(sparse.verdicts).toEqual([
        { kind: "in-sync", table, liveCount: 3, mirroredCount: 3, sampledRecords: 2 },
      ]);
      expect(sparse.exitCode).toBe(0);

      const full = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map([[table, entry]]), sampleEvery: 1 },
      });
      expect(full.verdicts[0]).toMatchObject({
        kind: "deep-drift",
        mismatches: [{ sysId: middle, reason: "content-hash-mismatch" }],
      });
      expect(full.exitCode).toBe(2);
    });
  });

  it("re-derives canonical bytes under the sweep's redaction config", async () => {
    await withServer({}, async (server, client) => {
      // sys_update_set_source carries a password2 column: the projection must
      // drop it on both sides (D19) or no hash could ever match.
      const table = "sys_update_set_source";
      const entry = statusEntryFromCorpus(corpus, table);
      const redaction = { propertyAllowlist: ["glide.installation.name"] };
      const entries = await realEntriesFromInstance(client, entry, "global", redaction);
      const fs = new MemoryFs();
      await writeShardFixture(fs, { scope: "global", table, entries });
      const result = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map([[table, entry]]), redaction, sampleEvery: 1 },
      });
      expect(result.verdicts).toEqual([
        {
          kind: "in-sync",
          table,
          liveCount: entries.size,
          mirroredCount: entries.size,
          sampledRecords: entries.size,
        },
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  it("returns cannot-tell when --deep has no catalog entry for a table (R3)", async () => {
    await withServer({}, async (server, client) => {
      const table = "sys_ui_action";
      const entry = statusEntryFromCorpus(corpus, table);
      const entries = await realEntriesFromInstance(client, entry, "global");
      const fs = new MemoryFs();
      await writeShardFixture(fs, { scope: "global", table, entries });
      const result = await detectDrift({
        fs,
        root: ROOT,
        client,
        tables: [table],
        deep: { client, catalog: new Map(), sampleEvery: 1 },
      });
      expect(result.verdicts).toEqual([
        {
          kind: "cannot-tell",
          table,
          reason: "deep-catalog-missing",
          detail: expect.stringContaining(table),
        },
      ]);
      expect(result.exitCode).toBe(0);
    });
  });
});
