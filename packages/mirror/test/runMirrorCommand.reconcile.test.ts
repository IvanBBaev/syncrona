// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `runMirrorCommand` — the two stages that run AFTER the sweep: reconcile
 * (§5.9) and the derived views (§5.12), as the orchestrator drives them.
 *
 * Both modules have their own unit suites (`reconciler.test.ts`,
 * `derivedViews.test.ts`); what is only testable here is the wiring, and the
 * wiring is where the interesting claims live:
 *
 *  - INV-5 end to end. The reconciler deletes on evidence it is HANDED, and the
 *    only thing that mints that evidence is a sweep this process ran to
 *    completion. Proving the chain needs a real sweep, a real instance that then
 *    loses a row, and a second real sweep — which is what the first test is. A
 *    unit test can hand the reconciler a `DeletionAuthority`; only this one can
 *    show that a table sweep produces the authority that removes the directory.
 *  - D2's report path. `generateDerivedViews` returns dangling references as a
 *    list; the coverage report carries them as a per-table count. The fold
 *    between the two happens here, and the fixture supplies a genuine tear —
 *    a `sys_db_object` row whose `super_class` names a table the corpus does not
 *    contain — so nothing has to be manufactured to test it.
 *  - The two failure seams. Reconcile and derived-view regeneration touch only
 *    the local tree, so their failures are F8 (`local-io`) and must end the run
 *    the way a failed shard flush does: exit 1, and the checkpoint LEFT IN PLACE
 *    so the next run resumes rather than re-sweeping what this one proved. Both
 *    are driven by a `WriterFs` that refuses one specific operation, chosen so
 *    that nothing else in the run can trip it.
 *
 * `assertNoViolations()` closes every server: reconcile removes directories, and
 * it must still do so without the engine ever leaving GET (INV-2).
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { MirrorConfig, RecordEntry } from "../src/contracts";
import { DERIVED_DIR_NAME } from "../src/derived/render";
import { MirrorHttpClient } from "../src/http/client";
import { listScopesWithShards, loadShardSet } from "../src/shards/shardStore";
import {
  runMirrorCommand,
  type RunMirrorCommandOptions,
} from "../src/runMirrorCommand";
import { nodeWriterFs, type WriterFs } from "../src/write/fs";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
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

/**
 * The one table these tests sweep.
 *
 * `sys_properties` is four rows, it is T2 config (so no tier flag is needed to
 * reach it), and — unlike `sys_script` and `sys_choice` — it has no case-collision
 * pair, so D18's re-naming churn cannot write into the record directories these
 * tests watch. That matters most for the failure seams below, where the whole
 * point is that exactly one filesystem operation is refused.
 */
const SOLO_TABLE = "sys_properties";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

/**
 * Every corpus table except one, so the sweep is genuinely single-table.
 *
 * Derived from the corpus rather than written out, so that a table added to the
 * fixture joins the exclusion list instead of silently joining these runs.
 */
const allTablesExcept = (keep: string): string[] =>
  loadCommittedCorpus()
    .tables.map((table) => table.name)
    .filter((name) => name !== keep);

const configOf = (overrides: Partial<MirrorConfig> = {}): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: [], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
  ...overrides,
});

const soloConfig = (): MirrorConfig =>
  configOf({
    tables: { include: [], exclude: allTablesExcept(SOLO_TABLE), perTable: {} },
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

const runOptions = (
  root: string,
  server: FakeInstanceServer,
  overrides: Partial<RunMirrorCommandOptions> = {}
): RunMirrorCommandOptions => ({
  config: soloConfig(),
  root,
  fs: nodeWriterFs(),
  now: () => FROZEN_NOW,
  newSweepId: () => SWEEP_ID,
  full: true,
  client: clientFor(server),
  ...overrides,
});

const dirExists = async (absPath: string): Promise<boolean> => {
  try {
    return (await stat(absPath)).isDirectory();
  } catch {
    return false;
  }
};

const fileExists = async (absPath: string): Promise<boolean> => {
  try {
    return (await stat(absPath)).isFile();
  } catch {
    return false;
  }
};

/** The shard entry one scope's set holds for a sys_id, or `null`. */
const entryFor = async (
  root: string,
  table: string,
  sysId: string
): Promise<{ scope: string; entry: RecordEntry } | null> => {
  const fs = nodeWriterFs();
  for (const scope of await listScopesWithShards(fs, root, table)) {
    const set = await loadShardSet(fs, root, scope, table);
    const entry = set.entries.get(sysId);
    if (entry !== undefined) {
      return { scope, entry };
    }
  }
  return null;
};

/**
 * A `WriterFs` that performs every operation except the one it is told to
 * refuse — the local-I/O fault injector for the two F8 seams.
 *
 * `refuse` names a method and a predicate on its first argument, rather than
 * being a general recorder with a call count, because both seams need the throw
 * pinned to ONE identifiable path: a count would move the moment the writer's
 * internals changed, and a test that fails for that reason is a test nobody
 * trusts.
 */
const fsRefusing = (
  method: "rename" | "readDir",
  matches: (target: string) => boolean
): WriterFs => {
  const real = nodeWriterFs();
  return {
    ...real,
    rename: async (from, to) => {
      if (method === "rename" && matches(from)) {
        throw new Error(`refused rename of ${from}`);
      }
      return real.rename(from, to);
    },
    readDir: async (dir) => {
      if (method === "readDir" && matches(dir)) {
        throw new Error(`refused readDir of ${dir}`);
      }
      return real.readDir(dir);
    },
  };
};

// ---------------------------------------------------------------------------
// Reconcile (§5.9)
// ---------------------------------------------------------------------------

describe("runMirrorCommand reconciles a completed sweep", () => {
  let server: FakeInstanceServer;
  const roots: string[] = [];

  const trackedRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "syncrona-mirror-reconcile-"));
    roots.push(root);
    return root;
  };

  beforeEach(async () => {
    // A fresh server per test: these mutate the corpus, and a shared instance
    // would make one test's deletion another test's starting condition.
    server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
  });

  afterEach(async () => {
    server.assertNoViolations();
    await server.close();
  });

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("INV-5: deletes the record a completed sweep proved is gone", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);

    const victim = server.rowsOf(SOLO_TABLE)[0];
    expect(victim).toBeDefined();
    const sysId = String(victim?.sys_id);
    const located = await entryFor(root, SOLO_TABLE, sysId);
    expect(located).not.toBeNull();
    const recordDir = join(root, located?.entry.path ?? "");
    expect(await dirExists(recordDir)).toBe(true);

    // The row leaves the instance BETWEEN the two runs, so the second sweep is a
    // complete observation of a table that no longer contains it — the exact
    // evidence §5.9 acts on, and the only one it accepts.
    server.mutate({ table: SOLO_TABLE, deleteSysIds: [sysId] });

    const second = await runMirrorCommand(runOptions(root, server));
    expect(second.exitCode).toBe(0);
    expect(second.fatal).toBeNull();

    // The directory is gone, and no shard set claims the sys_id any more. The
    // second assertion is not implied by the first: a flush that dropped the
    // entry while leaving the directory behind would pass one and fail the
    // other, and that combination — a record on disk no shard claims — is
    // precisely what INV-4 forbids the tree to contain.
    expect(await dirExists(recordDir)).toBe(false);
    expect(await entryFor(root, SOLO_TABLE, sysId)).toBeNull();
    expect(second.report.tables[SOLO_TABLE]?.mirroredRows).toBe(
      (first.report.tables[SOLO_TABLE]?.mirroredRows ?? 0) - 1
    );
    // A deletion is a changed table (D10). The flush already reports this one,
    // since dropping an entry rewrites the shard; the orchestrator adds the
    // table from the reconciliation as well, so a deletion that somehow left the
    // shard byte-identical would still be counted rather than committed silently.
    expect(second.commitMessage).toContain("Mirror-Tables-Changed: 1");
  });

  it("F8: a refused deletion ends the run and leaves the checkpoint in place", async () => {
    const root = await trackedRoot();

    const first = await runMirrorCommand(runOptions(root, server));
    expect(first.exitCode).toBe(0);
    // A clean run clears its checkpoint; the failing run below must not.
    expect(await fileExists(join(root, CHECKPOINT_REL_PATH))).toBe(false);

    const victim = server.rowsOf(SOLO_TABLE)[0];
    const sysId = String(victim?.sys_id);
    const located = await entryFor(root, SOLO_TABLE, sysId);
    const recordDir = join(root, located?.entry.path ?? "");
    server.mutate({ table: SOLO_TABLE, deleteSysIds: [sysId] });

    // `atomicRemoveDir` renames the doomed directory aside before removing it, so
    // refusing the rename OF THAT DIRECTORY refuses exactly the deletion. Nothing
    // else in the run renames a live record directory: the writer's own renames
    // move a staging sibling INTO place, and this record is not written at all —
    // it is the one the instance no longer has.
    const second = await runMirrorCommand(
      runOptions(root, server, {
        fs: fsRefusing("rename", (from) => from === recordDir),
      })
    );

    expect(second.exitCode).toBe(1);
    expect(second.fatal?.failureClass).toBe("local-io");
    expect(second.fatal?.table).toBeNull();
    expect(second.fatal?.message).toContain("refused rename");
    // The tree is left as it was — D2's sibling rule for deletions: a removal
    // that could not complete leaves the record, it does not half-remove it.
    expect(await dirExists(recordDir)).toBe(true);
    // The checkpoint survives, so the next run resumes rather than re-sweeping.
    expect(second.checkpointCleared).toBe(false);
    expect(await fileExists(join(root, CHECKPOINT_REL_PATH))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Derived views (§5.12, INV-9)
// ---------------------------------------------------------------------------

describe("runMirrorCommand regenerates the derived views", () => {
  let server: FakeInstanceServer;
  const roots: string[] = [];

  const trackedRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "syncrona-mirror-derived-"));
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

  it("D2: folds each dangling reference into the coverage row that holds it", async () => {
    const root = await trackedRoot();

    // The refs view can only know what a reference column IS from the mirrored
    // `sys_dictionary` (INV-9 forbids asking the instance), and it only counts a
    // reference dangling when the target table is mirrored COMPLETE. Both tables
    // are force-included for that reason — the tier rules would otherwise leave
    // the tree with no schema knowledge at all, and the honest answer would be
    // zero dangling references rather than the one the corpus really contains.
    const result = await runMirrorCommand(
      runOptions(root, server, {
        config: configOf({
          tables: {
            include: ["sys_db_object", "sys_dictionary"],
            exclude: allTablesExcept("sys_db_object").filter(
              (name) => name !== "sys_dictionary"
            ),
            perTable: {},
          },
          derived: { forms: false, workflows: false, refs: true, aclMatrix: false },
        }),
      })
    );

    expect(result.exitCode).toBe(0);
    // The fixture's own tear: one `sys_db_object` row whose `super_class` names a
    // sys_id no complete shard set of `sys_db_object` claims.
    expect(result.report.tables["sys_db_object"]?.danglingRefs).toBe(1);
    // The count lands on the table holding the REFERENCE, not on the table the
    // reference points at — here they happen to be the same table, so the
    // neighbouring row is what tells the two readings apart: `sys_dictionary`
    // holds no dangling reference and therefore carries no count at all, rather
    // than a zero. D2 reports tears; it does not annotate every row with their
    // absence.
    expect(result.report.tables["sys_dictionary"]?.danglingRefs).toBeUndefined();
    expect(result.report.totals.danglingRefs).toBe(1);
  });

  it("reports no dangling references when the views are off", async () => {
    const root = await trackedRoot();

    // Regeneration is unconditional, but the refs view is not: with `refs` off
    // the summary carries no references at all, so no coverage row may acquire a
    // count. A zero here and a zero above would mean different things — this one
    // is "nobody looked" — and the report says so by omitting the field.
    const result = await runMirrorCommand(runOptions(root, server));

    expect(result.exitCode).toBe(0);
    expect(result.report.tables[SOLO_TABLE]?.danglingRefs).toBeUndefined();
    expect(result.report.totals.danglingRefs).toBe(0);
  });

  it("F8: a refused regeneration ends the run", async () => {
    const root = await trackedRoot();

    // `generateDerivedViews` starts by removing its four managed subtrees, and
    // the removal starts by listing the directory — so a `readDir` refused under
    // `_derived/` is refused before any view is written, whatever the config
    // enables. Nothing else in the run reads that path: the canonical reader
    // walks `instance/`, which is what INV-9 means by "regenerable from
    // canonical alone".
    const derivedPrefix = join(root, DERIVED_DIR_NAME);
    const result = await runMirrorCommand(
      runOptions(root, server, {
        fs: fsRefusing("readDir", (dir) => dir.startsWith(derivedPrefix)),
      })
    );

    expect(result.exitCode).toBe(1);
    expect(result.fatal?.failureClass).toBe("local-io");
    expect(result.fatal?.table).toBeNull();
    expect(result.fatal?.message).toContain("refused readDir");
    // The sweep itself succeeded, so its checkpoint is what a resumed run needs:
    // the tables are already proved, and only the views have to be rebuilt.
    expect(result.checkpointCleared).toBe(false);
    expect(await fileExists(join(root, CHECKPOINT_REL_PATH))).toBe(true);
  });
});
