// SPDX-License-Identifier: GPL-3.0-or-later
import {
  buildFullMissingMap,
  downloadTablesWithResume,
  groupAppFiles,
} from "../appUtils.js";
import type { SN, Sync } from "@syncrona/types";

const manifest = {
  scope: "x_app",
  tables: {
    sys_script_include: {
      records: {
        "Rec A": {
          sys_id: "sysA",
          files: [{ name: "script", type: "js" }],
        },
        "Rec B": {
          sys_id: "sysB",
          files: [
            { name: "script", type: "js" },
            { name: "doc", type: "html" },
          ],
        },
      },
    },
    sys_script: {
      records: {
        "Rule X": { sys_id: "sysX", files: [{ name: "script", type: "js" }] },
      },
    },
  },
} as unknown as SN.AppManifest;

describe("buildFullMissingMap", () => {
  it("flattens manifest records into a table -> sys_id -> files map", () => {
    const map = buildFullMissingMap(manifest);
    expect(Object.keys(map)).toEqual(["sys_script_include", "sys_script"]);
    expect(map.sys_script_include.sysA).toEqual([{ name: "script", type: "js" }]);
    expect(map.sys_script_include.sysB).toHaveLength(2);
    expect(map.sys_script.sysX).toEqual([{ name: "script", type: "js" }]);
  });
});

function makeDeps(checkpointTables: string[] | null) {
  const calls = {
    fetched: [] as string[],
    written: 0,
    checkpoints: [] as string[][],
    deleted: 0,
  };
  const deps = {
    fetchTable: async (tableMissing: SN.MissingFileTableMap) => {
      calls.fetched.push(Object.keys(tableMissing)[0]);
      return {} as SN.TableMap;
    },
    writeTable: async () => {
      calls.written += 1;
    },
    readCheckpoint: async () =>
      checkpointTables
        ? { scope: "x_app", completedTables: checkpointTables }
        : null,
    writeCheckpoint: async (cp: { scope: string; completedTables: string[] }) => {
      calls.checkpoints.push(cp.completedTables);
    },
    deleteCheckpoint: async () => {
      calls.deleted += 1;
    },
  };
  return { deps, calls };
}

describe("downloadTablesWithResume", () => {
  it("downloads every table on a fresh run and clears the checkpoint at the end", async () => {
    const missing = buildFullMissingMap(manifest);
    const { deps, calls } = makeDeps(null);
    await downloadTablesWithResume(missing, "x_app", deps as never);
    expect(calls.fetched).toEqual(["sys_script_include", "sys_script"]);
    expect(calls.written).toBe(2);
    expect(calls.checkpoints).toHaveLength(2);
    expect(calls.deleted).toBe(1);
  });

  it("resumes only the pending tables when a checkpoint exists", async () => {
    const missing = buildFullMissingMap(manifest);
    const { deps, calls } = makeDeps(["sys_script_include"]);
    await downloadTablesWithResume(missing, "x_app", deps as never);
    expect(calls.fetched).toEqual(["sys_script"]); // first table skipped
    expect(calls.written).toBe(1);
    expect(calls.deleted).toBe(1);
  });

  it("clears the checkpoint immediately when there is nothing to download", async () => {
    const { deps, calls } = makeDeps(null);
    await downloadTablesWithResume({}, "x_app", deps as never);
    expect(calls.fetched).toEqual([]);
    expect(calls.deleted).toBe(1);
  });
});

describe("groupAppFiles", () => {
  const ctx = (
    tableName: string,
    sys_id: string,
    targetField: string
  ): Sync.FileContext =>
    ({ tableName, sys_id, targetField } as unknown as Sync.FileContext);

  it("groups fields of the same record under one buildable record", () => {
    const out = groupAppFiles([
      ctx("sys_script", "s1", "script"),
      ctx("sys_script", "s1", "description"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].table).toBe("sys_script");
    expect(Object.keys(out[0].fields).sort()).toEqual(["description", "script"]);
  });

  it("keeps distinct records separate", () => {
    const out = groupAppFiles([
      ctx("sys_script", "s1", "script"),
      ctx("sys_script", "s2", "script"),
    ]);
    expect(out).toHaveLength(2);
  });
});
