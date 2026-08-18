// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `runMirrorCommand` under the fault taxonomy (§10, D4, R1) — WP-M8.
 *
 * One test per taxonomy row the orchestrator must translate into an exit code,
 * a coverage row (or a principled absence of one), and a diagnosis:
 *
 *  - F1 transient-exhausted: retries spent on a 429 storm degrade the TABLE and
 *    exit 2, but the run finishes and the checkpoint clears — a rate limit is
 *    weather, not a verdict on the credentials;
 *  - F2 auth: a 401 after the per-RUN refresh latch is spent is FATAL, exit 1,
 *    and leaves NO coverage row for the failing table (the taxonomy's coverage
 *    column is "—": auth death says nothing about the table). The checkpoint
 *    survives so the next run resumes;
 *  - F2 refresh latch: exactly ONE refresh per run — the first 401 refreshes and
 *    retries, the second 401 dies without a second refresh call;
 *  - F3 acl-403: a denied table is PARTIAL with reason `acl-403`, exit 2 — the
 *    instance answered, the mirror just may not look;
 *  - F4 unreachable vs hibernating: both exit 1, but with DISTINCT diagnosis
 *    sentences, because a hibernating PDI is woken at developer.servicenow.com
 *    and an unreachable one is not;
 *  - F5 column-missing: the corpus's phantom `sys_ui_action.hint` column makes
 *    the table partial with the rows it DID deliver still mirrored — exit 2;
 *
 * plus the orchestrator's own two soft-failure seams:
 *
 *  - a scope-name index that cannot be read degrades to an EMPTY index (records
 *    land under `global`) when the failure is non-fatal, and aborts the run when
 *    it is fatal-class — the index is a nicety, the credentials are not;
 *  - a post-quiescence re-read that returns null flips D1's verdict to `false`
 *    without touching the exit code; one that dies fatally kills the run AFTER
 *    the sweep, leaving `quiescent: null` and the checkpoint in place.
 *
 * The one assertion every test here shares: `coverage.json` and
 * `MIRROR-REPORT.md` exist ON EVERY OUTCOME, including the fatal ones. A run
 * that died without leaving a report is the only result a reader cannot
 * interpret, so it is the one result this module may never produce.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { MirrorConfig, TableAggregate, TablePage } from "../src/contracts";
import { MirrorHttpClient, MirrorHttpError, type MirrorHttpClientOptions } from "../src/http/client";
import { COVERAGE_REL_PATH } from "../src/report/coverageReport";
import { MIRROR_REPORT_REL_PATH } from "../src/report/reportMarkdown";
import {
  runMirrorCommand,
  type MirrorSweepClient,
  type RunMirrorCommandOptions,
} from "../src/runMirrorCommand";
import { nodeWriterFs } from "../src/write/fs";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
import {
  BULK_TABLE_NAME,
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  loadCommittedCorpus,
  rateLimitWithoutRetryAfter,
} from "./fakeInstance";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FROZEN_NOW = "2026-03-01T10:00:00.000Z";
const SWEEP_ID = "sweep-faults-0001";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

/** Excludes for a run whose only degradation should be the injected fault. */
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

const clientFor = (
  server: FakeInstanceServer,
  overrides: Partial<MirrorHttpClientOptions> = {}
): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    pageSize: 5,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0.5,
    ...overrides,
  });

const newRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "syncrona-mirror-fault-"));

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

const fileExists = async (root: string, relPath: string): Promise<boolean> => {
  try {
    await readFile(join(root, relPath));
    return true;
  } catch {
    return false;
  }
};

/** Every outcome — including the fatal ones — leaves both report files behind. */
const expectReportsWritten = async (root: string): Promise<void> => {
  expect(await fileExists(root, COVERAGE_REL_PATH)).toBe(true);
  expect(await fileExists(root, MIRROR_REPORT_REL_PATH)).toBe(true);
};

interface FaultWorld {
  server: FakeInstanceServer;
  root: string;
}

const startWorld = async (
  serverOptions: Parameters<typeof FakeInstanceServer.start>[0] = {}
): Promise<FaultWorld> => ({
  server: await FakeInstanceServer.start({ corpus: loadCommittedCorpus(), ...serverOptions }),
  root: await newRoot(),
});

const closeWorld = async (world: FaultWorld): Promise<void> => {
  await world.server.close();
  await rm(world.root, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// The taxonomy rows
// ---------------------------------------------------------------------------

describe("runMirrorCommand fault taxonomy", () => {
  it("F1: retries exhausted on a 429 storm degrade the table, exit 2, run still ends clean", async () => {
    const world = await startWorld({
      faults: [rateLimitWithoutRetryAfter({ route: "table-page", table: "sys_script", times: 99 })],
    });
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server, { maxAttempts: 2 }) })
      );

      expect(run.exitCode).toBe(2);
      expect(run.fatal).toBeNull();
      expect(run.report.tables.sys_script).toMatchObject({
        status: "failed",
        reason: "transient-exhausted",
        mirroredRows: 0,
      });
      // Weather, not a verdict: the run ran to its end and the checkpoint cleared.
      expect(run.checkpointCleared).toBe(true);
      expect(await fileExists(world.root, CHECKPOINT_REL_PATH)).toBe(false);
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F2: an unrefreshable 401 is fatal, exit 1, leaves NO row for the table and keeps the checkpoint", async () => {
    const world = await startWorld({
      faults: [{ route: "table-page", table: "sys_script", status: 401, times: 99 }],
    });
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server) })
      );

      expect(run.exitCode).toBe(1);
      expect(run.fatal).not.toBeNull();
      expect(run.fatal?.failureClass).toBe("auth");
      expect(run.fatal?.diagnosis).toBe("auth failed");
      // The taxonomy's coverage column is "—" for F2: auth death is not a
      // statement about sys_script, so sys_script gets no row —
      expect(run.report.tables.sys_script).toBeUndefined();
      // — and neither do the tables the run never reached.
      expect(run.report.tables.sys_update_set_source).toBeUndefined();
      // Tables that finished BEFORE the death keep their rows.
      expect(run.report.tables.sys_hub_flow_base).toMatchObject({ status: "complete" });
      // The checkpoint survives a fatal end so the next run can resume.
      expect(run.checkpointCleared).toBe(false);
      expect(await fileExists(world.root, CHECKPOINT_REL_PATH)).toBe(true);
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F2 latch: exactly one auth refresh per RUN — the second 401 dies without a second refresh", async () => {
    const world = await startWorld({
      faults: [
        { route: "table-page", table: "sys_hub_flow_base", status: 401, times: 1 },
        { route: "table-page", table: "sys_script", status: 401, times: 1 },
      ],
    });
    const refreshAuth = jest.fn(() => Promise.resolve(true));
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server), refreshAuth })
      );

      // The first 401 spent the run's single refresh and the table recovered…
      expect(run.report.tables.sys_hub_flow_base).toMatchObject({ status: "complete" });
      // …so the second 401 found the latch spent and the run died as F2.
      expect(run.exitCode).toBe(1);
      expect(run.fatal?.failureClass).toBe("auth");
      expect(run.report.tables.sys_script).toBeUndefined();
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F3 at sweep time: a 403 mid-sweep makes the table partial with reason acl-403, exit 2", async () => {
    // The fault fires only on the table-page route, so the catalog's Aggregate
    // still counts the rows and the planner plans the table — the denial lands
    // on the SWEEP, which is where F3's partial-with-reason row comes from.
    const world = await startWorld({
      faults: [{ route: "table-page", table: "sys_script", status: 403, times: 99 }],
    });
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server) })
      );

      expect(run.exitCode).toBe(2);
      expect(run.fatal).toBeNull();
      expect(run.report.tables.sys_script).toMatchObject({
        status: "partial",
        reason: "acl-403",
        mirroredRows: 0,
      });
      // The denial is per-table: the rest of the sweep is untouched.
      expect(run.report.tables.sys_update_set_source).toMatchObject({ status: "complete" });
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F3 known at catalog time: a table the catalog already sees denied is SKIPPED acl-403, exit 0", async () => {
    // The fake's blanket ACL denial is visible to the catalog itself (the
    // aggregate 403s, the one-row probe 403s), so the planner never plans the
    // table. R3 still demands a row — skipped, with the ACL named — but a skip
    // decided before the sweep is not a degraded sweep, so the exit stays 0.
    const world = await startWorld({ aclDeniedTables: ["sys_script"] });
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server) })
      );

      expect(run.exitCode).toBe(0);
      expect(run.fatal).toBeNull();
      expect(run.report.tables.sys_script).toMatchObject({
        status: "skipped",
        reason: "acl-403",
        mirroredRows: 0,
      });
      expect(run.report.tables.sys_update_set_source).toMatchObject({ status: "complete" });
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F4: hibernating — fatal before the plan, exit 1, with the wake-it-up diagnosis", async () => {
    const world = await startWorld({ hibernating: true });
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, { client: clientFor(world.server), verifyQuiescent: true })
      );

      expect(run.exitCode).toBe(1);
      expect(run.fatal?.failureClass).toBe("hibernating");
      expect(run.fatal?.diagnosis).toBe("instance hibernating (wake it at developer.servicenow.com)");
      // The catalog never materialized: nothing to cover, nothing discovered.
      expect(run.report.tables).toEqual({});
      expect(run.report.totals.tablesDiscovered).toBe(0);
      expect(run.resumeDecision).toBeNull();
      expect(run.report.quiescent).toBeNull();
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("F4: unreachable — fatal before the plan, exit 1, with a DIFFERENT diagnosis than hibernating", async () => {
    // Start a real server just to obtain a base URL nobody is listening on.
    const server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
    const instance = server.baseUrl;
    await server.close();
    const root = await newRoot();
    try {
      const run = await runMirrorCommand(
        runOptions(root, {
          transport: {
            instance,
            authorization: basicAuth(),
            maxAttempts: 2,
            sleep: () => Promise.resolve(),
          },
        })
      );

      expect(run.exitCode).toBe(1);
      expect(run.fatal?.failureClass).toBe("unreachable");
      expect(run.fatal?.diagnosis).toBe("instance unreachable");
      // D4's point: the two dead-instance diagnoses are DISTINCT sentences.
      expect(run.fatal?.diagnosis).not.toBe(
        "instance hibernating (wake it at developer.servicenow.com)"
      );
      expect(run.report.tables).toEqual({});
      await expectReportsWritten(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("F5: a declared-but-never-delivered column makes the table partial, keeping the rows it got", async () => {
    // Only the bulk table is excluded here: sys_ui_action with its phantom
    // `hint` column IS the fixture.
    const world = await startWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, {
          client: clientFor(world.server),
          config: configOf({
            tables: { include: [], exclude: [BULK_TABLE_NAME], perTable: {} },
          }),
        })
      );

      expect(run.exitCode).toBe(2);
      expect(run.fatal).toBeNull();
      expect(run.report.tables.sys_ui_action).toMatchObject({
        status: "partial",
        reason: "column-missing",
        mirroredRows: 3,
      });
      await expectReportsWritten(world.root);
      world.server.assertNoViolations();
    } finally {
      await closeWorld(world);
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// The orchestrator's own soft-failure seams
// ---------------------------------------------------------------------------

/**
 * Wrap a real client so a scripted failure can be injected at one route while
 * everything else passes through untouched. The `armed` latch flips on the
 * first Aggregate call, because the catalog build finishes with aggregates —
 * anything after that belongs to the orchestrator's own reads.
 */
const failScopeIndexAfterCatalog = (
  inner: MirrorSweepClient,
  failureClass: "acl" | "auth"
): MirrorSweepClient => {
  let armed = false;
  return {
    getPage: (table, cursor, request): Promise<TablePage> => {
      if (armed && table === "sys_scope") {
        return Promise.reject(
          new MirrorHttpError(failureClass, `scripted ${failureClass} on the scope index`, {
            httpStatus: failureClass === "acl" ? 403 : 401,
          })
        );
      }
      return inner.getPage(table, cursor, request);
    },
    getAggregate: (table, extraQuery): Promise<TableAggregate | null> => {
      armed = true;
      return inner.getAggregate(table, extraQuery);
    },
  };
};

describe("runMirrorCommand scope-index degradation", () => {
  it("an acl-denied scope index degrades to global placement, not a failed run", async () => {
    const world = await startWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, {
          client: failScopeIndexAfterCatalog(clientFor(world.server), "acl"),
        })
      );

      // The sweep is untouched: exit 0, everything complete.
      expect(run.exitCode).toBe(0);
      expect(run.fatal).toBeNull();
      // But with no index, the corpus's x_syn_uni-scoped scripts could not be
      // named — every record landed under `global`.
      expect(await fileExists(world.root, join("instance", "x_syn_uni"))).toBe(false);
      expect(run.commitMessage).toContain("Mirror-Scopes: global");
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("an auth-dead scope index is a dead run, not a degraded one", async () => {
    const world = await startWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, {
          client: failScopeIndexAfterCatalog(clientFor(world.server), "auth"),
        })
      );

      expect(run.exitCode).toBe(1);
      expect(run.fatal?.failureClass).toBe("auth");
      expect(run.report.tables).toEqual({});
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);
});

/**
 * Wrap a real client so the POST-sweep Aggregate re-read (D1) misbehaves. The
 * latch flips when the sweep pages its first planned table — every aggregate
 * before that belongs to the catalog or the planner.
 */
const failPostQuiescence = (
  inner: MirrorSweepClient,
  behavior: "null" | "hibernating"
): MirrorSweepClient => {
  let sweepStarted = false;
  return {
    getPage: (table, cursor, request): Promise<TablePage> => {
      if (table === "sys_hub_flow_base") {
        sweepStarted = true;
      }
      return inner.getPage(table, cursor, request);
    },
    getAggregate: (table, extraQuery): Promise<TableAggregate | null> => {
      if (sweepStarted && table === "sys_script") {
        if (behavior === "null") {
          return Promise.resolve(null);
        }
        return Promise.reject(
          new MirrorHttpError("hibernating", "scripted hibernation mid-verify", {
            httpStatus: 200,
          })
        );
      }
      return inner.getAggregate(table, extraQuery);
    },
  };
};

describe("runMirrorCommand post-quiescence verification", () => {
  it("a table that vanishes from the post-reading flips quiescent to false, exit untouched", async () => {
    const world = await startWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, {
          client: failPostQuiescence(clientFor(world.server), "null"),
          verifyQuiescent: true,
        })
      );

      // R1 is about coverage, not consistency: the verdict changes, the code does not.
      expect(run.exitCode).toBe(0);
      expect(run.fatal).toBeNull();
      expect(run.report.quiescent).toBe(false);
      expect(run.commitMessage).not.toContain("Mirror-Consistency");
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);

  it("a fatal during the post-reading kills the run AFTER the sweep: exit 1, quiescent null, checkpoint kept", async () => {
    const world = await startWorld();
    try {
      const run = await runMirrorCommand(
        runOptions(world.root, {
          client: failPostQuiescence(clientFor(world.server), "hibernating"),
          verifyQuiescent: true,
        })
      );

      expect(run.exitCode).toBe(1);
      expect(run.fatal?.failureClass).toBe("hibernating");
      // The verdict is unknowable, not false: the re-read never finished.
      expect(run.report.quiescent).toBeNull();
      // The sweep itself HAD finished — its tables keep their rows.
      expect(run.report.tables.sys_script).toMatchObject({ status: "complete" });
      expect(run.checkpointCleared).toBe(false);
      expect(await fileExists(world.root, CHECKPOINT_REL_PATH)).toBe(true);
      await expectReportsWritten(world.root);
    } finally {
      await closeWorld(world);
    }
  }, 30000);
});
