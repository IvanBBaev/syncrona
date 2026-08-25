// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The reconcile cadence, end to end — §5.4's `reconcileEveryNSyncs` as a thing that
 * actually happens (INV-1, INV-5, R3).
 *
 * `reconcileEveryNSyncs` was configurable, documented and unreachable. The Planner
 * takes the run's ordinal as an input and nothing supplied one, so it defaulted to 1
 * on every run, `1 % 10` was never 0, and every sync in the product's history planned
 * `incremental`. That is not a cosmetic defect: a reconcile-mode plan forces
 * `strategy: "sweep"` for every table, a sweep is the only thing that mints the
 * `DeletionAuthority` INV-5 demands, and so an unreachable cadence means DELETIONS ON
 * THE INSTANCE NEVER REACH THE MIRROR — the tree grows monotonically until an
 * operator remembers `--full` by hand.
 *
 * Every test below fails on that code, and the second one fails by leaving a deleted
 * record on disk rather than by disagreeing about a string. The suite is deliberately
 * end-to-end for a reason the planner's own unit tests cannot cover: the ordinal has
 * to survive between two separate `runMirrorCommand` calls, through a file, and the
 * only way to show that is to run the command twice.
 *
 * What each test pins:
 *
 *  - the count PERSISTS, so run two knows it is run two;
 *  - the Nth run reconciles, and the deletion it authorizes lands — with the (N-1)th
 *    run demonstrated NOT to delete, so the promotion is doing the work rather than
 *    some unrelated sweep;
 *  - a fatal run does not consume its slot, which is a correctness requirement and
 *    not a preference: `decideResume` refuses a resume across a mode change, so a
 *    consumed slot would retry a dead reconcile as an incremental and discard every
 *    table it had already swept;
 *  - `reconcile: true` promotes a run the count would have left alone, `full` still
 *    outranks it, and neither rewrites the count;
 *  - a damaged counter restarts the cadence LOUDLY (R3) instead of crashing or
 *    pretending;
 *  - `.mirror/` stays invisible to git, which is what lets a per-run counter exist at
 *    all without breaking INV-1.
 *
 * The harness is `runMirrorCommand.reconcile.test.ts`' single-table one, for the same
 * reasons: `sys_properties` is four rows, it is T2 (so no tier flag), and it has no
 * case-collision pair whose D18 renames could disturb the record directories these
 * tests watch. Several tests run the command three times, so a whole-corpus sweep
 * would make this file the slowest in the package for no additional coverage.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { MirrorConfig, RecordEntry } from "../src/contracts";
import { DERIVED_DIR_NAME } from "../src/derived/render";
import { MirrorHttpClient } from "../src/http/client";
import {
  runMirrorCommand,
  type RunMirrorCommandOptions,
} from "../src/runMirrorCommand";
import { listScopesWithShards, loadShardSet } from "../src/shards/shardStore";
import { readSyncCounter, SYNC_COUNTER_REL_PATH } from "../src/syncCounter";
import { nodeWriterFs, type WriterFs } from "../src/write/fs";
import { MIRROR_IGNORE_REL_PATH } from "../src/write/gitIgnore";
import {
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  loadCommittedCorpus,
} from "./fakeInstance";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FROZEN_NOW = "2026-03-01T10:00:00.000Z";
const SWEEP_ID = "sweep-fixed-0001";
const SOLO_TABLE = "sys_properties";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

const allTablesExcept = (keep: string): string[] =>
  loadCommittedCorpus()
    .tables.map((table) => table.name)
    .filter((name) => name !== keep);

/**
 * The solo-table config, with the cadence length as the one knob these tests turn.
 *
 * Defaulting to 3 rather than the product's 10 keeps a full cycle at three runs.
 * Nothing in the promotion depends on the value — `cadencePosition` is the same
 * modulo either way — and the tests that care about the shipped default say 10.
 */
const cadenceConfig = (reconcileEveryNSyncs = 3): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: allTablesExcept(SOLO_TABLE), perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs, requestsPerSecond: 4, pageSize: 1000 },
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

/**
 * A run of the command as an operator's plain `syncrona mirror sync` — no `full`,
 * because the whole subject of this file is what happens when nobody passes it.
 */
const runOptions = (
  root: string,
  server: FakeInstanceServer,
  overrides: Partial<RunMirrorCommandOptions> = {}
): RunMirrorCommandOptions => ({
  config: cadenceConfig(),
  root,
  fs: nodeWriterFs(),
  now: () => FROZEN_NOW,
  newSweepId: () => SWEEP_ID,
  client: clientFor(server),
  ...overrides,
});

/** The count as the production reader sees it — never a hand-parsed file. */
const completedSyncs = async (root: string): Promise<number | null> => {
  const read = await readSyncCounter(nodeWriterFs(), root);
  return read.present ? read.state.completedSyncs : null;
};

const dirExists = async (absPath: string): Promise<boolean> => {
  try {
    return (await stat(absPath)).isDirectory();
  } catch {
    return false;
  }
};

/** The shard entry one scope's set holds for a sys_id, or `null`. */
const entryFor = async (
  root: string,
  table: string,
  sysId: string
): Promise<RecordEntry | null> => {
  const fs = nodeWriterFs();
  for (const scope of await listScopesWithShards(fs, root, table)) {
    const entry = (await loadShardSet(fs, root, scope, table)).entries.get(sysId);
    if (entry !== undefined) {
      return entry;
    }
  }
  return null;
};

/** A `WriterFs` that refuses `readDir` under one prefix — the F8 fault injector. */
const fsRefusingReadDir = (matches: (dir: string) => boolean): WriterFs => {
  const real = nodeWriterFs();
  return {
    ...real,
    readDir: async (dir) => {
      if (matches(dir)) {
        throw new Error(`refused readDir of ${dir}`);
      }
      return real.readDir(dir);
    },
  };
};

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");

/** `git check-ignore` as a boolean — it signals the answer through its exit code. */
const gitIgnores = (root: string, relPath: string): boolean => {
  try {
    git(root, "check-ignore", "-q", relPath);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------

describe("runMirrorCommand keeps the §5.4 reconcile cadence", () => {
  let server: FakeInstanceServer;
  const roots: string[] = [];

  const trackedRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "syncrona-mirror-cadence-"));
    roots.push(root);
    return root;
  };

  beforeEach(async () => {
    // Fresh per test: the deletion test mutates the corpus, and a shared instance
    // would make one test's deletion another test's starting condition.
    server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
  });

  afterEach(async () => {
    // Deletions and promotions and all, the engine never leaves GET (INV-2).
    server.assertNoViolations();
    await server.close();
  });

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("counts its runs on disk, so each sync knows its own ordinal", async () => {
    const root = await trackedRoot();
    const options = (): RunMirrorCommandOptions =>
      runOptions(root, server, { config: cadenceConfig(10) });

    const first = await runMirrorCommand(options());
    expect(first.exitCode).toBe(0);
    expect(first.syncCadence).toEqual({
      ordinal: 1,
      everyN: 10,
      syncsUntilReconcile: 9,
      forced: false,
    });
    // The count is durable at the moment the run ends, not at the moment the next
    // one starts: this is the assertion that fails on a stateless implementation.
    expect(await completedSyncs(root)).toBe(1);

    const second = await runMirrorCommand(options());
    expect(second.syncCadence.ordinal).toBe(2);
    expect(second.syncCadence.syncsUntilReconcile).toBe(8);

    const third = await runMirrorCommand(options());
    expect(third.syncCadence.ordinal).toBe(3);
    expect(await completedSyncs(root)).toBe(3);

    // None of them was promoted — with N=10 the cadence is still seven runs away,
    // and a run that reconciled early would be as wrong as one that never does.
    for (const run of [first, second, third]) {
      expect(run.report.mode).toBe("incremental");
      expect(run.syncCounterWarning).toBeNull();
    }
  }, 30000);

  it("INV-5: the Nth sync is promoted, and the deletion it authorizes lands", async () => {
    const root = await trackedRoot();

    // Sync 1 populates the tree. The instance then loses a row, so from here on
    // the mirror holds a record the instance does not.
    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);
    expect(first.report.mode).toBe("incremental");

    const victim = server.rowsOf(SOLO_TABLE)[0];
    expect(victim).toBeDefined();
    const sysId = String(victim?.sys_id);
    const entry = await entryFor(root, SOLO_TABLE, sysId);
    expect(entry).not.toBeNull();
    const recordDir = join(root, entry?.path ?? "");
    expect(await dirExists(recordDir)).toBe(true);

    server.mutate({ table: SOLO_TABLE, deleteSysIds: [sysId] });

    // Sync 2 is an ordinary incremental: it walks by watermark, so it never
    // OBSERVES the table whole and therefore mints no deletion authority. The
    // record stays — correctly. This is the state the product was permanently
    // stuck in, and asserting it here is what makes the next block a promotion
    // rather than a coincidence.
    const second = await runMirrorCommand(runOptions(root, server));
    expect(second.exitCode).toBe(0);
    expect(second.report.mode).toBe("incremental");
    expect(second.syncCadence.syncsUntilReconcile).toBe(1);
    expect(await dirExists(recordDir)).toBe(true);
    expect(await entryFor(root, SOLO_TABLE, sysId)).not.toBeNull();

    // Sync 3 of 3 is the cadence, with nobody having asked for anything.
    const third = await runMirrorCommand(runOptions(root, server));
    expect(third.exitCode).toBe(0);
    expect(third.report.mode).toBe("reconcile");
    expect(third.syncCadence).toEqual({
      ordinal: 3,
      everyN: 3,
      syncsUntilReconcile: 0,
      // Not forced: the count did this, which is the entire point.
      forced: false,
    });

    // The record is gone from the tree AND from the shard set. The second claim
    // is not implied by the first: a flush that dropped the entry while leaving
    // the directory would satisfy one and violate INV-4 through the other.
    expect(await dirExists(recordDir)).toBe(false);
    expect(await entryFor(root, SOLO_TABLE, sysId)).toBeNull();
    expect(third.report.tables[SOLO_TABLE]?.mirroredRows).toBe(
      (first.report.tables[SOLO_TABLE]?.mirroredRows ?? 0) - 1
    );

    // And the cycle restarts rather than sticking at the reconcile.
    const fourth = await runMirrorCommand(runOptions(root, server));
    expect(fourth.report.mode).toBe("incremental");
    expect(fourth.syncCadence).toMatchObject({ ordinal: 4, syncsUntilReconcile: 2 });
  }, 60000);

  it("a fatal run does not consume its slot", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);
    expect(await completedSyncs(root)).toBe(1);

    // F8 in the derived-view regeneration: the sweep itself succeeded, the run
    // did not. `generateDerivedViews` starts by removing its managed subtrees and
    // the removal starts by listing them, so a refused `readDir` under `_derived/`
    // ends the run without touching anything the counter cares about.
    const failed = await runMirrorCommand(
      runOptions(root, server, {
        fs: fsRefusingReadDir((dir) => dir.startsWith(join(root, DERIVED_DIR_NAME))),
      })
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.fatal?.failureClass).toBe("local-io");
    // It planned as sync 2 — it really was the second attempt...
    expect(failed.syncCadence.ordinal).toBe(2);
    // ...but it did not finish, so it did not count. A consumed slot here would
    // push the retry to ordinal 3, which under N=3 is a MODE CHANGE, and
    // `decideResume` refuses a resume across one: the retry would throw away
    // every table this run had already swept and re-fetch them.
    expect(await completedSyncs(root)).toBe(1);

    const retry = await runMirrorCommand(runOptions(root, server));
    expect(retry.exitCode).toBe(0);
    expect(retry.syncCadence.ordinal).toBe(2);
    expect(retry.report.mode).toBe(failed.report.mode);
    expect(await completedSyncs(root)).toBe(2);
  }, 60000);

  it("`--reconcile` promotes a run the count would have left alone", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);

    // Sync 2 of 3 — the cadence says incremental; the operator says otherwise.
    const forced = await runMirrorCommand(runOptions(root, server, { reconcile: true }));
    expect(forced.exitCode).toBe(0);
    expect(forced.report.mode).toBe("reconcile");
    expect(forced.syncCadence).toEqual({
      ordinal: 2,
      everyN: 3,
      // Reported from the COUNT, not from what the override produced: the
      // operator needs to know the automatic one is still one run away.
      syncsUntilReconcile: 1,
      forced: true,
    });

    // The override answers a question about today. It does not move the cadence,
    // so sync 3 is still the scheduled reconcile — a forced run that reset the
    // count would silently push the next automatic one out by a full cycle.
    expect(await completedSyncs(root)).toBe(2);
    const third = await runMirrorCommand(runOptions(root, server));
    expect(third.report.mode).toBe("reconcile");
    expect(third.syncCadence.forced).toBe(false);
  }, 60000);

  it("`full` outranks `--reconcile` when both are asked for", async () => {
    const root = await trackedRoot();

    // Not merely a precedence detail: a full sweep is strictly stronger (it also
    // re-fetches every row), so answering "reconcile" to a caller who asked for
    // both would be a downgrade, and the report would name a mode weaker than the
    // work actually done.
    const run = await runMirrorCommand(
      runOptions(root, server, { full: true, reconcile: true })
    );
    expect(run.exitCode).toBe(0);
    expect(run.report.mode).toBe("full");
    expect(run.syncCadence).toMatchObject({ ordinal: 1, forced: true });
  }, 30000);

  it("an explicit syncOrdinal moves this run without rewriting the count", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);

    const jumped = await runMirrorCommand(runOptions(root, server, { syncOrdinal: 3 }));
    expect(jumped.report.mode).toBe("reconcile");
    expect(jumped.syncCadence.ordinal).toBe(3);
    // The count advances from what was READ, so the mirror's history says two
    // runs happened — because two runs happened.
    expect(await completedSyncs(root)).toBe(2);
  }, 30000);

  it("R3: a damaged counter restarts the cadence and says so", async () => {
    const root = await trackedRoot();

    const counterPath = join(root, SYNC_COUNTER_REL_PATH);
    await mkdir(dirname(counterPath), { recursive: true });
    await writeFile(counterPath, '{"formatVersion":1,"completedSyncs":', "utf8");

    // Degrading rather than crashing: the file is machine-local and regenerable,
    // and refusing to mirror an instance over a damaged bookkeeping file would
    // turn a cosmetic problem into an outage.
    const run = await runMirrorCommand(runOptions(root, server));
    expect(run.exitCode).toBe(0);
    expect(run.syncCadence.ordinal).toBe(1);
    // Loudly, though: the consequence of the restart is that the next automatic
    // reconcile is up to a full cycle further away than the operator expects, and
    // on this mirror that means records staying after they left the instance.
    expect(run.syncCounterWarning).toContain("not valid JSON");
    expect(run.syncCounterWarning).toContain("--reconcile");

    // And the damage is repaired, so the warning appears once rather than every
    // run until somebody deletes the file.
    expect(await completedSyncs(root)).toBe(1);
    const next = await runMirrorCommand(runOptions(root, server));
    expect(next.syncCounterWarning).toBeNull();
    expect(next.syncCadence.ordinal).toBe(2);
  }, 30000);

  it("INV-1: the counter it just wrote is invisible to git", async () => {
    const root = await trackedRoot();

    const run = await runMirrorCommand(runOptions(root, server));
    expect(run.exitCode).toBe(0);
    // The file really is there — otherwise the ignore assertion below would pass
    // for the wrong reason.
    expect(await completedSyncs(root)).toBe(1);

    git(root, "init", "-q");
    const porcelain = git(root, "status", "--porcelain");
    // Not even as an untracked entry: `git add -A` in any CI wrapper would
    // otherwise commit one machine's cadence position into every clone, and the
    // next sync's increment would dirty a tree INV-1 promises is clean.
    expect(porcelain).not.toContain(".mirror");
    expect(gitIgnores(root, SYNC_COUNTER_REL_PATH)).toBe(true);
    // The scaffold hides itself too — no `!.gitignore` exception, so the mirror
    // never asks anyone to commit a file it generates.
    expect(gitIgnores(root, MIRROR_IGNORE_REL_PATH)).toBe(true);
  }, 30000);
});
