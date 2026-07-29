// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import {
  downloadTablesWithResume,
  DownloadTableDeps,
} from "../downloadPipeline.js";
import { DownloadCheckpoint } from "../downloadCheckpoint.js";

// REV-140: a column-level read ACL does not make a table inaccessible — the rows
// come back, only the withheld field is missing from the response. The Table-API
// builder now omits that file instead of fabricating an empty one, so nothing is
// written for it. The download loop's completeness check counted records only,
// so it checkpointed such a table as done, deleted the checkpoint on exit and
// reported a clean "Download complete" over files that were never fetched.

interface Calls {
  checkpoints: string[][];
  deleted: number;
}

const requested = (tables: string[]): SN.MissingFileTableMap => {
  const missing: Record<string, unknown> = {};
  for (const table of tables) {
    missing[table] = {
      "sys-1": [
        { name: "script", type: "js" },
        { name: "css", type: "css" },
      ],
    };
  }
  return missing as unknown as SN.MissingFileTableMap;
};

// What the instance returned for one table: the record is there, but only the
// listed fields came back with it.
const returnedWithFields = (table: string, fields: string[]): SN.TableMap =>
  ({
    [table]: {
      records: {
        Widget: {
          sys_id: "sys-1",
          name: "Widget",
          files: fields.map((name) => ({
            name,
            type: name === "script" ? "js" : "css",
            content: "x",
          })),
        },
      },
    },
  }) as unknown as SN.TableMap;

const makeDeps = (
  fetched: (table: string) => SN.TableMap,
  checkpoint: DownloadCheckpoint | null = null
): { deps: DownloadTableDeps; calls: Calls } => {
  const calls: Calls = { checkpoints: [], deleted: 0 };
  const deps: DownloadTableDeps = {
    fetchTable: async (tableMissing) => fetched(Object.keys(tableMissing)[0]),
    writeTable: async () => undefined,
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (cp) => {
      calls.checkpoints.push([...cp.completedTables]);
    },
    deleteCheckpoint: async () => {
      calls.deleted += 1;
    },
  };
  return { deps, calls };
};

describe("downloadTablesWithResume with a field the instance withholds (REV-140)", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("does not checkpoint or report success for a table whose field never arrived", async () => {
    // "sp_widget" returns the record but not its `script` column (read ACL);
    // "sys_script_include" comes back whole.
    const { deps, calls } = makeDeps((table) =>
      table === "sp_widget"
        ? returnedWithFields(table, ["css"])
        : returnedWithFields(table, ["script", "css"])
    );

    await downloadTablesWithResume(
      requested(["sp_widget", "sys_script_include"]),
      "x_demo",
      deps
    );

    // Only the fully-downloaded table is checkpointed…
    expect(calls.checkpoints).toEqual([["sys_script_include"]]);
    // …the checkpoint survives so the next run retries the incomplete table…
    expect(calls.deleted).toBe(0);
    // …and the shell sees a failure instead of "Download complete".
    expect(process.exitCode).toBe(1);
  });

  it("still completes when every requested field comes back", async () => {
    const { deps, calls } = makeDeps((table) =>
      returnedWithFields(table, ["script", "css"])
    );

    await downloadTablesWithResume(requested(["sp_widget"]), "x_demo", deps);

    expect(calls.checkpoints).toEqual([["sp_widget"]]);
    expect(calls.deleted).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it("does not fail a table because a record was deleted server-side", async () => {
    // The record is gone from the instance entirely — not a field-level gap, and
    // failing here would make the table unfinishable on every rerun.
    const { deps, calls } = makeDeps(
      (table) =>
        ({ [table]: { records: { Other: { sys_id: "sys-2", name: "Other", files: [] } } } }) as unknown as SN.TableMap
    );

    await downloadTablesWithResume(requested(["sp_widget"]), "x_demo", deps);

    expect(calls.checkpoints).toEqual([["sp_widget"]]);
    expect(calls.deleted).toBe(1);
    expect(process.exitCode).toBe(0);
  });
});
