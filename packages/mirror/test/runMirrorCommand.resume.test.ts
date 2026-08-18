// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `runMirrorCommand` interruption and resume (§4.7, WP-M8).
 *
 * The claim under test: a sweep killed mid-table and re-run lands on EXACTLY
 * the tree an uninterrupted sweep produces, without re-fetching the tables the
 * first attempt finished. Three instruments prove it:
 *
 *  - a control root swept once, cleanly, and hashed file-by-file;
 *  - a failing-`WriterFs` wrapper that dies on the Nth record write of one
 *    table — the injection lives at the WRITER seam, not the transport, because
 *    §4.7 is about local interruption (F8), and because throwing BEFORE the
 *    delegate runs guarantees no torn file exists for resume to trip over;
 *  - the fake server's cumulative request log, sliced per run, which shows the
 *    resumed run never asked for a table-page of any completed table while
 *    still re-reading the catalog (the plan is re-derived by design — the
 *    checkpoint pins the sweep's identity, not its worldview).
 *
 * Phase 1 deliberately resumes the INTERRUPTED table from row one: the writer's
 * full-mode flush is observed-only mid-sweep, so a keyset cursor cannot promise
 * the rows before it are on disk (INV-4). The test therefore asserts the
 * interrupted table IS re-paged, alongside the completed tables that are not.
 *
 * A second scenario moves the failure to the shard flush inside
 * `completeTable`: the orchestrator must withdraw the table's optimistic
 * coverage row (a table whose shards did not land is NOT covered, R3), record
 * the fatal as F8 `local-io`, and keep the checkpoint for the next attempt.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { CheckpointState, MirrorConfig } from "../src/contracts";
import { MirrorHttpClient } from "../src/http/client";
import {
  runMirrorCommand,
  type RunMirrorCommandOptions,
} from "../src/runMirrorCommand";
import { nodeWriterFs, type WriterFs } from "../src/write/fs";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
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
const SWEEP_ID = "sweep-resume-0001";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

const CLEAN_EXCLUDES = [BULK_TABLE_NAME, "sys_ui_action"];

const configOf = (): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: [...CLEAN_EXCLUDES], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
});

const clientFor = (server: FakeInstanceServer): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    pageSize: 5,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0.5,
  });

const newRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "syncrona-mirror-resume-"));

const runOptions = (
  root: string,
  server: FakeInstanceServer,
  overrides: Partial<RunMirrorCommandOptions> = {}
): RunMirrorCommandOptions => ({
  config: configOf(),
  root,
  fs: nodeWriterFs(),
  now: () => FROZEN_NOW,
  newSweepId: () => SWEEP_ID,
  full: true,
  client: clientFor(server),
  ...overrides,
});

/**
 * A `WriterFs` that throws on the write whose path satisfies `shouldFail` —
 * BEFORE delegating, so the failed write leaves nothing behind. Everything else
 * passes straight through to the real filesystem. `rejection` overrides the
 * default `Error`: the seam is injectable, so a foreign implementation may
 * reject with ANY value, and the orchestrator's fatal must still carry a
 * readable message rather than "[object Object]" luck.
 */
const failingFs = (
  shouldFail: (filePath: string) => boolean,
  rejection?: unknown
): WriterFs => {
  const inner = nodeWriterFs();
  return {
    makeDir: (dirPath) => inner.makeDir(dirPath),
    writeFile: (filePath, bytes) => {
      if (shouldFail(filePath)) {
        return Promise.reject(rejection ?? new Error("injected disk failure"));
      }
      return inner.writeFile(filePath, bytes);
    },
    rename: (fromPath, toPath) => inner.rename(fromPath, toPath),
    readFile: (filePath) => inner.readFile(filePath),
    readDir: (dirPath) => inner.readDir(dirPath),
    removeRecursive: (dirPath) => inner.removeRecursive(dirPath),
  };
};

/** Fail on the Nth write whose path contains `needle` (1-based). */
const failOnNthWrite = (needle: string, nth: number): WriterFs => {
  let seen = 0;
  return failingFs((filePath) => {
    if (!filePath.includes(needle)) {
      return false;
    }
    seen += 1;
    return seen === nth;
  });
};

/** Recursive content hash of every file under `root`, keyed by relative path. */
const treeHashes = async (root: string): Promise<Map<string, string>> => {
  const hashes = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      const full = join(dir, entry);
      if ((await stat(full)).isDirectory()) {
        await walk(full);
      } else {
        const digest = createHash("sha256").update(await readFile(full)).digest("hex");
        hashes.set(relative(root, full), digest);
      }
    }
  };
  await walk(root);
  return hashes;
};

const readCheckpointFile = async (root: string): Promise<CheckpointState> => {
  const bytes = await readFile(join(root, CHECKPOINT_REL_PATH));
  return JSON.parse(bytes.toString("utf8")) as CheckpointState;
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
// The scenarios
// ---------------------------------------------------------------------------

describe("runMirrorCommand checkpoint and resume", () => {
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

  it("a run killed mid-table resumes past the finished tables onto the control tree", async () => {
    // Control: one clean, uninterrupted sweep.
    const controlRoot = await trackedRoot();
    const control = await runMirrorCommand(runOptions(controlRoot, server));
    expect(control.exitCode).toBe(0);
    // The claim is about the MIRRORED tree, so `instance/` is what gets hashed:
    // coverage.json legitimately differs between the two roots (the resumed
    // run's `redactions` total counts only its own work — asserted below).
    const controlTree = await treeHashes(join(controlRoot, "instance"));

    // Attempt one: die on the third record write of sys_script.
    // `checkpointFlushEvery: 1` keeps the on-disk checkpoint current to the row,
    // which is what a real crash needs and what this test relies on.
    const resumeRoot = await trackedRoot();
    const beforeFirst = server.requests.length;
    const first = await runMirrorCommand(
      runOptions(resumeRoot, server, {
        fs: failOnNthWrite("/sys_script/", 3),
        checkpointFlushEvery: 1,
      })
    );

    expect(first.exitCode).toBe(1);
    expect(first.fatal?.failureClass).toBe("local-io");
    expect(first.fatal?.message).toBe("injected disk failure");
    expect(first.checkpointCleared).toBe(false);
    // F8 leaves no coverage row: a disk failure says nothing about the table.
    expect(first.report.tables.sys_script).toBeUndefined();

    // The checkpoint on disk names exactly the tables whose shards landed.
    const checkpoint = await readCheckpointFile(resumeRoot);
    expect(checkpoint.sweepId).toBe(SWEEP_ID);
    expect(checkpoint.completedTables).toEqual([
      "sys_hub_flow_base",
      "sys_hub_flow_snapshot",
      "sys_properties",
    ]);

    // Attempt two: same clock, same sweep id, healthy disk.
    const beforeSecond = server.requests.length;
    const second = await runMirrorCommand(runOptions(resumeRoot, server));

    expect(second.exitCode).toBe(0);
    expect(second.checkpointCleared).toBe(true);
    expect(await fileExists(resumeRoot, CHECKPOINT_REL_PATH)).toBe(false);
    // The resumed run's COVERAGE story is the control run's story, table for
    // table — the resumed-complete rows are reconstructed from the shards and
    // land on the same counts a fresh sweep reported.
    expect(second.report.tables).toEqual(control.report.tables);
    // Totals match except `redactions`: that counter measures the redaction
    // WORK this run performed, and a resumed run performs none for the tables
    // it skipped (the control's redactions live in sys_properties, which the
    // resume never re-fetched). Phase-1 limitation, deliberate: the checkpoint
    // records progress, not bookkeeping.
    expect(second.report.totals).toEqual({
      ...control.report.totals,
      redactions: second.report.totals.redactions,
    });
    expect(second.commitMessage).toContain(`Mirror-Sweep: ${SWEEP_ID}`);
    // …and it says out loud that it resumed.
    expect(second.resumeDecision?.completedTables).toContain("sys_hub_flow_base");

    // The request log: the resumed run re-read the catalog but never asked for
    // a page of any completed table — and DID re-page the interrupted table
    // from row one (Phase 1: mid-table cursors are not trusted, INV-4).
    const firstRunPages = server.requests
      .slice(beforeFirst, beforeSecond)
      .filter((request) => request.route === "table-page");
    const secondRunPages = server.requests
      .slice(beforeSecond)
      .filter((request) => request.route === "table-page");
    // Sanity: attempt one really did page the tables it completed.
    expect(firstRunPages.some((request) => request.table === "sys_hub_flow_base")).toBe(true);
    for (const completed of checkpoint.completedTables) {
      expect(secondRunPages.some((request) => request.table === completed)).toBe(false);
    }
    expect(secondRunPages.some((request) => request.table === "sys_script")).toBe(true);
    expect(secondRunPages.some((request) => request.table === "sys_choice")).toBe(true);
    expect(secondRunPages.some((request) => request.table === "sys_update_set_source")).toBe(true);

    // The final arbiter: the resumed tree is the control tree, byte for byte.
    expect(await treeHashes(join(resumeRoot, "instance"))).toEqual(controlTree);
  }, 60000);

  it("a shard flush that dies inside completeTable withdraws the row and records F8", async () => {
    const root = await trackedRoot();
    // The rejection is a bare STRING on purpose: `WriterFs` is a seam, and a
    // foreign implementation owes nobody an `Error` instance. The fatal's
    // message must still be the value, stringified — not a crash of its own.
    const run = await runMirrorCommand(
      runOptions(root, server, {
        fs: failingFs(
          (filePath) => filePath.includes(".shards") && filePath.includes("sys_script"),
          "shard flush refused by the disk"
        ),
      })
    );

    expect(run.exitCode).toBe(1);
    expect(run.fatal?.failureClass).toBe("local-io");
    expect(run.fatal?.table).toBe("sys_script");
    expect(run.fatal?.message).toBe("shard flush refused by the disk");
    // The optimistic complete row was withdrawn: shards on disk ARE the
    // definition of a finished table sweep (INV-4), and they did not land.
    expect(run.report.tables.sys_script).toBeUndefined();
    // Tables completed before the failure keep their rows and their shards.
    expect(run.report.tables.sys_hub_flow_base).toMatchObject({ status: "complete" });
    expect(run.checkpointCleared).toBe(false);
    expect(await fileExists(root, CHECKPOINT_REL_PATH)).toBe(true);
  }, 30000);
});
