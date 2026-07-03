// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
} from "../manifestBuilder.js";
import { logger } from "../Logger.js";

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, string>[] } }>,
  [string, string, string, number?, number?]
>;

function createClient(tableAPIGet: TableApiGet) {
  return { tableAPIGet } as unknown as import("../snClient").SNClient;
}

// A "skippable" error carries a 4xx status that axios recognises (ACL/404):
// the builder swallows these as "table not accessible". A plain Error has no
// HTTP status, so it counts as a real failure that must propagate.
function skippableError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

const emptyConfig: Pick<Sync.Config, "includes" | "excludes" | "tableOptions"> = {
  includes: {},
  excludes: {},
  tableOptions: {},
};

// Preserve and restore the data-materialization env vars per test so the
// suite stays hermetic regardless of the ambient environment.
function withDataEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>
): () => Promise<void> {
  return async () => {
    const keys = Object.keys(vars);
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

describe("manifestBuilder coverage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("pages the Table API across multiple offsets when a page is full", async () => {
    // First records page is exactly the page size (500) so the pager must
    // request a second offset; the short second page ends the loop.
    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      sys_id: `rec-${i}`,
      name: `Include ${i}`,
      script: "gs.info('x');",
    }));
    const secondPage = [
      { sys_id: "rec-500", name: "Include 500", script: "gs.info('y');" },
    ];

    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(
      async (table: string, _q: string, _f: string, _l?: number, offset?: number) => {
        if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        if (table === "sys_dictionary")
          return {
            data: { result: [{ element: "script", internal_type: "script_plain" }] },
          };
        if (table === "sys_script_include") {
          return { data: { result: offset === 0 ? firstPage : secondPage } };
        }
        return { data: { result: [] } };
      }
    );

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    const records = manifest.tables.sys_script_include.records;
    expect(Object.keys(records)).toHaveLength(501);
    expect(records["Include 0"].sys_id).toBe("rec-0");
    expect(records["Include 500"].sys_id).toBe("rec-500");
    // The pager fetched offset 0 then offset 500 for the records table.
    const offsets = tableAPIGet.mock.calls
      .filter((c) => c[0] === "sys_script_include")
      .map((c) => c[4]);
    expect(offsets).toEqual([0, 500]);
  });

  it("throws when the scope lookup itself fails (getScopeId swallows the error)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") throw new Error("boom");
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow('Scope "x_demo" not found on this instance');
  });

  it("throws the empty-manifest guard when no tables are discovered", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      // sys_metadata / sys_db_object / sys_dictionary all empty → zero tables.
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow('No tables discovered for scope "x_demo"');
  });

  it("recovers via sys_db_object catch (returns []) then dictionary nameLIKE fallback", async () => {
    // sys_metadata empty → sys_db_object throws (skippable, returns []) →
    // dictionary sys_scope query empty → dictionary nameLIKE query yields tables.
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") return { data: { result: [] } };
      if (table === "sys_db_object" && query.includes("sys_scope=scope-1")) {
        throw skippableError(403);
      }
      if (table === "sys_dictionary") {
        // Discovery-by-name queries: the sys_scope one returns nothing, the
        // nameLIKE fallback returns the table.
        if (fields === "name" && query.startsWith("sys_scope=")) {
          return { data: { result: [] } };
        }
        if (fields === "name" && query.startsWith("nameLIKEx_demo")) {
          return { data: { result: [{ name: "x_fleet" }] } };
        }
        // Field lookup for the discovered table.
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (table === "x_fleet") {
        return {
          data: { result: [{ sys_id: "rec-1", name: "Fleet A", script: "gs.info('f');" }] },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables.x_fleet).toBeDefined();
    expect(manifest.tables.x_fleet.records["Fleet A"].files).toEqual([
      { name: "script", type: "js" },
    ]);
  });

  it("falls back to the dictionary when the scoped metadata pager throws (outer catch)", async () => {
    // The sys_metadata pager throws a non-skippable error; getTableNamesInScope's
    // outer catch must route straight to getTableNamesFromDictionary.
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata" && fields === "sys_class_name") {
        throw new Error("metadata pager exploded");
      }
      if (table === "sys_dictionary") {
        if (fields === "name" && query.startsWith("sys_scope=")) {
          return { data: { result: [{ name: "x_fleet" }] } };
        }
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (table === "x_fleet") {
        return {
          data: { result: [{ sys_id: "rec-1", name: "Fleet A", script: "gs.info('f');" }] },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables.x_fleet).toBeDefined();
    expect(manifest.tables.x_fleet.records["Fleet A"]).toBeDefined();
  });

  it("returns [] when the dictionary nameLIKE fallback also throws", async () => {
    // sys_metadata / sys_db_object empty; dictionary sys_scope returns nothing
    // and the nameLIKE query throws → getTableNamesFromDictionary returns [] →
    // empty-manifest guard fires.
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") return { data: { result: [] } };
      if (table === "sys_db_object") return { data: { result: [] } };
      if (table === "sys_dictionary" && fields === "name") {
        if (query.startsWith("sys_scope=")) return { data: { result: [] } };
        throw skippableError(404);
      }
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow('No tables discovered for scope "x_demo"');
  });

  it("applies field-level excludes to the file-field dictionary query", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      if (table === "sys_dictionary" && fields === "element,internal_type") {
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (table === "sys_script_include") {
        return {
          data: { result: [{ sys_id: "rec-1", name: "Include A", script: "gs.info('a');" }] },
        };
      }
      return { data: { result: [] } };
    });

    await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {
        // "secret" is excluded but re-included at field level → must be kept
        // (the exclude clause for "secret" is skipped).
        sys_script_include: { secret: { type: "txt" } },
      },
      excludes: {
        sys_script_include: { legacy: { type: "txt" }, secret: { type: "txt" } },
      },
      tableOptions: {},
    });

    const fieldQuery = tableAPIGet.mock.calls.find(
      (c) => c[0] === "sys_dictionary" && c[2] === "element,internal_type"
    );
    expect(fieldQuery).toBeDefined();
    const query = fieldQuery![1];
    // "legacy" is excluded and not re-included → an exclusion clause is added.
    expect(query).toContain("^element!=legacy");
    // "secret" is excluded but re-included at field level → no exclusion clause.
    expect(query).not.toContain("^element!=secret");
  });

  it("dedupes text fields and applies field-level excludes in the text fallback (data-only table)", async () => {
    // A table-level include would pre-populate the file set upstream in
    // getFileFieldsForTable and skip the text fallback entirely, so this case
    // uses excludes only (no includes) to reach getTextFieldsForTable.
    await withDataEnv({ SYNCRONA_INCLUDE_DATA_FIELDS: "true" }, async () => {
      const tableAPIGet: TableApiGet = jest.fn();
      tableAPIGet.mockImplementation(async (table: string, _query: string, fields: string) => {
        if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "x_data" }] } };
        if (table === "sys_dictionary") {
          // No script-like fields → forces the text-field fallback.
          if (fields === "element,internal_type") return { data: { result: [] } };
          // Text-field query (fields === "element"): return a duplicate to
          // exercise the dedup guard.
          return {
            data: {
              result: [{ element: "u_name" }, { element: "u_name" }, { element: "u_code" }],
            },
          };
        }
        if (table === "x_data") {
          return {
            data: {
              result: [{ sys_id: "rec-1", name: "Row A", u_name: "Truck", u_code: "T" }],
            },
          };
        }
        return { data: { result: [] } };
      });

      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        includes: {},
        excludes: {
          // Field-level excludes for the data table → adds exclusion clauses to
          // the text-field query.
          x_data: { u_drop: { type: "txt" } },
        },
        tableOptions: {},
      });

      const files = manifest.tables.x_data.records["Row A"].files.map((f) => f.name);
      // Deduped u_name appears once alongside u_code.
      expect(files).toEqual(["u_name", "u_code"]);

      const textQuery = tableAPIGet.mock.calls.find(
        (c) => c[0] === "sys_dictionary" && c[2] === "element"
      );
      expect(textQuery).toBeDefined();
      expect(textQuery![1]).toContain("^element!=u_drop");
    });
  });

  it("materializes an allowlisted data table even with the global flag off", async () => {
    await withDataEnv(
      { SYNCRONA_INCLUDE_DATA_FIELDS: "false", SYNCRONA_DATA_TABLES: "x_allow ,x_other" },
      async () => {
        const tableAPIGet: TableApiGet = jest.fn();
        tableAPIGet.mockImplementation(async (table: string, _q: string, fields: string) => {
          if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
          if (table === "sys_metadata")
            return { data: { result: [{ sys_class_name: "x_allow" }] } };
          if (table === "sys_dictionary") {
            if (fields === "element,internal_type") return { data: { result: [] } };
            return { data: { result: [{ element: "u_label" }] } };
          }
          if (table === "x_allow") {
            return {
              data: { result: [{ sys_id: "rec-1", name: "Allowed", u_label: "L" }] },
            };
          }
          return { data: { result: [] } };
        });

        const manifest = await buildManifestFromTableAPI(
          "x_demo",
          createClient(tableAPIGet),
          emptyConfig
        );

        expect(manifest.tables.x_allow.records["Allowed"].files).toEqual([
          { name: "u_label", type: "txt" },
        ]);
      }
    );
  });

  it("propagates a non-skippable error from the text-field fallback (fails the table)", async () => {
    await withDataEnv({ SYNCRONA_INCLUDE_DATA_FIELDS: "true" }, async () => {
      const tableAPIGet: TableApiGet = jest.fn();
      tableAPIGet.mockImplementation(async (table: string, _q: string, fields: string) => {
        if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "x_data" }] } };
        if (table === "sys_dictionary") {
          if (fields === "element,internal_type") return { data: { result: [] } };
          // Text-field query fails with a network error → must propagate and
          // land the table in failedTables.
          throw new Error("socket hang up");
        }
        return { data: { result: [] } };
      });

      await expect(
        buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
      ).rejects.toThrow("Manifest build incomplete — failed tables: x_data");
    });
  });

  it("swallows a skippable error from the text-field fallback (empty file set)", async () => {
    await withDataEnv({ SYNCRONA_INCLUDE_DATA_FIELDS: "true" }, async () => {
      const tableAPIGet: TableApiGet = jest.fn();
      tableAPIGet.mockImplementation(async (table: string, _q: string, fields: string) => {
        if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
        if (table === "sys_metadata")
          return { data: { result: [{ sys_class_name: "x_data" }] } };
        if (table === "sys_dictionary") {
          if (fields === "element,internal_type") return { data: { result: [] } };
          throw skippableError(403);
        }
        return { data: { result: [] } };
      });

      // With zero file fields the table is silently dropped, leaving an empty
      // manifest → the empty-manifest guard is not tripped because at least one
      // table was discovered; the build succeeds with no tables.
      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(tableAPIGet),
        emptyConfig
      );
      expect(manifest.tables).toEqual({});
    });
  });

  it("skips already-visited ancestors in the table hierarchy (cycle guard)", async () => {
    // x_child -> x_parent -> x_child (cycle). The visited-set guard prevents
    // re-queuing x_child a second time.
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "x_child" }] } };
      if (table === "sys_db_object") {
        if (query === "name=x_child")
          return {
            data: { result: [{ name: "x_child", "super_class.name": "x_parent" }] },
          };
        if (query === "name=x_parent")
          return {
            data: { result: [{ name: "x_parent", "super_class.name": "x_child" }] },
          };
        return { data: { result: [] } };
      }
      if (table === "sys_dictionary") {
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (table === "x_child") {
        return {
          data: { result: [{ sys_id: "rec-1", name: "Child A", script: "gs.info('c');" }] },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables.x_child.records["Child A"]).toBeDefined();
    // x_child appears in the hierarchy exactly once despite the cycle.
    const dbObjectCalls = tableAPIGet.mock.calls.filter(
      (c) => c[0] === "sys_db_object" && c[1] === "name=x_child"
    );
    expect(dbObjectCalls).toHaveLength(1);
  });

  it("warns on a case/Unicode record-name collision", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              { sys_id: "rec-1", name: "Widget", script: "a" },
              // Same name after case-folding but a different display string →
              // filesystem collision warning.
              { sys_id: "rec-2", name: "widget", script: "b" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Record name collision in sys_script_include")
    );
  });

  it("warns on a duplicate record name that overwrites in the manifest", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              // Identical display name, different sys_ids → the later record
              // overwrites the earlier one and a duplicate warning is emitted.
              { sys_id: "rec-1", name: "Same", script: "a" },
              { sys_id: "rec-2", name: "Same", script: "b" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate record name "Same" in sys_script_include')
    );
    // The later record wins.
    expect(manifest.tables.sys_script_include.records["Same"].sys_id).toBe("rec-2");
  });

  it("swallows a skippable error from the primary record query and falls back to metadata ids", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        // Scope metadata rows (sys_id lookup) used to seed the fallback query.
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          return { data: { result: [{ sys_id: "rec-1", sys_class_name: "sys_script_include" }] } };
        }
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        // Primary scoped query is forbidden (skippable) → swallowed, then the
        // sys_idIN fallback returns the record.
        if (query.startsWith("sys_scope=")) throw skippableError(403);
        if (query.startsWith("sys_idINrec-1")) {
          return {
            data: { result: [{ sys_id: "rec-1", name: "Recovered", script: "gs.info('r');" }] },
          };
        }
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables.sys_script_include.records["Recovered"]).toBeDefined();
  });

  it("returns no records when both the primary and metadata queries are empty", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        // Metadata sys_id lookup is empty → getRecordsForTable returns {}.
        return { data: { result: [] } };
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        // Primary query returns nothing so the metadata fallback is attempted.
        return { data: { result: [] } };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    // The table yielded no records and is therefore omitted from the manifest.
    expect(manifest.tables).toEqual({});
  });

  it("swallows a skippable error while paging metadata rows for the fallback", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        // The metadata-rows pager for the fallback is forbidden (skippable) →
        // getScopeMetadataRowsForTable returns [] → getRecordsForTable returns {}.
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          throw skippableError(403);
        }
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") return { data: { result: [] } };
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables).toEqual({});
  });

  it("propagates a non-skippable error while paging metadata rows for the fallback", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        // The metadata-rows pager for the fallback hits a network error →
        // getScopeMetadataRowsForTable must re-throw, failing the table.
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          throw new Error("socket hang up");
        }
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") return { data: { result: [] } };
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_script_include");
  });

  it("skips inaccessible chunks in the metadata-id fallback and keeps accessible ones", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          return { data: { result: [{ sys_id: "rec-1", sys_class_name: "sys_script_include" }] } };
        }
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        if (query.startsWith("sys_scope=")) return { data: { result: [] } };
        // The sys_idIN fallback chunk is forbidden (skippable) → the chunk is
        // skipped, leaving no records for the table.
        if (query.startsWith("sys_idIN")) throw skippableError(404);
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      emptyConfig
    );

    expect(manifest.tables).toEqual({});
  });

  it("propagates a non-skippable error from the metadata-id fallback chunk", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata") {
        if (fields === "sys_class_name")
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          return { data: { result: [{ sys_id: "rec-1", sys_class_name: "sys_script_include" }] } };
        }
      }
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include") {
        if (query.startsWith("sys_scope=")) return { data: { result: [] } };
        // Network-level failure in the fallback chunk must propagate → the
        // table fails and the whole build is rejected.
        if (query.startsWith("sys_idIN")) throw new Error("socket hang up");
      }
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_script_include");
  });

  it("propagates a non-skippable error from the primary record query", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      if (table === "sys_dictionary")
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      if (table === "sys_script_include" && query.startsWith("sys_scope=")) {
        throw new Error("socket hang up");
      }
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), emptyConfig)
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_script_include");
  });

  it("buildBulkDownloadFromTableAPI skips an inaccessible table and warns", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "x_ok") {
        return {
          data: { result: [{ sys_id: "rec-1", name: "OK A", script: "gs.info('ok');" }] },
        };
      }
      // The forbidden table is skipped (skippable) rather than failing the run.
      if (table === "x_forbidden") throw skippableError(403);
      return { data: { result: [] } };
    });

    const missing: SN.MissingFileTableMap = {
      x_ok: { "rec-1": [{ name: "script", type: "js" }] },
      x_forbidden: { "rec-9": [{ name: "script", type: "js" }] },
    };

    const result = await buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {});

    expect(Object.keys(result)).toEqual(["x_ok"]);
    expect(result.x_ok.records["OK A"].files).toEqual([
      { name: "script", type: "js", content: "gs.info('ok');" },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping inaccessible table x_forbidden")
    );
  });

  it("buildBulkDownloadFromTableAPI propagates a non-skippable error", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async () => {
      throw new Error("socket hang up");
    });

    const missing: SN.MissingFileTableMap = {
      x_boom: { "rec-1": [{ name: "script", type: "js" }] },
    };

    await expect(
      buildBulkDownloadFromTableAPI(missing, createClient(tableAPIGet), {})
    ).rejects.toThrow("socket hang up");
  });

  it("shouldMaterializeDataFields treats an off value as false (no fallback fields)", async () => {
    await withDataEnv(
      { SYNCRONA_INCLUDE_DATA_FIELDS: "off", SYNCRONA_DATA_TABLES: undefined },
      async () => {
        const tableAPIGet: TableApiGet = jest.fn();
        tableAPIGet.mockImplementation(async (table: string, _q: string, fields: string) => {
          if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
          if (table === "sys_metadata")
            return { data: { result: [{ sys_class_name: "x_data" }] } };
          if (table === "sys_dictionary") {
            // No script-like fields and materialization is OFF → the text
            // fallback must NOT run, so the table has zero file fields and is
            // dropped from the manifest.
            if (fields === "element,internal_type") return { data: { result: [] } };
            throw new Error("text fallback must not be queried");
          }
          return { data: { result: [] } };
        });

        const manifest = await buildManifestFromTableAPI(
          "x_demo",
          createClient(tableAPIGet),
          emptyConfig
        );
        // The data table produced no file fields (fallback disabled) so it is
        // absent from the manifest.
        expect(manifest.tables).toEqual({});
      }
    );
  });
});
