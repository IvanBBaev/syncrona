// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22 regression: the metadata layer on the SCOPED-manifest path.
//
// The sidecar shipped wired into buildManifestFromTableAPI only — the fallback
// that runs when the companion Sincronia scoped app is absent. On every
// instance that HAS the app (the setup the docs recommend), `getManifest`
// succeeds and answers with records whose `files` list holds the file fields and
// nothing else. buildManifestMetaFields then found no `metaFields`, no record
// carried the `.meta` pseudo-file, and the whole layer did nothing — silently,
// with no warning and a "Download complete ✅" over a workspace holding scripts
// and no metadata at all. Reproduced against a live instance before this fix.
//
// These tests pin the enrichment that closes it: what it adds, what it must
// leave alone, and that it survives the opt-out.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import { attachMetaFieldsToManifest } from "../manifestBuilder.js";
import { buildManifestMetaFields } from "../downloadPipeline.js";
import { META_FILE_NAME, isMetaFile } from "../metaFields.js";

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, unknown>[] } }>,
  [string, string, string, number?, number?]
>;

const SCRIPT_INCLUDE_DICTIONARY = [
  { element: "script", internal_type: "script" },
  // Read-only on a real sys_script_include: the platform derives it from the
  // scope and the name, and a push that sends it back is accepted and discarded.
  { element: "api_name", internal_type: "string", read_only: "true" },
  { element: "access", internal_type: "string" },
  { element: "client_callable", internal_type: "boolean" },
  { element: "active", internal_type: "boolean" },
];

// Only the dictionary and the hierarchy walk are exercised here: the enrichment
// never reads records, it re-labels the manifest it was handed.
const dictionaryClient = (
  dictionary: Record<string, unknown>[] = SCRIPT_INCLUDE_DICTIONARY
): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string) => {
    if (table === "sys_db_object") {
      return { data: { result: [{ name: "sys_script_include" }] } };
    }
    if (table === "sys_dictionary") {
      return { data: { result: dictionary } };
    }
    return { data: { result: [] } };
  });
  return tableAPIGet;
};

const createClient = (tableAPIGet: TableApiGet) =>
  ({ tableAPIGet }) as unknown as import("../snClient").SNClient;

// Exactly what `sinc/getManifest/<scope>` answers for a script include: a record
// with its file fields and no trace of a metadata layer.
const scopedManifest = (): SN.AppManifest => ({
  scope: "x_demo",
  tables: {
    sys_script_include: {
      records: {
        IncludeA: {
          name: "IncludeA",
          sys_id: "rec-1",
          files: [{ name: "script", type: "js" }],
        },
        IncludeB: {
          name: "IncludeB",
          sys_id: "rec-2",
          files: [{ name: "script", type: "js" }],
        },
      },
    },
  },
});

const config = (
  overrides: Partial<Pick<Sync.Config, "tableOptions" | "meta">> = {}
): Pick<Sync.Config, "tableOptions" | "meta"> => ({
  tableOptions: {},
  ...overrides,
});

describe("attachMetaFieldsToManifest (DX22 on the scoped-manifest path)", () => {
  it("gives a scoped manifest the metaFields and the .meta pseudo-file it lacks", async () => {
    const manifest = scopedManifest();
    await attachMetaFieldsToManifest(manifest, createClient(dictionaryClient()), config());

    const table = manifest.tables.sys_script_include;
    // `script` is a file field and must not be duplicated as metadata; the
    // read-only column is listed in both places, as in the builder.
    expect(table.metaFields).toEqual(["access", "active", "api_name", "client_callable"]);
    expect(table.metaReadOnlyFields).toEqual(["api_name"]);

    for (const record of Object.values(table.records)) {
      expect(record.files.map((f) => f.name)).toEqual(["script", META_FILE_NAME]);
      expect(record.files.filter(isMetaFile)).toHaveLength(1);
    }

    // The end of the chain: this is the map the download side reads, and the
    // one that came back empty for every scoped-app user.
    expect(buildManifestMetaFields(manifest)).toEqual({
      sys_script_include: table.metaFields,
    });
  });

  it("is idempotent — a second pass adds no duplicate sidecar entry", async () => {
    const manifest = scopedManifest();
    const client = createClient(dictionaryClient());
    await attachMetaFieldsToManifest(manifest, client, config());
    const callsAfterFirst = (client.tableAPIGet as unknown as TableApiGet).mock.calls.length;

    await attachMetaFieldsToManifest(manifest, client, config());

    // A table that already carries metaFields is skipped outright, so the second
    // pass issues no dictionary query at all — which is also what keeps this
    // safe to call on a Table-API build that already did the work.
    expect((client.tableAPIGet as unknown as TableApiGet).mock.calls.length).toBe(
      callsAfterFirst
    );
    for (const record of Object.values(manifest.tables.sys_script_include.records)) {
      expect(record.files.filter(isMetaFile)).toHaveLength(1);
    }
  });

  it("honours `meta: false` — the opt-out has to hold on both manifest paths", async () => {
    const manifest = scopedManifest();
    const client = createClient(dictionaryClient());
    await attachMetaFieldsToManifest(manifest, client, config({ meta: false }));

    expect(manifest.tables.sys_script_include.metaFields).toBeUndefined();
    expect(client.tableAPIGet).not.toHaveBeenCalled();
    for (const record of Object.values(manifest.tables.sys_script_include.records)) {
      expect(record.files.some(isMetaFile)).toBe(false);
    }
  });

  it("leaves a table with no metadata columns exactly as it was", async () => {
    const manifest = scopedManifest();
    await attachMetaFieldsToManifest(
      manifest,
      // A table whose only column is the file field it already publishes.
      createClient(dictionaryClient([{ element: "script", internal_type: "script" }])),
      config()
    );

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toBeUndefined();
    expect(table.metaReadOnlyFields).toBeUndefined();
    for (const record of Object.values(table.records)) {
      expect(record.files.some(isMetaFile)).toBe(false);
    }
  });

  it("excludes a file field even when only one record happens to publish it", async () => {
    // An empty column yields no file for that record. Reading the file-field set
    // off a single record would let the gap re-admit the column as metadata, so
    // the same column would be written twice — once as a field file, once inside
    // the sidecar — and a push would read back whichever it reached first.
    const manifest = scopedManifest();
    manifest.tables.sys_script_include.records.IncludeB.files = [];

    await attachMetaFieldsToManifest(manifest, createClient(dictionaryClient()), config());

    expect(manifest.tables.sys_script_include.metaFields).not.toContain("script");
  });

  it("takes an explicit tableOptions.metaFields list over discovery", async () => {
    const manifest = scopedManifest();
    const client = createClient(dictionaryClient());
    await attachMetaFieldsToManifest(
      manifest,
      client,
      config({ tableOptions: { sys_script_include: { metaFields: ["description", "script"] } } })
    );

    // The file field is still dropped: an explicit list decides WHICH columns,
    // never that a column may claim two writers.
    expect(manifest.tables.sys_script_include.metaFields).toEqual(["description"]);
    expect(client.tableAPIGet).not.toHaveBeenCalled();
  });

  it("keeps the scripts when the dictionary cannot be read", async () => {
    const failing: TableApiGet = jest.fn();
    failing.mockImplementation(async (table: string) => {
      if (table === "sys_db_object") {
        return { data: { result: [{ name: "sys_script_include" }] } };
      }
      throw new Error("ACL: sys_dictionary is not readable");
    });

    const manifest = scopedManifest();
    // Metadata is additive: a table whose dictionary is hidden is the pre-DX22
    // table, which is a complete and usable result — not a failed refresh.
    await expect(
      attachMetaFieldsToManifest(manifest, createClient(failing), config())
    ).resolves.toBe(manifest);
    expect(manifest.tables.sys_script_include.metaFields).toBeUndefined();
    for (const record of Object.values(manifest.tables.sys_script_include.records)) {
      expect(record.files.map((f) => f.name)).toEqual(["script"]);
    }
  });

  it("tolerates an empty table and a record with no files array", async () => {
    const manifest: SN.AppManifest = {
      scope: "x_demo",
      tables: {
        empty_table: { records: {} },
        sys_script_include: {
          records: {
            IncludeA: {
              name: "IncludeA",
              sys_id: "rec-1",
            } as unknown as SN.MetaRecord,
          },
        },
      },
    };

    await attachMetaFieldsToManifest(manifest, createClient(dictionaryClient()), config());

    expect(manifest.tables.empty_table.metaFields).toBeUndefined();
    expect(
      manifest.tables.sys_script_include.records.IncludeA.files.filter(isMetaFile)
    ).toHaveLength(1);
  });
});
