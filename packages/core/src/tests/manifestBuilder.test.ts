// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
  listAppsFromTableAPI,
  isNotFoundError,
} from "../manifestBuilder.js";

type TableApiGet = jest.Mock<Promise<{ data: { result: Record<string, string>[] } }>, [string, string, string, number?]>;

function createClient(tableAPIGet: TableApiGet) {
  return { tableAPIGet } as unknown as import("../snClient").SNClient;
}

describe("manifestBuilder", () => {
  it("buildManifestFromTableAPI builds tables, records, and files", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return {
          data: {
            result: [
              { sys_class_name: "sys_script_include" },
              { sys_class_name: "sys_script_include" },
            ],
          },
        };
      }
      if (table === "sys_dictionary") {
        return {
          data: {
            result: [
              { element: "script", internal_type: "script_plain" },
              { element: "description", internal_type: "string" },
            ],
          },
        };
      }
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              { sys_id: "rec-1", name: "Include A", script: "gs.info('a');", description: "desc" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const client = createClient(tableAPIGet);
    const config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions"> = {
      includes: {},
      excludes: {},
      tableOptions: {},
    };

    const manifest = await buildManifestFromTableAPI("x_demo", client, config);

    expect(manifest.scope).toBe("x_demo");
    expect(Object.keys(manifest.tables)).toEqual(["sys_script_include"]);
    const record = manifest.tables.sys_script_include.records["Include A"];
    expect(record.sys_id).toBe("rec-1");
    expect(record.files).toEqual([
      { name: "script", type: "js" },
      { name: "description", type: "txt" },
    ]);
  });

  // #6: buildRecordName derives the on-disk record name from tableOptions.displayField
  // and differentiatorField, but the record query used to select only the DEFAULT
  // display field. Those configured columns were never fetched, so the manifest name
  // silently diverged from the bulk-download name and `repair --prune` deleted the
  // file. The field list must include the configured displayField and differentiator.
  it("selects the configured displayField and differentiatorField for the record query (#6)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary") {
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              { sys_id: "rec-1", u_title: "Custom Title", u_code: "ABC", script: "gs.info('a');" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const client = createClient(tableAPIGet);
    const config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions"> = {
      includes: {},
      excludes: {},
      tableOptions: {
        sys_script_include: {
          displayField: "u_title",
          differentiatorField: "u_code",
          query: "",
        },
      },
    };

    const manifest = await buildManifestFromTableAPI("x_demo", client, config);

    const recordCall = tableAPIGet.mock.calls.find(
      (c) => c[0] === "sys_script_include"
    );
    // The 3rd arg is the sysparm_fields select list.
    const selectedFields = recordCall?.[2] ?? "";
    expect(selectedFields).toContain("u_title");
    expect(selectedFields).toContain("u_code");

    // And the record is named from the configured display + differentiator fields,
    // proving the fetched columns actually feed buildRecordName.
    expect(
      manifest.tables.sys_script_include.records["Custom Title (ABC)"]?.sys_id
    ).toBe("rec-1");
  });

  it("escapes a caret-injecting scope name in every scope query", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      // Everything else empty → no tables discovered → throws after the scope
      // queries have already run, which is all this test inspects.
      return { data: { result: [] } };
    });
    const client = createClient(tableAPIGet);

    // A ^ in the scope name would otherwise inject a second encoded-query
    // condition (`scope=x_demo^sys_id=INJECT`) and slip past the scope filter.
    await expect(
      buildManifestFromTableAPI("x_demo^sys_id=INJECT", client, {
        includes: {},
        excludes: {},
        tableOptions: {},
      })
    ).rejects.toThrow();

    const sysAppCall = tableAPIGet.mock.calls.find((c) => c[0] === "sys_app");
    expect(sysAppCall?.[1]).toBe("scope=x_demo sys_id=INJECT");
    expect(sysAppCall?.[1]).not.toContain("^");

    const nameLikeCall = tableAPIGet.mock.calls.find(
      (c) => c[0] === "sys_dictionary" && String(c[1]).startsWith("nameLIKE")
    );
    // The trailing structural ^nameISNOTEMPTY stays; only the injected ^ is gone.
    expect(nameLikeCall?.[1]).toBe("nameLIKEx_demo sys_id=INJECT^nameISNOTEMPTY");
  });

  it("never names a record '.' or '..' (would escape its own directory)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary") {
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (table === "sys_script_include") {
        return {
          data: { result: [{ sys_id: "rec-dots", name: "..", script: "gs.info('x');" }] },
        };
      }
      return { data: { result: [] } };
    });
    const client = createClient(tableAPIGet);

    const manifest = await buildManifestFromTableAPI("x_demo", client, {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    const records = manifest.tables.sys_script_include.records;
    // Falls back to the sys_id rather than the traversal-dangerous "..".
    expect(records["rec-dots"]).toBeDefined();
    expect(records[".."]).toBeUndefined();
    expect(Object.keys(records)).toEqual(["rec-dots"]);
  });

  it("buildManifestFromTableAPI throws clear error when scope is missing", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [] } };
      }
      return { data: { result: [] } };
    });

    const client = createClient(tableAPIGet);

    await expect(
      buildManifestFromTableAPI("x_missing", client, {
        includes: {},
        excludes: {},
        tableOptions: {},
      })
    ).rejects.toThrow('Scope "x_missing" not found on this instance. Check the scope code.');
  });

  it("falls back to sys_db_object when sys_metadata is empty", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [] } };
      }
      if (table === "sys_db_object") {
        return {
          data: {
            result: [{ name: "x_fleet_record" }],
          },
        };
      }
      if (table === "sys_dictionary") {
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "x_fleet_record") {
        return {
          data: {
            result: [{ sys_id: "rec-1", name: "Fleet A", script: "gs.info('fleet');" }],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables.x_fleet_record).toBeDefined();
    expect(manifest.tables.x_fleet_record.records["Fleet A"].files).toEqual([
      { name: "script", type: "js" },
    ]);
  });

  it("falls back to sys_dictionary when sys_db_object is empty", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [] } };
      }
      if (table === "sys_db_object") {
        return { data: { result: [] } };
      }
      if (table === "sys_dictionary") {
        if (tableAPIGet.mock.calls.length === 4) {
          return {
            data: {
              result: [{ name: "x_fleet_record" }],
            },
          };
        }
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "x_fleet_record") {
        return {
          data: {
            result: [{ sys_id: "rec-1", name: "Fleet A", script: "gs.info('fleet');" }],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables.x_fleet_record).toBeDefined();
    expect(manifest.tables.x_fleet_record.records["Fleet A"].files).toEqual([
      { name: "script", type: "js" },
    ]);
  });

  it("falls back to sys_metadata sys_id query when scoped table filter returns no rows", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        if (query === "sys_scope=scope-1") {
          return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
        }
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          return { data: { result: [{ sys_id: "rec-1", sys_class_name: "sys_script_include" }] } };
        }
      }
      if (table === "sys_db_object") {
        return { data: { result: [{ name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary") {
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "sys_script_include") {
        if (query === "sys_scope=scope-1^sys_class_name=sys_script_include") {
          return { data: { result: [] } };
        }
        if (query === "sys_idINrec-1") {
          return {
            data: {
              result: [{ sys_id: "rec-1", name: "Include via Metadata", script: "gs.info('meta');" }],
            },
          };
        }
      }

      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables.sys_script_include).toBeDefined();
    expect(manifest.tables.sys_script_include.records["Include via Metadata"]).toBeDefined();
    expect(manifest.tables.sys_script_include.records["Include via Metadata"].files).toEqual([
      { name: "script", type: "js" },
    ]);
  });

  it("materializes data-only tables with txt fields when no script-like fields exist", async () => {
    const oldFlag = process.env.SYNCRONA_INCLUDE_DATA_FIELDS;
    process.env.SYNCRONA_INCLUDE_DATA_FIELDS = "true";

    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, fields: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "x_data_table" }] } };
      }
      if (table === "sys_db_object") {
        return { data: { result: [{ name: "x_data_table" }] } };
      }
      if (table === "sys_dictionary") {
        if (fields === "element,internal_type") {
          return { data: { result: [] } };
        }
        return { data: { result: [{ element: "u_name" }, { element: "u_code" }] } };
      }
      if (table === "x_data_table") {
        return {
          data: {
            result: [{ sys_id: "rec-1", name: "Data A", u_name: "Truck", u_code: "T-01" }],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables.x_data_table).toBeDefined();
    expect(manifest.tables.x_data_table.records["Data A"].files).toEqual([
      { name: "u_name", type: "txt" },
      { name: "u_code", type: "txt" },
    ]);

    if (oldFlag === undefined) {
      delete process.env.SYNCRONA_INCLUDE_DATA_FIELDS;
    } else {
      process.env.SYNCRONA_INCLUDE_DATA_FIELDS = oldFlag;
    }
  });

  it("buildBulkDownloadFromTableAPI fills missing file contents", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              {
                sys_id: "rec-1",
                name: "Include A",
                script: "gs.info('a');",
                description: "hello",
              },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const client = createClient(tableAPIGet);
    const missing: SN.MissingFileTableMap = {
      sys_script_include: {
        "rec-1": [
          { name: "script", type: "js" },
          { name: "description", type: "txt" },
        ],
      },
    };

    const tableMap = await buildBulkDownloadFromTableAPI(missing, client, {});
    expect(Object.keys(tableMap)).toEqual(["sys_script_include"]);
    const rec = tableMap.sys_script_include.records["Include A"];
    expect(rec.files).toEqual([
      { name: "script", type: "js", content: "gs.info('a');" },
      { name: "description", type: "txt", content: "hello" },
    ]);
  });

  it("listAppsFromTableAPI returns SN.App[] shape", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockResolvedValue({
      data: {
        result: [
          { sys_id: "app-1", scope: "x_demo", name: "Demo" },
          { sys_id: "app-2", scope: "x_tools", name: "Tools" },
        ],
      },
    });

    const apps = await listAppsFromTableAPI(createClient(tableAPIGet));
    expect(apps).toEqual([
      { sys_id: "app-1", scope: "x_demo", displayName: "Demo" },
      { sys_id: "app-2", scope: "x_tools", displayName: "Tools" },
    ]);
  });

  it("isNotFoundError handles 404 and non-404 inputs", () => {
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(isNotFoundError({ response: { status: 500 } })).toBe(false);
    expect(isNotFoundError({ status: 404 })).toBe(true);
    expect(isNotFoundError("boom")).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it("uses sys_atf_step inputs.script without dictionary query", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, _query: string, _fields: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_atf_step" }] } };
      }
      if (table === "sys_dictionary") {
        throw new Error("sys_dictionary should not be queried for sys_atf_step");
      }
      if (table === "sys_atf_step") {
        return {
          data: {
            result: [
              {
                sys_id: "atf-1",
                name: "Step A",
                "inputs.script": "gs.info('atf');",
              },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables.sys_atf_step).toBeDefined();
    const rec = Object.values(manifest.tables.sys_atf_step.records)[0];
    expect(rec.files).toEqual([{ name: "inputs.script", type: "js" }]);
    const queriedDictionary = tableAPIGet.mock.calls.some((call) => call[0] === "sys_dictionary");
    expect(queriedDictionary).toBe(false);
  });

  it("queries dictionary across table hierarchy (table + ancestors)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "x_child_table" }] } };
      }
      if (table === "sys_db_object") {
        if (query === "name=x_child_table") {
          return { data: { result: [{ name: "x_child_table", "super_class.name": "x_parent_table" }] } };
        }
        if (query === "name=x_parent_table") {
          return { data: { result: [{ name: "x_parent_table", "super_class.name": "sys_metadata" }] } };
        }
        if (query === "name=sys_metadata") {
          return { data: { result: [{ name: "sys_metadata" }] } };
        }
      }
      if (table === "sys_dictionary") {
        expect(query).toContain("name=x_child_table^ORname=x_parent_table^ORname=sys_metadata");
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "x_child_table") {
        return {
          data: {
            result: [{ sys_id: "rec-1", name: "Child A", script: "gs.info('x');" }],
          },
        };
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(Object.keys(manifest.tables)).toEqual(["x_child_table"]);
    const rec = manifest.tables.x_child_table.records["Child A"];
    expect(rec.files).toEqual([{ name: "script", type: "js" }]);
  });

  it("formats differentiatorField string and array like SincUtilsMS", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      }
      if (table === "sys_db_object") {
        return { data: { result: [{ name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary") {
        return {
          data: {
            result: [{ element: "script", internal_type: "script_plain" }],
          },
        };
      }
      if (table === "sys_script_include") {
        return {
          data: {
            result: [
              {
                sys_id: "rec-1",
                name: "Include A",
                script: "gs.info('a');",
                version: "v2",
                category: "ops",
              },
            ],
          },
        };
      }
      return { data: { result: [] } };
    });

    const byString = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {
        sys_script_include: {
          version: { type: "txt" },
          category: { type: "txt" },
        },
      },
      excludes: {},
      tableOptions: {
        sys_script_include: { differentiatorField: "version", query: "" },
      },
    });

    expect(byString.tables.sys_script_include.records["Include A (v2)"]).toBeDefined();

    const byArray = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {
        sys_script_include: {
          version: { type: "txt" },
          category: { type: "txt" },
        },
      },
      excludes: {},
      tableOptions: {
        sys_script_include: {
          differentiatorField: ["version", "category"],
          query: "",
        },
      },
    });

    expect(byArray.tables.sys_script_include.records["Include A (version:v2)"]).toBeDefined();
  });

  it("fails the build when a table's field lookup hits a network error (no silent drop)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, _query: string, fields: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary" && fields === "element,internal_type") {
        // Network-level failure: no HTTP status at all.
        throw new Error("socket hang up");
      }
      return { data: { result: [] } };
    });

    await expect(
      buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        includes: {},
        excludes: {},
        tableOptions: {},
      })
    ).rejects.toThrow("Manifest build incomplete — failed tables: sys_script_include");
  });

  it("still skips a table whose dictionary endpoint is inaccessible (403)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, _query: string, fields: string) => {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      }
      if (table === "sys_dictionary" && fields === "element,internal_type") {
        throw Object.assign(new Error("forbidden"), {
          isAxiosError: true,
          response: { status: 403 },
        });
      }
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.tables).toEqual({});
  });

  it("listAppsFromTableAPI propagates network errors instead of returning an empty list", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockRejectedValue(new Error("socket hang up"));

    await expect(listAppsFromTableAPI(createClient(tableAPIGet))).rejects.toThrow(
      "socket hang up"
    );
  });

  it("listAppsFromTableAPI returns empty list when sys_app endpoint is unavailable (404)", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockRejectedValue(
      Object.assign(new Error("not found"), {
        isAxiosError: true,
        response: { status: 404 },
      })
    );

    await expect(listAppsFromTableAPI(createClient(tableAPIGet))).resolves.toEqual([]);
  });
});
