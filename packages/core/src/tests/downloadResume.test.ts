// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import {
  computeMissingFingerprint,
  downloadTablesWithResume,
  DownloadTableDeps,
} from "../appUtils.js";
import { DownloadCheckpoint } from "../downloadCheckpoint.js";

// G3: the resumable download loop — progress, per-table checkpointing, resume
// skipping and checkpoint cleanup, tested with injected deps (no net / disk).

function missingMap(tables: string[]): SN.MissingFileTableMap {
  const m: Record<string, unknown> = {};
  for (const t of tables) {
    m[t] = { rec1: [{ name: "script", type: "js" }] };
  }
  return m as unknown as SN.MissingFileTableMap;
}

// A non-empty fetched result for one table — the shape downloadTablesWithResume
// inspects to tell a real download apart from a silently-skipped inaccessible
// table (which returns no entry for the table at all).
function fetchedTable(table: string): SN.TableMap {
  return {
    [table]: {
      records: { rec1: { sys_id: "s1", name: "rec1", files: [] } },
    },
  } as unknown as SN.TableMap;
}

interface Calls {
  fetched: string[];
  written: number;
  checkpoints: string[][];
  deleted: number;
}

function makeDeps(
  overrides: Partial<DownloadTableDeps> = {},
  checkpoint: DownloadCheckpoint | null = null
): { deps: DownloadTableDeps; calls: Calls } {
  const calls: Calls = { fetched: [], written: 0, checkpoints: [], deleted: 0 };
  const deps: DownloadTableDeps = {
    fetchTable: async (tm) => {
      const table = Object.keys(tm)[0];
      calls.fetched.push(table);
      return fetchedTable(table);
    },
    writeTable: async () => {
      calls.written += 1;
    },
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (cp) => {
      calls.checkpoints.push([...cp.completedTables]);
    },
    deleteCheckpoint: async () => {
      calls.deleted += 1;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("downloadTablesWithResume", () => {
  it("downloads every table and checkpoints after each, then clears it", async () => {
    const { deps, calls } = makeDeps();
    await downloadTablesWithResume(missingMap(["a", "b", "c"]), "x_app", deps);

    expect(calls.fetched).toEqual(["a", "b", "c"]);
    expect(calls.written).toBe(3);
    expect(calls.checkpoints).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
    expect(calls.deleted).toBe(1);
  });

  it("resumes by skipping already-completed tables", async () => {
    const { deps, calls } = makeDeps({}, { scope: "x_app", completedTables: ["a"] });
    await downloadTablesWithResume(missingMap(["a", "b", "c"]), "x_app", deps);

    expect(calls.fetched).toEqual(["b", "c"]);
    expect(calls.written).toBe(2);
    expect(calls.checkpoints).toEqual([
      ["a", "b"],
      ["a", "b", "c"],
    ]);
    expect(calls.deleted).toBe(1);
  });

  it("keeps the checkpoint when a table fails mid-run", async () => {
    const { deps, calls } = makeDeps({
      fetchTable: async (tm) => {
        const table = Object.keys(tm)[0];
        if (table === "b") throw new Error("network down");
        calls.fetched.push(table);
        return fetchedTable(table);
      },
    });

    await expect(
      downloadTablesWithResume(missingMap(["a", "b", "c"]), "x_app", deps)
    ).rejects.toThrow("network down");

    // "a" was written + checkpointed; the loop stopped at "b"; nothing cleared.
    expect(calls.fetched).toEqual(["a"]);
    expect(calls.written).toBe(1);
    expect(calls.checkpoints).toEqual([["a"]]);
    expect(calls.deleted).toBe(0);
  });

  it("clears a stale checkpoint when everything is already done", async () => {
    const { deps, calls } = makeDeps(
      {},
      { scope: "x_app", completedTables: ["a", "b"] }
    );
    await downloadTablesWithResume(missingMap(["a", "b"]), "x_app", deps);

    expect(calls.fetched).toEqual([]);
    expect(calls.written).toBe(0);
    expect(calls.deleted).toBe(1);
  });

  it("does not mark a silently-skipped (400/403/404) table complete and signals failure", async () => {
    const oldExit = process.exitCode;
    process.exitCode = 0;
    // "b" comes back with NO entry in the fetched map — exactly what
    // buildBulkDownloadFromTableAPI returns for an inaccessible table it skipped.
    const { deps, calls } = makeDeps({
      fetchTable: async (tm) => {
        const table = Object.keys(tm)[0];
        calls.fetched.push(table);
        return table === "b"
          ? ({} as SN.TableMap)
          : fetchedTable(table);
      },
    });

    await downloadTablesWithResume(missingMap(["a", "b", "c"]), "x_app", deps);

    // Every table was attempted (writeTable ran for each, empty or not)…
    expect(calls.fetched).toEqual(["a", "b", "c"]);
    expect(calls.written).toBe(3);
    // …but "b" must NOT appear in any checkpoint — only the genuinely-downloaded
    // tables are recorded, so a rerun retries "b".
    expect(calls.checkpoints).toEqual([["a"], ["a", "c"]]);
    // The checkpoint is preserved (not deleted) because the pull is incomplete…
    expect(calls.deleted).toBe(0);
    // …and the shell sees a non-zero exit so CI can't mistake it for success.
    expect(process.exitCode).toBe(1);

    process.exitCode = oldExit;
  });

  // Keyed on the scope alone, a checkpoint survived a `refresh` that added
  // records to an already-completed table: the resume skipped that table as
  // "done", its new files were never fetched, and the run still reported
  // success. The checkpoint must be bound to the work it was recorded against.
  it("keys the checkpoint on the work it was recorded against", async () => {
    const seen: Array<string | undefined> = [];
    const written: Array<string | undefined> = [];
    const missing = missingMap(["a", "b"]);
    const { deps } = makeDeps({
      readCheckpoint: async (_scope: string, fingerprint?: string) => {
        seen.push(fingerprint);
        return null;
      },
      writeCheckpoint: async (cp) => {
        written.push(cp.fingerprint);
      },
    });

    await downloadTablesWithResume(missing, "x_app", deps);

    const expected = computeMissingFingerprint(missing);
    expect(seen).toEqual([expected]);
    expect(written).toEqual([expected, expected]);
  });
});

describe("computeMissingFingerprint", () => {
  it("does not depend on key iteration order", () => {
    const one = {
      sys_script: { a: [{ name: "script", type: "js" }], b: [{ name: "script", type: "js" }] },
      sp_widget: { c: [{ name: "css", type: "css" }] },
    } as unknown as SN.MissingFileTableMap;
    const other = {
      sp_widget: { c: [{ name: "css", type: "css" }] },
      sys_script: { b: [{ name: "script", type: "js" }], a: [{ name: "script", type: "js" }] },
    } as unknown as SN.MissingFileTableMap;

    expect(computeMissingFingerprint(one)).toBe(computeMissingFingerprint(other));
  });

  it("changes when a record is added to an already-completed table", () => {
    const before = {
      sys_script: { a: [{ name: "script", type: "js" }] },
    } as unknown as SN.MissingFileTableMap;
    const after = {
      sys_script: {
        a: [{ name: "script", type: "js" }],
        b: [{ name: "script", type: "js" }],
      },
    } as unknown as SN.MissingFileTableMap;

    expect(computeMissingFingerprint(before)).not.toBe(computeMissingFingerprint(after));
  });

  it("changes when a record gains a field", () => {
    const before = {
      sp_widget: { a: [{ name: "script", type: "js" }] },
    } as unknown as SN.MissingFileTableMap;
    const after = {
      sp_widget: {
        a: [
          { name: "script", type: "js" },
          { name: "css", type: "css" },
        ],
      },
    } as unknown as SN.MissingFileTableMap;

    expect(computeMissingFingerprint(before)).not.toBe(computeMissingFingerprint(after));
  });
});
