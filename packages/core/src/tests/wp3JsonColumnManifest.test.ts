// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP3, manifest half: a table an enabled `tablePresets` entry names gets its JSON
// columns as `.json` field files through the Table API build.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  buildManifestFromTableAPI,
} from "../manifestBuilder.js";

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, string>[] } }>,
  [string, string, string, number?, number?]
>;

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

// File-field discovery filters on internal types; the preset's string columns
// are looked up by name (`elementIN`).
const isFileFieldQuery = (query: string): boolean => query.includes("^internal_type=");
const isColumnLookup = (query: string): boolean => query.includes("^elementIN");

const baseConfig = (
  tablePresets: string[],
  overrides: Partial<Sync.Config> = {}
): Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "meta" | "tablePresets"> => ({
  includes: {},
  excludes: {},
  tableOptions: {},
  meta: false,
  tablePresets,
  ...overrides,
});

/** An instance with one in-scope UI Builder page. */
const macroponentInstance = (scopedTables: string[] = ["sys_ux_macroponent"]): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
    if (table === "sys_metadata") {
      return { data: { result: scopedTables.map((t) => ({ sys_class_name: t })) } };
    }
    if (table === "sys_dictionary") {
      if (isFileFieldQuery(query)) {
        const rows = [{ element: "client_script", internal_type: "script_plain" }];
        if (query.includes("internal_type=json")) {
          rows.push({ element: "metadata", internal_type: "json" });
        }
        return { data: { result: rows } };
      }
      if (isColumnLookup(query)) {
        // `data` and `layout` are absent on this release.
        return {
          data: {
            result: [
              { element: "composition", internal_type: "string" },
              { element: "props", internal_type: "string" },
              { element: "root_component_config", internal_type: "password2" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    }
    if (table === "sys_ux_macroponent") {
      return { data: { result: [{ sys_id: "m-1", name: "Home" }] } };
    }
    return { data: { result: [] } };
  });
  return tableAPIGet;
};

const fileNames = (manifest: SN.AppManifest, table: string, record: string): string[] =>
  manifest.tables[table].records[record].files.map((f) => `${f.name}.${f.type}`).sort();

describe("JSON columns of preset tables in the manifest (WP3)", () => {
  it("leaves a table exactly as before when no preset is enabled", async () => {
    const tableAPIGet = macroponentInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig([])
    );

    expect(fileNames(manifest, "sys_ux_macroponent", "Home")).toEqual(["client_script.js"]);
    expect(
      tableAPIGet.mock.calls.some((c) => c[0] === "sys_dictionary" && isColumnLookup(c[1]))
    ).toBe(false);
  });

  it("adds json-typed columns and the dictionary-known string columns as .json files", async () => {
    const tableAPIGet = macroponentInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig(["uib"])
    );

    // `data` / `layout` are unknown to this dictionary; `root_component_config`
    // is a credential type and never becomes a file.
    expect(fileNames(manifest, "sys_ux_macroponent", "Home")).toEqual([
      "client_script.js",
      "composition.json",
      "metadata.json",
      "props.json",
    ]);
  });

  it("respects a field-level exclude", async () => {
    const tableAPIGet = macroponentInstance();
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig(["uib"], {
        excludes: { sys_ux_macroponent: { props: { type: "json" } } } as Sync.TablePropMap,
      })
    );

    expect(fileNames(manifest, "sys_ux_macroponent", "Home")).not.toContain("props.json");
  });

});
