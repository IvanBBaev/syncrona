// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { SN, Sync } from "@syncrona/types";

// manifestBuilder reads the PREVIOUS manifest through ConfigManager, so the
// module has to be mocked before the subject is imported (ESM mocks do not
// hoist).
const getManifest = jest.fn();
jest.unstable_mockModule("../config.js", () => ({
  getManifest: (...a: unknown[]) => getManifest(...a),
}));

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn(), success: jest.fn() },
}));

type TableApiGet = jest.Mock<
  (
    table: string,
    query: string,
    fields: string,
    limit?: number,
    offset?: number
  ) => Promise<{ data: { result: Record<string, string>[] } }>
>;

let buildManifestFromTableAPI: typeof import("../manifestBuilder.js").buildManifestFromTableAPI;
let buildBulkDownloadFromTableAPI: typeof import("../manifestBuilder.js").buildBulkDownloadFromTableAPI;

beforeAll(async () => {
  ({ buildManifestFromTableAPI, buildBulkDownloadFromTableAPI } = await import(
    "../manifestBuilder.js"
  ));
});

beforeEach(() => {
  jest.clearAllMocks();
  getManifest.mockReturnValue(undefined);
});

const emptyConfig: Pick<Sync.Config, "includes" | "excludes" | "tableOptions"> = {
  includes: {},
  excludes: {},
  tableOptions: {},
};

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

// A 403 the builder treats as "table not accessible" rather than a real failure.
const forbidden = (): Error =>
  Object.assign(new Error("http 403"), {
    isAxiosError: true,
    response: { status: 403 },
  });

const PREVIOUS: SN.AppManifest = {
  scope: "x_demo",
  tables: {
    sys_script: {
      records: {
        Existing: {
          sys_id: "rec-1",
          name: "Existing",
          files: [{ name: "script", type: "js" }],
        },
      },
    },
  },
} as unknown as SN.AppManifest;

// A table the instance refuses (column ACL, temporarily unreadable) returns
// "no file fields" — indistinguishable from a table that genuinely has none.
// The rebuilt manifest therefore dropped the table entirely and replaced the
// good manifest: every already-downloaded file of that table stopped mapping to
// a record, so `push` ignored edits to them and `repair --prune` called them
// orphans. The previously known records must survive a refused read.
describe("buildManifestFromTableAPI with an inaccessible table", () => {
  const clientRefusingDictionary = (): TableApiGet => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script" }] } };
      if (table === "sys_dictionary") throw forbidden();
      return { data: { result: [] } };
    });
    return tableAPIGet;
  };

  it("keeps the previously known records instead of dropping the table", async () => {
    getManifest.mockReturnValue(PREVIOUS);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(clientRefusingDictionary()),
      emptyConfig
    );

    expect(manifest.tables.sys_script).toBeDefined();
    expect(manifest.tables.sys_script.records["Existing"].sys_id).toBe("rec-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Kept the previously known records for: sys_script")
    );
  });

  it("warns about the unreadable table even when there is nothing to carry over", async () => {
    getManifest.mockReturnValue(undefined);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(clientRefusingDictionary()),
      emptyConfig
    );

    expect(manifest.tables.sys_script).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fully read 1 table(s) while building the manifest")
    );
  });

  it("does not carry over records from a different scope's manifest", async () => {
    getManifest.mockReturnValue({ ...PREVIOUS, scope: "x_other" });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(clientRefusingDictionary()),
      emptyConfig
    );

    expect(manifest.tables.sys_script).toBeUndefined();
  });
});

// The same "refused reads as empty" confusion exists on three deeper paths that
// used to swallow the skip without reporting it: the text-field fallback, the
// sys_metadata lookup behind an empty record query, and the per-chunk `sys_idIN`
// fallback. Each one has to reach the same carry-forward.
describe("buildManifestFromTableAPI with a refused read below the top-level query", () => {
  // Answers everything the builder needs to reach getRecordsForTable for
  // `sys_script`; `overrides` decides which of the deeper reads is refused.
  const createRefusingClient = (
    overrides: (table: string, query: string, fields: string) =>
      | { data: { result: Record<string, string>[] } }
      | Error
      | undefined
  ): TableApiGet => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(
      async (table: string, query: string, fields: string) => {
        const override = overrides(table, query, fields);
        if (override instanceof Error) throw override;
        if (override) return override;

        if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
        // Table discovery (fields "sys_class_name") — distinct from the
        // sys_metadata fallback inside getRecordsForTable.
        if (table === "sys_metadata" && fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script" }] } };
        // Hierarchy walk: no parent class.
        if (table === "sys_db_object") return { data: { result: [] } };
        // File fields for the table.
        if (table === "sys_dictionary" && fields === "element,internal_type")
          return { data: { result: [{ element: "script", internal_type: "script" }] } };
        return { data: { result: [] } };
      }
    );
    return tableAPIGet;
  };

  it("reports a refused text-field fallback instead of returning no fields", async () => {
    // The fallback only runs for a data-materialized table, and it is the only
    // sys_dictionary read that asks for "element" alone.
    process.env.SYNCRONA_DATA_TABLES = "sys_script";
    getManifest.mockReturnValue(PREVIOUS);

    try {
      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(createRefusingClient((table, _query, fields) => {
          if (table === "sys_dictionary" && fields === "element,internal_type")
            return { data: { result: [] } };
          if (table === "sys_dictionary" && fields === "element") return forbidden();
          return undefined;
        })),
        emptyConfig
      );

      expect(manifest.tables.sys_script.records["Existing"].sys_id).toBe("rec-1");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Kept the previously known records for: sys_script")
      );
    } finally {
      delete process.env.SYNCRONA_DATA_TABLES;
    }
  });

  it("reports a refused sys_metadata lookup behind an empty record query", async () => {
    getManifest.mockReturnValue(PREVIOUS);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(createRefusingClient((table, _query, fields) =>
        table === "sys_metadata" && fields === "sys_id,sys_class_name"
          ? forbidden()
          : undefined
      )),
      emptyConfig
    );

    expect(manifest.tables.sys_script.records["Existing"].sys_id).toBe("rec-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Kept the previously known records for: sys_script")
    );
  });

  // A refused `sys_idIN` chunk leaves the other chunks intact, so the table does
  // come back with records — just not all of them. That partial set used to be
  // written as if it were the whole table, which is the same data loss one step
  // later: the missing records' files become orphans for `repair --prune`.
  it("merges the previous records back in when only one sys_id chunk is refused", async () => {
    getManifest.mockReturnValue(PREVIOUS);
    // SYS_ID_CHUNK_SIZE is 200, so 250 ids produce exactly two chunks.
    const ids = Array.from({ length: 250 }, (_, i) => `md-${i}`);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(createRefusingClient((table, query, fields) => {
        if (table === "sys_metadata" && fields === "sys_id,sys_class_name") {
          return { data: { result: ids.map((sys_id) => ({ sys_id })) } };
        }
        if (table === "sys_script" && query.startsWith("sys_idIN")) {
          const chunk = query.slice("sys_idIN".length).split(",");
          // The second chunk is the refused one.
          if (chunk.includes("md-200")) return forbidden();
          return {
            data: {
              result: chunk.map((sys_id) => ({ sys_id, name: `Script-${sys_id}` })),
            },
          };
        }
        return undefined;
      })),
      emptyConfig
    );

    const records = manifest.tables.sys_script.records;
    // Everything the accessible chunk returned...
    expect(records["Script-md-0"].sys_id).toBe("md-0");
    expect(Object.keys(records)).toHaveLength(201);
    // ...plus the record the refused chunk would have silently dropped.
    expect(records["Existing"].sys_id).toBe("rec-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Kept the previously known records for: sys_script")
    );
  });
});

// `row[fieldName] || ""` cannot tell "the instance returned an empty value"
// from "the instance did not return this column at all" (read ACL on the
// field). Because downloadAllFiles writes with forceWrite, the fabricated empty
// string overwrote the local file — silent data loss on every download of a
// read-restricted field.
describe("buildBulkDownloadFromTableAPI with a field the instance withholds", () => {
  it("omits a field missing from the response instead of blanking it", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async () => ({
      // "script" is withheld by a column-level ACL; "css" comes back empty.
      data: { result: [{ sys_id: "rec-1", id: "Widget", css: "" }] },
    }));

    const result = await buildBulkDownloadFromTableAPI(
      {
        sp_widget: {
          "rec-1": [
            { name: "script", type: "js" },
            { name: "css", type: "css" },
          ],
        },
      } as unknown as SN.MissingFileTableMap,
      createClient(tableAPIGet),
      {}
    );

    const files = result.sp_widget.records["Widget"].files;
    expect(files.map((f) => f.name)).toEqual(["css"]);
    expect(files[0].content).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the instance returned no value for field(s) script")
    );
  });

  it("still writes a field the instance returns as an empty string", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async () => ({
      data: { result: [{ sys_id: "rec-1", id: "Widget", script: "" }] },
    }));

    const result = await buildBulkDownloadFromTableAPI(
      { sp_widget: { "rec-1": [{ name: "script", type: "js" }] } } as unknown as SN.MissingFileTableMap,
      createClient(tableAPIGet),
      {}
    );

    expect(result.sp_widget.records["Widget"].files).toEqual([
      { name: "script", type: "js", content: "" },
    ]);
  });
});
