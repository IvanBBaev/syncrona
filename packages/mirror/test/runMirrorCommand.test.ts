// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `runMirrorCommand` — the sweep orchestrator, end to end (WP-M8, §5.13).
 *
 * The headline test is INV-1 run through git itself: two full sweeps over an
 * unchanged fake instance into a real temporary git repository, and the second
 * run must leave `git status --porcelain` EMPTY. Asserting on file hashes would
 * prove the writer idempotent; asserting through git proves the whole chain is —
 * the reports, the shards, the record tree, and the absence of any stray state
 * file the orchestrator might have leaked into the working tree. The clock and
 * the sweep id are injected and frozen, because INV-1 is a claim about content,
 * and a run that could only pass with a live clock would be smuggling
 * nondeterminism through the seams the module exists to close.
 *
 * The rest of the file covers what one honest sweep must get right:
 *
 *  - the coverage report accounts for EVERY discovered table (R3) — planned
 *    tables as fetched outcomes, empty tables as `complete` with zero rows (T6),
 *    excluded tables as `skipped` with the exclusion named;
 *  - `coverage.json` on disk is byte-for-byte the report the call returned, so
 *    a reader of the file and a caller of the function can never disagree;
 *  - the suggested commit message (D10, Δ3) carries the sweep trailer and
 *    reports `Mirror-Tables-Changed: 0` on a run that changed nothing — the
 *    flush, not the per-row outcomes, decides "changed" for a completed table —
 *    and the orchestrator never runs git itself, which the INV-1 test proves by
 *    owning the repo;
 *  - D1's verdict: `quiescent: true` only when the pre/post Aggregate readings
 *    agree, `false` when the instance moved mid-sweep (driven by a corpus
 *    mutation between two pages), `null` when nobody asked;
 *  - the transport seam: a client built from `MirrorTransportOptions` sweeps the
 *    same instance the injected client does, the `authorization` provider is
 *    honored, and passing both or neither of `client`/`transport` is refused;
 *  - a scripted seam world drives the branches a correct server cannot be talked
 *    into: a multi-page scope index with junk rows, a row whose scope reference
 *    resolves nowhere (lands in `global`, never throws), a table with no
 *    `sys_scope` column falling back to the TABLE's scope, a display name with
 *    nothing to display, and a `sys_mod_count` that does not parse.
 *
 * `assertNoViolations()` closes every fake-server block: the orchestrator's runs
 * must be GET-only end to end (INV-2), including the git-facing ones.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { MirrorConfig, TableAggregate, TablePage } from "../src/contracts";
import { MirrorHttpClient } from "../src/http/client";
import { COVERAGE_REL_PATH } from "../src/report/coverageReport";
import { MIRROR_REPORT_REL_PATH } from "../src/report/reportMarkdown";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
import {
  runMirrorCommand,
  type MirrorSweepClient,
  type RunMirrorCommandOptions,
} from "../src/runMirrorCommand";
import { nodeWriterFs } from "../src/write/fs";
import {
  BULK_TABLE_NAME,
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  loadCommittedCorpus,
} from "./fakeInstance";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FROZEN_NOW = "2026-03-01T10:00:00.000Z";
const SWEEP_ID = "sweep-fixed-0001";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

/**
 * The corpus tables a CLEAN run must exclude: the bulk table because 24 000 rows
 * prove nothing extra here, and `sys_ui_action` because its phantom `hint`
 * column is the F5 fixture — it makes any sweep that includes it legitimately
 * PARTIAL, and this file is about runs that end at exit 0. The faults suite
 * includes it on purpose.
 */
const CLEAN_EXCLUDES = [BULK_TABLE_NAME, "sys_ui_action"];

const configOf = (overrides: Partial<MirrorConfig> = {}): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: [...CLEAN_EXCLUDES], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
  ...overrides,
});

/** A real client at a fake instance; only the limiter's WAIT is stubbed out. */
const clientFor = (server: FakeInstanceServer, pageSize = 5): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    pageSize,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0.5,
  });

const newRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "syncrona-mirror-run-"));

const runOptions = (
  root: string,
  overrides: Partial<RunMirrorCommandOptions> = {}
): RunMirrorCommandOptions => ({
  config: configOf(),
  root,
  fs: nodeWriterFs(),
  now: () => FROZEN_NOW,
  newSweepId: () => SWEEP_ID,
  full: true,
  ...overrides,
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: root }).toString("utf8");

const readJson = async (root: string, relPath: string): Promise<unknown> => {
  const bytes = await readFile(join(root, relPath));
  return JSON.parse(bytes.toString("utf8")) as unknown;
};

const fileExists = async (root: string, relPath: string): Promise<boolean> => {
  try {
    await readFile(join(root, relPath));
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Against the committed fixture
// ---------------------------------------------------------------------------

describe("runMirrorCommand against the fixture instance", () => {
  let server: FakeInstanceServer;
  const roots: string[] = [];

  const trackedRoot = async (): Promise<string> => {
    const root = await newRoot();
    roots.push(root);
    return root;
  };

  beforeAll(async () => {
    server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
  });

  afterAll(async () => {
    server.assertNoViolations();
    await server.close();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("INV-1: two full sweeps over an unchanged instance leave git clean", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, { client: clientFor(server) }));
    expect(first.exitCode).toBe(0);
    expect(first.fatal).toBeNull();
    expect(first.checkpointCleared).toBe(true);

    git(root, "init", "-q");
    git(root, "config", "user.email", "mirror-test@example.invalid");
    git(root, "config", "user.name", "Mirror Test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first sweep");
    // The commit is not empty: the sweep really did put a tree into the repo.
    expect(git(root, "ls-files").trim()).not.toBe("");

    const second = await runMirrorCommand(runOptions(root, { client: clientFor(server) }));
    expect(second.exitCode).toBe(0);

    // The whole point: same instance, same injected clock, same sweep id —
    // byte-identical tree, and git is the judge of "byte-identical". This
    // covers the reports too: coverage.json and MIRROR-REPORT.md re-wrote to
    // the same bytes, and `.mirror/state/` left nothing git can see.
    expect(git(root, "status", "--porcelain")).toBe("");

    // The message still carries the sweep trailer (D10), and the no-op run
    // reports ZERO changed tables. The writer does churn on the way there —
    // D18 forbids seeding a full sweep, so the case-collision pairs in
    // `sys_script` and `sys_choice` are re-written under their transient plain
    // names and renamed back every run — but for a completed table the
    // orchestrator takes "changed" from the shard flush, not from the per-row
    // outcomes, and an entry set equal to the baseline writes no shard. The
    // porcelain assertion above proves the tree claim; this trailer assertion
    // pins that the commit message tells the same truth.
    expect(second.commitMessage).toContain(`Mirror-Sweep: ${SWEEP_ID}`);
    expect(second.commitMessage).toContain("Mirror-Tables-Changed: 0");
    expect(second.commitMessage).toContain("mirror(full): 0 tables changed");
  }, 30000);

  it("accounts for every discovered table and writes the report it returns", async () => {
    const root = await trackedRoot();
    const run = await runMirrorCommand(runOptions(root, { client: clientFor(server) }));

    expect(run.exitCode).toBe(0);
    expect(run.report.formatVersion).toBe(1);
    expect(run.report.sweepId).toBe(SWEEP_ID);
    expect(run.report.mode).toBe("full");
    expect(run.report.startedAt).toBe(FROZEN_NOW);
    expect(run.report.finishedAt).toBe(FROZEN_NOW);
    // Nobody asked for D1, so nobody claims to have checked it.
    expect(run.report.quiescent).toBeNull();

    // Fetched tables: complete, with the expectation met.
    expect(run.report.tables.sys_script).toEqual({
      status: "complete",
      expectedRows: 9,
      mirroredRows: 9,
    });
    // T6: a table measured at zero rows is COVERED, not skipped.
    expect(run.report.tables.x_syn_demo_empty).toEqual({
      status: "complete",
      expectedRows: 0,
      mirroredRows: 0,
    });
    // Config exclusions are stated, not silent (R3).
    expect(run.report.tables[BULK_TABLE_NAME]).toMatchObject({
      status: "skipped",
      reason: "excluded-config",
    });
    expect(run.report.tables.sys_ui_action).toMatchObject({
      status: "skipped",
      reason: "excluded-config",
    });
    // Tier exclusions likewise.
    expect(run.report.tables.sys_db_object).toMatchObject({
      status: "skipped",
      reason: "excluded-tier",
    });

    // The file on disk IS the returned report — one source of truth, two readers.
    expect(await readJson(root, COVERAGE_REL_PATH)).toEqual(run.report);
    const markdown = (await readFile(join(root, MIRROR_REPORT_REL_PATH))).toString("utf8");
    expect(markdown).toContain(SWEEP_ID);

    // D10/Δ3: a suggested message, never an executed one — this root has no git.
    expect(run.commitMessage).toContain(`Mirror-Sweep: ${SWEEP_ID}`);
    expect(run.commitMessage).toContain("Mirror-Tables-Changed");
    expect(run.commitMessage).toContain("Mirror-Scopes");
    expect(run.commitMessage).not.toContain("Mirror-Consistency");

    // A clean end leaves no checkpoint behind.
    expect(await fileExists(root, CHECKPOINT_REL_PATH)).toBe(false);
    expect(run.checkpointCleared).toBe(true);
    expect(run.resumeDecision).not.toBeNull();
  }, 30000);

  it("D1: proves an untouched instance quiescent and says so in the trailer", async () => {
    const root = await trackedRoot();
    const run = await runMirrorCommand(
      runOptions(root, { client: clientFor(server), verifyQuiescent: true })
    );

    expect(run.exitCode).toBe(0);
    expect(run.report.quiescent).toBe(true);
    expect(run.commitMessage).toContain("Mirror-Consistency: quiescent");
  }, 30000);

  it("a follow-up run without --full syncs by watermark instead of re-sweeping", async () => {
    const root = await trackedRoot();
    const first = await runMirrorCommand(runOptions(root, { client: clientFor(server) }));
    expect(first.exitCode).toBe(0);

    // Same root, `full: false`, sync #1 of 10 — an INCREMENTAL plan: every
    // table with shard state from the first run is walked by watermark, and the
    // Writer is told so (its flush merges a slice instead of claiming the
    // whole table).
    const beforeSecond = server.requests.length;
    const second = await runMirrorCommand(
      runOptions(root, { client: clientFor(server), full: false })
    );

    expect(second.exitCode).toBe(0);
    expect(second.fatal).toBeNull();
    expect(second.report.mode).toBe("incremental");
    expect(second.report.tables.sys_script).toMatchObject({ status: "complete" });
    expect(second.checkpointCleared).toBe(true);

    // The wire proves the strategy: the follow-up's pages carry the planner's
    // watermark filter (D20's checked query), not a bare full-table walk.
    const watermarkPages = server.requests
      .slice(beforeSecond)
      .filter(
        (request) =>
          request.route === "table-page" &&
          request.table === "sys_script" &&
          (request.query.sysparm_query ?? "").includes("sys_updated_on>=")
      );
    expect(watermarkPages.length).toBeGreaterThan(0);
  }, 30000);

  it("builds a client from transport material, honoring the authorization provider", async () => {
    const root = await trackedRoot();
    let providerReads = 0;
    const run = await runMirrorCommand(
      runOptions(root, {
        transport: {
          instance: server.baseUrl,
          authorization: () => {
            providerReads += 1;
            return basicAuth();
          },
          fetch: (input, init) => fetch(input, init),
          maxAttempts: 2,
          timeoutMs: 30000,
          sleep: () => Promise.resolve(),
        },
      })
    );

    expect(run.exitCode).toBe(0);
    // The provider is read once, at construction — keeping a header fresh
    // across a long run is WP-M9's job, not this seam's.
    expect(providerReads).toBe(1);
  }, 30000);

  it("builds a client from minimal transport material (string authorization)", async () => {
    const root = await trackedRoot();
    const run = await runMirrorCommand(
      runOptions(root, {
        // A high request rate so the client's REAL sleep never waits long —
        // this variant exists to cover the defaults, not to test the limiter.
        config: configOf({
          sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 1000, pageSize: 100 },
        }),
        transport: { instance: server.baseUrl, authorization: basicAuth() },
      })
    );
    expect(run.exitCode).toBe(0);
  }, 30000);

  it("refuses both client and transport, and refuses neither", async () => {
    const root = await trackedRoot();
    await expect(
      runMirrorCommand(
        runOptions(root, {
          client: clientFor(server),
          transport: { instance: server.baseUrl, authorization: basicAuth() },
        })
      )
    ).rejects.toThrow("not both");
    await expect(runMirrorCommand(runOptions(root))).rejects.toThrow("a transport is required");
  });
});

// ---------------------------------------------------------------------------
// D1: the instance moving mid-sweep is noticed
// ---------------------------------------------------------------------------

describe("runMirrorCommand and a non-quiescent instance", () => {
  it("D1: a row inserted between two pages flips the verdict to false", async () => {
    // The inserted row also drives three defensive branches through real data:
    // a `sys_mod_count` that does not parse (counts as zero), an empty display
    // name (the resolver falls back to the sys_id), and an empty `sys_scope`
    // falling back to the scope the TABLE is defined in.
    const server = await FakeInstanceServer.start({
      corpus: loadCommittedCorpus(),
      mutations: [
        {
          table: "sys_script",
          afterPages: 1,
          insertRows: [
            {
              sys_id: "ffffffffffffffffffffffffffffff01",
              name: "",
              sys_updated_on: "2026-03-01 09:59:59",
              sys_mod_count: "not-a-number",
            },
          ],
        },
      ],
    });
    const root = await newRoot();
    try {
      const run = await runMirrorCommand(
        runOptions(root, { client: clientFor(server), verifyQuiescent: true })
      );

      // The sweep itself still completes — more rows than promised is not a
      // shortfall — but the post-reading disagrees with the pre-reading.
      expect(run.fatal).toBeNull();
      expect(run.exitCode).toBe(0);
      expect(run.report.quiescent).toBe(false);
      expect(run.commitMessage).not.toContain("Mirror-Consistency");
      expect(run.report.tables.sys_script.mirroredRows).toBe(10);

      server.assertNoViolations();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Scripted seam world — the branches a correct server never exercises
// ---------------------------------------------------------------------------

/** A syntactically valid sys_id (INV-6) derived from a label. */
const sysIdOf = (label: string): string =>
  createHash("sha256").update(label).digest("hex").slice(0, 32);

interface SeamCall {
  table: string;
  cursor: string | null;
  fields: readonly string[];
}

/**
 * A tiny scripted instance: three metadata tables and a two-page scope index
 * salted with junk rows. Stateless by design — pages are answered from the
 * cursor, so the catalog build and the scope index can both walk `sys_scope`
 * without sharing a queue.
 */
const seamWorld = (): { client: MirrorSweepClient; calls: SeamCall[] } => {
  const tableRow = (name: string, superClass: string, scope: string): Record<string, string> => ({
    sys_id: sysIdOf(name),
    name,
    super_class: superClass,
    sys_scope: scope,
  });
  const columnRow = (
    table: string,
    element: string,
    internalType = "string"
  ): Record<string, string> => ({
    name: table,
    element,
    internal_type: internalType,
    reference: "",
    max_length: "40",
    active: "true",
  });

  const byTable: Record<string, Array<Record<string, string>>> = {
    sys_db_object: [
      tableRow("sys_metadata", "", ""),
      // A table whose scope reference RESOLVES — records with their own
      // sys_scope land under its name.
      tableRow("u_seam", sysIdOf("sys_metadata"), sysIdOf("scope-known")),
      // A table with no sys_scope column at all, whose TABLE scope resolves
      // nowhere — every record falls back to `global`.
      tableRow("u_audit", sysIdOf("sys_metadata"), sysIdOf("scope-unknown")),
    ],
    sys_dictionary: [
      columnRow("sys_metadata", "name"),
      columnRow("u_seam", "name"),
      columnRow("u_seam", "sys_scope"),
      columnRow("u_seam", "sys_mod_count", "integer"),
      columnRow("u_audit", "value"),
      // A JSON-blob column (F6): its value below is NOT valid JSON, so the
      // serializer reports a parse failure and the orchestrator must relay it
      // into the coverage row's `notDecomposed` — without degrading the table.
      columnRow("u_audit", "payload", "json"),
    ],
    sys_metadata: [{ sys_id: sysIdOf("meta-row"), name: "meta-row" }],
    u_seam: [
      {
        sys_id: sysIdOf("seam-one"),
        name: "Seam One",
        sys_scope: sysIdOf("scope-known"),
        sys_mod_count: "7",
      },
      // Scope reference resolves nowhere → `global`; nothing to display → the
      // resolver falls back to the sys_id; mod count unparseable → zero.
      {
        sys_id: sysIdOf("seam-two"),
        name: "",
        sys_scope: sysIdOf("scope-unknown"),
        sys_mod_count: "many",
      },
    ],
    // `name` is inherited from sys_metadata's dictionary, so the row must carry
    // the key or the fetcher rightly reports the column missing; it is EMPTY so
    // the display-name chain walks past it to `value`.
    u_audit: [{ sys_id: sysIdOf("audit-one"), name: "", value: "v", payload: "{not json" }],
  };

  const scopePages: Record<string, TablePage> = {
    // Page one: one resolvable scope, one row with no sys_id — skipped, not trusted.
    first: {
      rows: [
        { sys_id: sysIdOf("scope-known"), scope: "x_seam_scope" },
        { sys_id: "", scope: "x_junk" },
      ],
      lastSysId: "cursor-1",
      done: false,
    },
    // Page two: a scope with no name — also skipped. `done` stays false and the
    // null cursor is what terminates the walk, covering that exit distinctly.
    second: {
      rows: [{ sys_id: sysIdOf("scope-nameless"), scope: "" }],
      lastSysId: null,
      done: false,
    },
  };

  const calls: SeamCall[] = [];
  const client: MirrorSweepClient = {
    getPage: (table, cursor, request): Promise<TablePage> => {
      calls.push({ table, cursor, fields: request.fields });
      if (table === "sys_scope") {
        return Promise.resolve(cursor === null ? scopePages.first : scopePages.second);
      }
      const rows = byTable[table] ?? [];
      return Promise.resolve({
        rows,
        lastSysId: rows.length === 0 ? null : rows[rows.length - 1].sys_id,
        done: true,
      });
    },
    getAggregate: (table): Promise<TableAggregate | null> => {
      const rows = byTable[table] ?? [];
      return Promise.resolve({ count: rows.length, maxUpdatedOn: "2026-02-01 00:00:00" });
    },
  };
  return { client, calls };
};

describe("runMirrorCommand scope and naming fallbacks (scripted)", () => {
  it("places every record under a real scope name or global, never throwing", async () => {
    const root = await newRoot();
    const world = seamWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(root, {
          client: world.client,
          config: configOf({ tables: { include: [], exclude: [], perTable: {} } }),
        })
      );

      expect(run.fatal).toBeNull();
      expect(run.exitCode).toBe(0);
      expect(run.report.tables.u_seam).toEqual({
        status: "complete",
        expectedRows: 2,
        mirroredRows: 2,
      });
      // F6 is a report, not a shortfall: the invalid blob's column is named in
      // `notDecomposed`, the value survives behind the `raw:` marker, and the
      // table stays complete (the exit-0 assertion above already vouched).
      expect(run.report.tables.u_audit).toEqual({
        status: "complete",
        expectedRows: 1,
        mirroredRows: 1,
        notDecomposed: ["payload"],
      });

      // The tree: a resolvable scope gets its name, everything else is global.
      const scopes = (await readdir(join(root, "instance"))).sort();
      expect(scopes).toEqual(["global", "x_seam_scope"]);
      const named = (await readdir(join(root, "instance", "x_seam_scope", "u_seam"))).filter(
        (entry) => entry !== ".shards"
      );
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("Seam One");
      // The nameless record lands under global, named by its sys_id.
      const fallback = (await readdir(join(root, "instance", "global", "u_seam"))).filter(
        (entry) => entry !== ".shards"
      );
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain(sysIdOf("seam-two"));
      // A table with no sys_scope column and an unresolvable table scope: global.
      const audit = (await readdir(join(root, "instance", "global", "u_audit"))).filter(
        (entry) => entry !== ".shards"
      );
      expect(audit).toHaveLength(1);
      // `value` is a display-name field of last resort.
      expect(audit[0]).toContain("v");

      // The index was paged: the walk crossed the page-one cursor and stopped at
      // the null cursor on page two.
      const indexCalls = world.calls.filter(
        (call) =>
          call.table === "sys_scope" &&
          call.fields.length === 2 &&
          call.fields[0] === "scope" &&
          call.fields[1] === "sys_id"
      );
      expect(indexCalls.map((call) => call.cursor)).toEqual([null, "cursor-1"]);

      // Scopes trailer covers what the sweep covered, sorted.
      expect(run.commitMessage).toContain("Mirror-Scopes: global,x_seam_scope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("leaves a stats-restricted table out of the quiescence story, not out of the sweep", async () => {
    const root = await newRoot();
    const world = seamWorld();
    // u_audit's Aggregate is REFUSED while its pages read fine — the platform
    // reality the catalog's probe exists for (some instances restrict `stats`
    // separately). The table stays included with an UNKNOWN count, so D1 has no
    // pre-reading for it: the honest verdict must come from the tables that
    // could be counted, neither blocked by nor invented for the one that could
    // not.
    const inner = world.client;
    const client: MirrorSweepClient = {
      getPage: (table, cursor, request) => inner.getPage(table, cursor, request),
      getAggregate: (table) =>
        table === "u_audit" ? Promise.resolve(null) : inner.getAggregate(table),
    };
    try {
      const run = await runMirrorCommand(
        runOptions(root, {
          client,
          verifyQuiescent: true,
          config: configOf({ tables: { include: [], exclude: [], perTable: {} } }),
        })
      );

      expect(run.fatal).toBeNull();
      expect(run.exitCode).toBe(0);
      // Swept in full all the same, reported with the honest unknown.
      expect(run.report.tables.u_audit).toMatchObject({
        status: "complete",
        expectedRows: null,
        mirroredRows: 1,
      });
      // Every countable table agreed pre/post, so the verdict stands.
      expect(run.report.quiescent).toBe(true);
      expect(run.commitMessage).toContain("Mirror-Consistency: quiescent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
