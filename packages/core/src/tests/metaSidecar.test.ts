// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22: the record metadata layer.
//
// Before this, a workspace held a script include's `script` and nothing else —
// `api_name`, `access`, `client_callable`, `active` and `description` were never
// selected, never written and never diffable, because file-field discovery only
// admits the eight script-ish dictionary types. These tests pin the sidecar that
// carries them: what goes in it, what must never go in it, and what may travel
// back out of it when a user edits the file.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";
import {
  buildManifestFromTableAPI,
  buildBulkDownloadFromTableAPI,
} from "../manifestBuilder.js";
import { buildManifestMetaFields } from "../downloadPipeline.js";
import {
  META_FILE_NAME,
  META_SIDECAR_FILE_NAME,
  isMetaFieldCandidate,
  isMetaFile,
  isMetaSidecarPath,
  isReadOnlyDictionaryRow,
  metaFile,
  resolveMetaUpdate,
  serializeMetaFields,
} from "../metaFields.js";

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, unknown>[] } }>,
  [string, string, string, number?, number?]
>;

function createClient(tableAPIGet: TableApiGet) {
  return { tableAPIGet } as unknown as import("../snClient").SNClient;
}

// The dictionary rows a real sys_script_include walk returns: one file field and
// the five columns that used to be invisible.
const SCRIPT_INCLUDE_DICTIONARY = [
  { element: "script", internal_type: "script" },
  { element: "api_name", internal_type: "string" },
  { element: "access", internal_type: "string" },
  { element: "client_callable", internal_type: "boolean" },
  { element: "active", internal_type: "boolean" },
  { element: "description", internal_type: "string" },
];

const SCRIPT_INCLUDE_ROW = {
  sys_id: "rec-1",
  name: "Include A",
  script: "gs.info('a');",
  api_name: "x_demo.IncludeA",
  access: "public",
  client_callable: "false",
  active: "true",
  description: "does a thing",
};

// A dictionary walk that answers file discovery and metadata discovery from the
// same row set — the two queries differ only by their filter, which is exactly
// how a real instance behaves.
const dictionaryClient = (
  row: Record<string, unknown> = SCRIPT_INCLUDE_ROW,
  dictionary = SCRIPT_INCLUDE_DICTIONARY
): TableApiGet => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
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
      const fileDiscovery = String(query).includes("internal_type=");
      return {
        data: {
          result: fileDiscovery
            ? dictionary.filter((d) => d.internal_type === "script")
            : dictionary,
        },
      };
    }
    if (table === "sys_script_include") {
      return { data: { result: [row] } };
    }
    return { data: { result: [] } };
  });
  return tableAPIGet;
};

const baseConfig: Pick<
  Sync.Config,
  "includes" | "excludes" | "tableOptions" | "meta"
> = { includes: {}, excludes: {}, tableOptions: {} };

describe("metaFields module", () => {
  it("recognises the sidecar pseudo-file by name in both directions", () => {
    expect(metaFile()).toEqual({ name: META_FILE_NAME, type: "json" });
    expect(isMetaFile(metaFile())).toBe(true);
    expect(isMetaFile({ name: "script" })).toBe(false);
    expect(isMetaFile({})).toBe(false);
  });

  // Both layouts, because the flat one is the dangerous one: `<record>~.meta.json`
  // is an ordinary file name that `repair --prune` does inspect.
  it("recognises the sidecar path in the nested and the flat layout", () => {
    expect(isMetaSidecarPath(`/src/sys_script_include/A/${META_SIDECAR_FILE_NAME}`)).toBe(true);
    expect(isMetaSidecarPath(`C:\\src\\sys_script_include\\A\\${META_SIDECAR_FILE_NAME}`)).toBe(true);
    expect(isMetaSidecarPath(`/src/sys_script_include/A~${META_SIDECAR_FILE_NAME}`)).toBe(true);
    expect(isMetaSidecarPath("/src/sys_script_include/A/script.js")).toBe(false);
    // A record legitimately named "meta" is not the sidecar.
    expect(isMetaSidecarPath("/src/sys_script_include/A~meta.json")).toBe(false);
  });

  it("admits ordinary columns and rejects the ones that would churn or leak", () => {
    expect(isMetaFieldCandidate("api_name", "string")).toBe(true);
    expect(isMetaFieldCandidate("client_callable", "boolean")).toBe(true);
    expect(isMetaFieldCandidate("collection", "reference")).toBe(true);

    // File fields: already a field file, or deliberately excluded from one.
    expect(isMetaFieldCandidate("script", "script")).toBe(false);
    expect(isMetaFieldCandidate("css_body", "css")).toBe(false);
    // Credentials must never reach the working tree.
    expect(isMetaFieldCandidate("password", "password2")).toBe(false);
    // Activity streams and binaries have no stable string form.
    expect(isMetaFieldCandidate("work_notes", "journal_input")).toBe(false);
    expect(isMetaFieldCandidate("photo", "user_image")).toBe(false);
    // Platform plumbing, by name and by the blanket prefix rule.
    expect(isMetaFieldCandidate("sys_id", "GUID")).toBe(false);
    expect(isMetaFieldCandidate("sys_overrides", "reference")).toBe(false);
    expect(isMetaFieldCandidate("", "string")).toBe(false);
    expect(isMetaFieldCandidate(undefined, "string")).toBe(false);
  });

  // The sidecar is rewritten on every pull, so anything unstable in it is a diff
  // the user did not cause.
  it("serializes a stable body: sorted keys, empties dropped, trailing newline", () => {
    const body = serializeMetaFields(
      { zeta: "z", alpha: "a", blank: "", absent_from_row: "x", nulled: null },
      ["zeta", "alpha", "blank", "nulled", "never_selected"]
    );

    expect(body).toBe(`${JSON.stringify({ alpha: "a", zeta: "z" }, null, 2)}\n`);
    // Column order from the Table API is not guaranteed; the file must not care.
    expect(serializeMetaFields({ b: "1", a: "2" }, ["b", "a"])).toBe(
      serializeMetaFields({ a: "2", b: "1" }, ["a", "b"])
    );
  });

  // Reference columns arrive as { link, value } because the client does not send
  // sysparm_exclude_reference_link. String() on that yields "[object Object]" —
  // a value that looks like data and is wrong.
  it("unwraps a reference cell to its sys_id", () => {
    const body = JSON.parse(
      serializeMetaFields(
        {
          ref: { link: "https://x/api/now/table/sys_user/abc", value: "abc" },
          broken: { link: "https://x/api/now/table/sys_user/def" },
        },
        ["ref", "broken"]
      )
    );

    expect(body).toEqual({ ref: "abc" });
  });
});

describe("resolveMetaUpdate", () => {
  const known = {
    metaFields: ["access", "active", "api_name", "description"],
    readOnlyFields: ["api_name"],
  };

  it("turns an edited sidecar into a Table-API body", () => {
    const update = resolveMetaUpdate(
      JSON.stringify({ description: "now with feeling", access: "package_private" }),
      known
    );

    expect(update.fields).toEqual({
      description: "now with feeling",
      access: "package_private",
    });
    expect(update.skipped).toEqual([]);
  });

  // We put api_name in the file, so rejecting it would fail every push of a
  // sidecar nobody touched. Dropping it is the only usable behaviour — and the
  // caller reports the drop, so it is still not silent.
  it("drops a read-only column instead of failing the push", () => {
    const update = resolveMetaUpdate(
      JSON.stringify({ api_name: "x_demo.IncludeA", active: "false" }),
      known
    );

    expect(update.fields).toEqual({ active: "false" });
    expect(update.skipped).toEqual(["api_name"]);
  });

  // The whole point of the feature: ServiceNow answers 200 to an update naming a
  // column that does not exist, so a typo would otherwise be a "successful" push
  // that changed nothing.
  it("refuses a column the table does not track, and names it", () => {
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ descripton: "typo" }), known)
    ).toThrow(/descripton/);
  });

  // Absent is not a clear: the serializer omits empty values, so every column
  // that merely happened to be empty at pull time would be wiped.
  it("sends only the keys the file holds", () => {
    const update = resolveMetaUpdate(JSON.stringify({ active: "true" }), known);

    expect(Object.keys(update.fields)).toEqual(["active"]);
  });

  // Clearing IS possible — explicitly, and it survives the round trip.
  it("treats an empty string as an explicit clear", () => {
    expect(resolveMetaUpdate(JSON.stringify({ description: "" }), known).fields)
      .toEqual({ description: "" });
  });

  it("accepts hand-written numbers and booleans as column values", () => {
    expect(
      resolveMetaUpdate(JSON.stringify({ active: false, description: 7 }), known)
        .fields
    ).toEqual({ active: "false", description: "7" });
  });

  it("refuses values with no single column form", () => {
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ access: { value: "public" } }), known)
    ).toThrow(/access/);
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ access: null }), known)
    ).toThrow(/access/);
  });

  it("reports an unusable file as a file problem, not a push problem", () => {
    expect(() => resolveMetaUpdate("{not json", known)).toThrow(
      new RegExp(META_SIDECAR_FILE_NAME.replace(".", "\\."))
    );
    expect(() => resolveMetaUpdate(JSON.stringify(["a"]), known)).toThrow(
      /JSON object/
    );
  });

  // A table with no declared columns can only reject: every key is unknown.
  it("rejects everything when the table declares no columns", () => {
    expect(() => resolveMetaUpdate(JSON.stringify({ active: "x" }), {})).toThrow(
      /active/
    );
  });
});

describe("isReadOnlyDictionaryRow", () => {
  // The Table API renders booleans as strings, but a typed transport can hand
  // back a real boolean; both forms mean the same thing.
  it("reads both the string and the boolean wire form", () => {
    expect(isReadOnlyDictionaryRow({ read_only: "true" })).toBe(true);
    expect(isReadOnlyDictionaryRow({ read_only: true })).toBe(true);
    expect(isReadOnlyDictionaryRow({ virtual: "true" })).toBe(true);
    expect(isReadOnlyDictionaryRow({ read_only: "false", virtual: "false" })).toBe(
      false
    );
    expect(isReadOnlyDictionaryRow({})).toBe(false);
  });
});

describe("manifest metadata discovery", () => {
  it("lists the sidecar on each record and the columns on the table", async () => {
    const tableAPIGet = dictionaryClient();

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig
    );

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toEqual([
      "access",
      "active",
      "api_name",
      "client_callable",
      "description",
    ]);
    const record = table.records["Include A"];
    expect(record.files).toEqual([
      { name: "script", type: "js" },
      { name: META_FILE_NAME, type: "json" },
    ]);
  });

  // The manifest pass records WHICH files a record has, never their content, so
  // it has no reason to select the metadata columns — the download pass does
  // that. What it must not do is leak the pseudo-file into sysparm_fields:
  // ".meta" names no column, and an unknown field invalidates the projection.
  it("never asks the Table API for a column named .meta", async () => {
    const tableAPIGet = dictionaryClient();

    await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), baseConfig);

    const recordCall = tableAPIGet.mock.calls.find(
      (call) => call[0] === "sys_script_include"
    );
    const fields = String(recordCall?.[2]).split(",");
    expect(fields).toContain("script");
    expect(fields).not.toContain(META_FILE_NAME);
  });

  // The push side needs to know which of those columns the instance will accept
  // and silently discard, and the dictionary is the only place that knows.
  it("records which discovered columns are read-only or virtual", async () => {
    const tableAPIGet = dictionaryClient(SCRIPT_INCLUDE_ROW, [
      { element: "script", internal_type: "script" },
      { element: "api_name", internal_type: "string", read_only: "true" },
      { element: "computed", internal_type: "string", virtual: "true" },
      { element: "description", internal_type: "string", read_only: "false" },
    ] as typeof SCRIPT_INCLUDE_DICTIONARY);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig
    );

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toEqual(["api_name", "computed", "description"]);
    expect(table.metaReadOnlyFields).toEqual(["api_name", "computed"]);
  });

  // A hierarchy query returns the base table's dictionary entry alongside any
  // child override, in no guaranteed order. Whichever row marks the column
  // read-only must win, or a push would send a value the instance drops.
  it("takes the union of read-only across a table hierarchy", async () => {
    const tableAPIGet = dictionaryClient(SCRIPT_INCLUDE_ROW, [
      { element: "script", internal_type: "script" },
      { element: "api_name", internal_type: "string" },
      { element: "api_name", internal_type: "string", read_only: "true" },
    ] as typeof SCRIPT_INCLUDE_DICTIONARY);

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig
    );

    expect(manifest.tables.sys_script_include.metaReadOnlyFields).toEqual([
      "api_name",
    ]);
  });

  // An explicit list is the operator's decision, so nothing in it is withheld —
  // and the key stays absent rather than being written as an empty array.
  it("declares no read-only set for an explicit tableOptions list", async () => {
    const tableAPIGet = dictionaryClient();

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      {
        ...baseConfig,
        tableOptions: {
          sys_script_include: { query: "", metaFields: ["api_name"] },
        },
      }
    );

    expect(manifest.tables.sys_script_include).not.toHaveProperty(
      "metaReadOnlyFields"
    );
  });

  it("writes no metadata layer when meta is disabled", async () => {
    const tableAPIGet = dictionaryClient();

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      { ...baseConfig, meta: false }
    );

    const table = manifest.tables.sys_script_include;
    expect(table.metaFields).toBeUndefined();
    expect(table.records["Include A"].files.some(isMetaFile)).toBe(false);
    const metaDiscovery = tableAPIGet.mock.calls.some(
      (call) => call[0] === "sys_dictionary" && !String(call[1]).includes("internal_type=")
    );
    expect(metaDiscovery).toBe(false);
  });

  // The escape hatch for the blunt `sys_` rule, and for any column the default
  // type filter refuses.
  it("lets tableOptions.metaFields replace discovery, minus the file fields", async () => {
    const tableAPIGet = dictionaryClient();

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      {
        ...baseConfig,
        tableOptions: {
          sys_script_include: {
            query: "",
            metaFields: ["sys_overrides", "api_name", "script"],
          },
        },
      }
    );

    expect(manifest.tables.sys_script_include.metaFields).toEqual([
      "api_name",
      "sys_overrides",
    ]);
    // Explicit means explicit: no discovery query is issued at all.
    const metaDiscovery = tableAPIGet.mock.calls.some(
      (call) => call[0] === "sys_dictionary" && !String(call[1]).includes("internal_type=")
    );
    expect(metaDiscovery).toBe(false);
  });

  // Metadata is additive. A table whose metadata columns cannot be enumerated
  // still has its files, and must not be reported as skipped — a skip triggers
  // whole-table carry-forward of the previous manifest.
  it("keeps the table when metadata discovery is refused", async () => {
    const tableAPIGet = dictionaryClient();
    tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_app") return { data: { result: [{ sys_id: "scope-1" }] } };
      if (table === "sys_metadata")
        return { data: { result: [{ sys_class_name: "sys_script_include" }] } };
      if (table === "sys_db_object")
        return { data: { result: [{ name: "sys_script_include" }] } };
      if (table === "sys_dictionary") {
        if (!String(query).includes("internal_type=")) {
          throw Object.assign(new Error("Forbidden"), {
            response: { status: 403, data: {} },
          });
        }
        return { data: { result: [{ element: "script", internal_type: "script" }] } };
      }
      if (table === "sys_script_include")
        return { data: { result: [SCRIPT_INCLUDE_ROW] } };
      return { data: { result: [] } };
    });

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(tableAPIGet),
      baseConfig
    );

    const table = manifest.tables.sys_script_include;
    expect(table).toBeDefined();
    expect(table.metaFields).toBeUndefined();
    expect(table.records["Include A"].files).toEqual([{ name: "script", type: "js" }]);
  });
});

describe("buildManifestMetaFields", () => {
  // The download pass has to relearn the metadata columns from the manifest,
  // because the sidecar entry itself names none of them.
  it("carries only the tables that actually declare columns", () => {
    const manifest = {
      scope: "x_demo",
      tables: {
        sys_script_include: { records: {}, metaFields: ["api_name"] },
        sys_script: { records: {}, metaFields: [] },
        sys_ui_action: { records: {} },
      },
    } as unknown as SN.AppManifest;

    const byTable = buildManifestMetaFields(manifest);

    expect(byTable).toEqual({ sys_script_include: ["api_name"] });
    // Null-prototype, so a table literally named "__proto__" cannot poison the
    // lookup the download pass then does by table name.
    expect(Object.getPrototypeOf(byTable)).toBeNull();
  });
});

describe("bulk download of the sidecar", () => {
  const missingWithMeta = (): SN.MissingFileTableMap => ({
    sys_script_include: {
      "rec-1": [
        { name: "script", type: "js" },
        metaFile(),
      ],
    },
  });

  it("synthesizes the sidecar content from the row", async () => {
    const tableAPIGet = dictionaryClient();

    const tableMap = await buildBulkDownloadFromTableAPI(
      missingWithMeta(),
      createClient(tableAPIGet),
      {},
      undefined,
      { sys_script_include: ["api_name", "access", "active"] }
    );

    const files = tableMap.sys_script_include.records["Include A"].files;
    expect(files[0]).toEqual({ name: "script", type: "js", content: "gs.info('a');" });
    const sidecar = files.find(isMetaFile);
    expect(sidecar?.type).toBe("json");
    expect(JSON.parse(String(sidecar?.content))).toEqual({
      access: "public",
      active: "true",
      api_name: "x_demo.IncludeA",
    });

    // ".meta" must never reach sysparm_fields, but every metadata column must.
    const recordCall = tableAPIGet.mock.calls.find(
      (call) => call[0] === "sys_script_include"
    );
    const fields = String(recordCall?.[2]).split(",");
    expect(fields).not.toContain(META_FILE_NAME);
    expect(fields).toEqual(expect.arrayContaining(["api_name", "access", "active"]));
  });

  // A manifest built against a scoped bulk endpoint carries no metaFields. The
  // download must then behave exactly as it did before DX22.
  it("emits no sidecar when the manifest declares no metadata columns", async () => {
    const tableAPIGet = dictionaryClient();

    const tableMap = await buildBulkDownloadFromTableAPI(
      missingWithMeta(),
      createClient(tableAPIGet),
      {},
      undefined,
      {}
    );

    const files = tableMap.sys_script_include.records["Include A"].files;
    expect(files.some(isMetaFile)).toBe(false);
  });
});
