// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncro-now-ai/types";
import { downloadTablesWithResume, DownloadTableDeps } from "../appUtils";
import { DownloadCheckpoint } from "../downloadCheckpoint";

// G3: the resumable download loop — progress, per-table checkpointing, resume
// skipping and checkpoint cleanup, tested with injected deps (no net / disk).

function missingMap(tables: string[]): SN.MissingFileTableMap {
  const m: Record<string, unknown> = {};
  for (const t of tables) {
    m[t] = { rec1: [{ name: "script", type: "js" }] };
  }
  return m as unknown as SN.MissingFileTableMap;
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
      calls.fetched.push(Object.keys(tm)[0]);
      return {} as SN.TableMap;
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
        return {} as SN.TableMap;
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
});
