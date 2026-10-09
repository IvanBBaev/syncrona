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
import { logger } from "../Logger.js";
import {
  META_FILE_NAME,
  META_SIDECAR_FILE_NAME,
  isMetaFieldCandidate,
  isMetaFile,
  isMetaSidecarPath,
  isReadOnlyDictionaryRow,
  metaFile,
  metaSecretClassifierFields,
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
    // The identity of the update, and the five per-save audit stamps that would
    // rewrite an untouched file on every pull. These six names are the WHOLE of
    // the name-based exclusion.
    expect(isMetaFieldCandidate("sys_id", "GUID")).toBe(false);
    expect(isMetaFieldCandidate("sys_updated_on", "glide_date_time")).toBe(false);
    expect(isMetaFieldCandidate("sys_mod_count", "integer")).toBe(false);
    expect(isMetaFieldCandidate("", "string")).toBe(false);
    expect(isMetaFieldCandidate(undefined, "string")).toBe(false);
  });

  // The rule used to be "reject every sys_ column". It threw away the answers to
  // real questions — which scope owns this, is it protected, what does it
  // override — for the sake of the six names pinned above, and left the
  // workspace as uninformative as the pre-DX22 one it replaced.
  it("carries the sys_ columns that describe the record, not the last save", () => {
    for (const column of [
      "sys_name",
      "sys_scope",
      "sys_package",
      "sys_policy",
      "sys_class_name",
      "sys_overrides",
      "sys_update_name",
      "sys_domain",
      "sys_customer_update",
      "sys_replace_on_upgrade",
    ]) {
      expect(isMetaFieldCandidate(column, "string")).toBe(true);
    }
  });

  // The sidecar is rewritten on every pull, so anything unstable in it is a diff
  // the user did not cause.
  it("serializes a stable body: sorted keys, empties kept, trailing newline", () => {
    const body = serializeMetaFields(
      { zeta: "z", alpha: "a", blank: "", absent_from_row: "x", nulled: null },
      ["zeta", "alpha", "blank", "nulled", "never_selected"]
    );

    expect(body).toBe(
      `${JSON.stringify({ alpha: "a", blank: "", nulled: "", zeta: "z" }, null, 2)}\n`
    );
    // Column order from the Table API is not guaranteed; the file must not care.
    expect(serializeMetaFields({ b: "1", a: "2" }, ["b", "a"])).toBe(
      serializeMetaFields({ a: "2", b: "1" }, ["a", "b"])
    );
  });

  // Measured on a live instance: sys_script_include.caller_access is tracked and
  // writable, and was blank on all 17 records of the test scope — so the one
  // column a reader most needed to discover was the one the file never showed.
  it("shows a tracked column that is empty on the instance, so it can be set", () => {
    const body = JSON.parse(
      serializeMetaFields({ access: "public", caller_access: "" }, [
        "access",
        "caller_access",
      ])
    );

    expect(body).toEqual({ access: "public", caller_access: "" });
    expect("caller_access" in body).toBe(true);
  });

  // Different state, different answer: a column the response never carried was
  // hidden by a read ACL, and claiming "" for it would invent a value.
  it("stays silent about a column the response did not carry at all", () => {
    const body = JSON.parse(
      serializeMetaFields({ access: "public" }, ["access", "hidden_by_acl"])
    );

    expect(body).toEqual({ access: "public" });
    expect("hidden_by_acl" in body).toBe(false);
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

    // A reference with no `value` has no sys_id to carry — it is empty, and now
    // says so rather than vanishing.
    expect(body).toEqual({ ref: "abc", broken: "" });
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

  // The dictionary does not mark these read-only, yet writing them would move the
  // record to another application or rename its update-set identity.
  it("never pushes the platform-owned scope, package, policy and update-name columns", () => {
    const update = resolveMetaUpdate(
      JSON.stringify({
        sys_scope: "other-scope",
        sys_package: "other-package",
        sys_policy: "protected",
        sys_update_name: "sys_script_include_x",
        active: "true",
      }),
      {
        metaFields: [...known.metaFields, "sys_scope", "sys_package", "sys_policy", "sys_update_name"],
        readOnlyFields: known.readOnlyFields,
      }
    );

    expect(update.fields).toEqual({ active: "true" });
    expect([...update.skipped].sort()).toEqual(["sys_package", "sys_policy", "sys_scope", "sys_update_name"]);
  });

  // The whole point of the feature: ServiceNow answers 200 to an update naming a
  // column that does not exist, so a typo would otherwise be a "successful" push
  // that changed nothing.
  it("refuses a column the table does not track, and names it", () => {
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ descripton: "typo" }), known)
    ).toThrow(/descripton/);
  });

  // Absent is not a clear: the update is a merge, and a file trimmed by hand or
  // written by an older version is missing keys for reasons unrelated to intent.
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

  // A table with no declared columns can only reject — but the reason is never
  // the file. It is a manifest that lost its metadata layer, and telling the
  // user to fix their keys would send them to edit a correct file.
  it("blames the manifest, not the file, when the table declares no columns", () => {
    expect(() => resolveMetaUpdate(JSON.stringify({ active: "x" }), {})).toThrow(
      /syncrona refresh/
    );
    expect(() => resolveMetaUpdate(JSON.stringify({ active: "x" }), {})).toThrow(
      /records no metadata columns/
    );
    // The other message — the one that does blame the file — still fires when
    // the table genuinely tracks columns and the key is not one of them.
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ active: "x" }), { metaFields: ["access"] })
    ).toThrow(/does not track/);
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

  // Encrypted and masked columns hold a secret exactly as password2 does; the
  // dictionary's own type is the only signal, so each must be in the set.
  const ENCRYPTED_DICTIONARY = [
    ...SCRIPT_INCLUDE_DICTIONARY,
    { element: "u_cipher", internal_type: "glide_encrypted" },
    { element: "u_enc_text", internal_type: "encrypted_text" },
    { element: "u_masked", internal_type: "masked" },
  ];
  const ENCRYPTED_ROW = { ...SCRIPT_INCLUDE_ROW, u_cipher: "c", u_enc_text: "e", u_masked: "m" };

  it.each(["glide_encrypted", "encrypted_text", "masked"])(
    "never admits a %s column as a sidecar candidate",
    (type) => {
      expect(isMetaFieldCandidate("u_x", type)).toBe(false);
    }
  );

  it("leaves encrypted and masked columns out of discovery", async () => {
    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      createClient(dictionaryClient(ENCRYPTED_ROW, ENCRYPTED_DICTIONARY)),
      baseConfig
    );

    expect(manifest.tables.sys_script_include.metaFields).toEqual([
      "access",
      "active",
      "api_name",
      "client_callable",
      "description",
    ]);
  });

  it("drops encrypted and masked columns an explicit metaFields list names", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const manifest = await buildManifestFromTableAPI(
        "x_demo",
        createClient(dictionaryClient(ENCRYPTED_ROW, ENCRYPTED_DICTIONARY)),
        {
          ...baseConfig,
          tableOptions: {
            sys_script_include: {
              query: "",
              metaFields: ["api_name", "u_cipher", "u_enc_text", "u_masked"],
            },
          },
        }
      );

      expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('metaFields entry for column "u_cipher" — its dictionary type is glide_encrypted'),
          expect.stringContaining('metaFields entry for column "u_enc_text" — its dictionary type is encrypted_text'),
          expect.stringContaining('metaFields entry for column "u_masked" — its dictionary type is masked'),
        ])
      );
    } finally {
      warn.mockRestore();
    }
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
  // An explicit list replaces discovery, not the unsafe-type rule: the repro
  // was `sys_user.metaFields: ["user_password", ...]` writing the password.
  it("drops an unsafe column an explicit tableOptions.metaFields list names", async () => {
    const tableAPIGet = dictionaryClient(
      { ...SCRIPT_INCLUDE_ROW, u_secret: "hunter2", u_log: "entry" },
      [
        ...SCRIPT_INCLUDE_DICTIONARY,
        { element: "u_secret", internal_type: "password2" },
        { element: "u_log", internal_type: "journal" },
      ]
    );
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        ...baseConfig,
        tableOptions: {
          sys_script_include: { query: "", metaFields: ["u_secret", "u_log", "api_name"] },
        },
      });

      expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toEqual(
        expect.arrayContaining([
          'Table sys_script_include: ignoring the metaFields entry for column "u_secret" — its ' +
            "dictionary type is password2, and a value of that type is never written to the working tree.",
          'Table sys_script_include: ignoring the metaFields entry for column "u_log" — its ' +
            "dictionary type is journal, and a value of that type is never written to the working tree.",
        ])
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The dictionary answers `u_secret` for a query naming `U_SECRET`; matching
  // the element exactly left the entry untyped, and so kept.
  it("matches a metaFields entry to its dictionary element case-insensitively", async () => {
    const tableAPIGet = dictionaryClient(
      { ...SCRIPT_INCLUDE_ROW, U_SECRET: "hunter2" },
      [...SCRIPT_INCLUDE_DICTIONARY, { element: "u_secret", internal_type: "password2" }]
    );
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        ...baseConfig,
        tableOptions: { sys_script_include: { query: "", metaFields: ["U_SECRET", "api_name"] } },
      });

      expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        'Table sys_script_include: ignoring the metaFields entry for column "U_SECRET" — its ' +
          "dictionary type is password2, and a value of that type is never written to the working tree."
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The explicit list is the documented remedy for a user who cannot read
  // sys_dictionary, so a failed type lookup keeps it — with a warning.
  it("keeps an explicit metaFields list, warned, when the type lookup fails", async () => {
    const base = dictionaryClient();
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, ...rest: unknown[]) => {
      if (table === "sys_dictionary" && String(query).includes("elementIN")) {
        throw new Error("Forbidden");
      }
      return (base as (...args: unknown[]) => unknown)(table, query, ...rest);
    });
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        ...baseConfig,
        tableOptions: { sys_script_include: { query: "", metaFields: ["api_name"] } },
      });

      expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        "Table sys_script_include: could not read the dictionary type of metaFields column(s) " +
          "api_name (Forbidden); they are kept without the unsafe-type check."
      );
    } finally {
      warn.mockRestore();
    }
  });

  // A dot-walked name reads a column of ANOTHER record: this table's dictionary
  // has no row for it, so the type check would call it "unknown" and keep it —
  // and `sys_created_by.user_password` is the creator's password.
  it("refuses a dot-walked metaFields entry and never requests it", async () => {
    const tableAPIGet = dictionaryClient();
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const manifest = await buildManifestFromTableAPI("x_demo", createClient(tableAPIGet), {
        ...baseConfig,
        tableOptions: {
          sys_script_include: {
            query: "",
            metaFields: ["api_name", "sys_created_by.user_password", "manager.user_password"],
          },
        },
      });

      expect(manifest.tables.sys_script_include.metaFields).toEqual(["api_name"]);
      const requested = tableAPIGet.mock.calls.map((call) => `${call[1]} ${call[2]}`).join("\n");
      expect(requested).not.toContain("user_password");
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          'Table sys_script_include: ignoring the metaFields entry for column "sys_created_by.user_password" — ' +
            "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
            "so it is never written to the working tree.",
          'Table sys_script_include: ignoring the metaFields entry for column "manager.user_password" — ' +
            "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
            "so it is never written to the working tree.",
        ])
      );
    } finally {
      warn.mockRestore();
    }
  });

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
    // Explicit means explicit: no discovery query is issued. The only
    // dictionary read beyond the file-field query is the type lookup of the
    // columns the list names, for the unsafe-type rule.
    const dictionaryQueries = tableAPIGet.mock.calls
      .filter((call) => call[0] === "sys_dictionary" && !String(call[1]).includes("internal_type="))
      .map((call) => String(call[1]));
    expect(dictionaryQueries).toEqual([
      expect.stringContaining("^elementINsys_overrides,api_name"),
    ]);
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

  // The manifest is a committed, hand-editable file, and one written before the
  // explicit-list filter can still name a credential column. The writer checks
  // the dictionary type itself.
  it("never writes a password2 column a manifest's metaFields still names", async () => {
    const tableAPIGet = dictionaryClient(
      { ...SCRIPT_INCLUDE_ROW, u_secret: "hunter2" },
      [...SCRIPT_INCLUDE_DICTIONARY, { element: "u_secret", internal_type: "password2" }]
    );

    const tableMap = await buildBulkDownloadFromTableAPI(
      missingWithMeta(),
      createClient(tableAPIGet),
      {},
      undefined,
      { sys_script_include: ["api_name", "u_secret"] }
    );

    const sidecar = tableMap.sys_script_include.records["Include A"].files.find(isMetaFile);
    expect(JSON.parse(String(sidecar?.content))).toEqual({ api_name: "x_demo.IncludeA" });
  });

  it("never writes an unsafe column a manifest names in another case", async () => {
    const tableAPIGet = dictionaryClient(
      { ...SCRIPT_INCLUDE_ROW, U_SECRET: "hunter2" },
      [...SCRIPT_INCLUDE_DICTIONARY, { element: "u_secret", internal_type: "password2" }]
    );

    const tableMap = await buildBulkDownloadFromTableAPI(
      missingWithMeta(),
      createClient(tableAPIGet),
      {},
      undefined,
      { sys_script_include: ["api_name", "U_SECRET"] }
    );

    const sidecar = tableMap.sys_script_include.records["Include A"].files.find(isMetaFile);
    expect(JSON.parse(String(sidecar?.content))).toEqual({ api_name: "x_demo.IncludeA" });
  });

  it("never requests or writes a dot-walked column a manifest's metaFields names", async () => {
    const tableAPIGet = dictionaryClient({
      ...SCRIPT_INCLUDE_ROW,
      "sys_created_by.user_password": "hunter2",
    });
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const tableMap = await buildBulkDownloadFromTableAPI(
        missingWithMeta(),
        createClient(tableAPIGet),
        {},
        undefined,
        { sys_script_include: ["api_name", "sys_created_by.user_password"] }
      );

      const sidecar = tableMap.sys_script_include.records["Include A"].files.find(isMetaFile);
      expect(JSON.parse(String(sidecar?.content))).toEqual({ api_name: "x_demo.IncludeA" });
      const requested = tableAPIGet.mock.calls.map((call) => `${call[1]} ${call[2]}`).join("\n");
      expect(requested).not.toContain("user_password");
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        'Table sys_script_include: ignoring the metaFields entry for column "sys_created_by.user_password" — ' +
          "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
          "so it is never written to the working tree."
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still writes the sidecar when the column types cannot be read", async () => {
    const base = dictionaryClient();
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string, query: string, ...rest: unknown[]) => {
      if (table === "sys_dictionary") {
        throw new Error("Forbidden");
      }
      return (base as (...args: unknown[]) => unknown)(table, query, ...rest);
    });
    const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const tableMap = await buildBulkDownloadFromTableAPI(
        missingWithMeta(),
        createClient(tableAPIGet),
        {},
        undefined,
        { sys_script_include: ["api_name"] }
      );

      const sidecar = tableMap.sys_script_include.records["Include A"].files.find(isMetaFile);
      expect(JSON.parse(String(sidecar?.content))).toEqual({ api_name: "x_demo.IncludeA" });
      // Fail-open, but never silent: one warning for the table, saying what
      // went unchecked.
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        "Table sys_script_include: could not verify the dictionary types of the sidecar columns " +
          "(Forbidden); writing the manifest's metaFields as recorded, so an unsafe column may be written.",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

// A password property's secret lives in `sys_properties.value`, a plain string
// column, so the dictionary type filter cannot catch it: the record's `type`
// decides. The value must never reach the working tree.
describe("password-type system properties", () => {
  const FIELDS = ["description", "name", "type", "value"];

  it.each(["password", "password2", "Password2"])(
    "leaves value out of the sidecar of a %s property",
    (type) => {
      const body = JSON.parse(
        serializeMetaFields(
          { name: "x_demo.api.key", type, value: "s3cr3t", description: "API key" },
          FIELDS,
          "sys_properties"
        )
      );
      expect(body).toEqual({ description: "API key", name: "x_demo.api.key", type });
      expect(JSON.stringify(body)).not.toContain("s3cr3t");
    }
  );

  it("fails closed when the property type is missing or unreadable", () => {
    for (const row of [
      { name: "x_demo.p", value: "s3cr3t" },
      { name: "x_demo.p", type: "", value: "s3cr3t" },
      { name: "x_demo.p", type: { link: "x" }, value: "s3cr3t" },
    ]) {
      expect(serializeMetaFields(row, FIELDS, "sys_properties")).not.toContain("s3cr3t");
    }
  });

  it("keeps value for a non-secret property and for other tables", () => {
    expect(
      JSON.parse(
        serializeMetaFields({ name: "x_demo.p", type: "string", value: "10" }, FIELDS, "sys_properties")
      ).value
    ).toBe("10");
    expect(
      JSON.parse(serializeMetaFields({ name: "n", type: "password", value: "v" }, FIELDS, "x_other"))
        .value
    ).toBe("v");
    expect(JSON.parse(serializeMetaFields({ value: "v" }, ["value"])).value).toBe("v");
  });

  it("never serializes a column whose given dictionary type is unsafe", () => {
    const types = new Map([
      ["user_password", "password2"],
      ["notes", "Journal "],
      ["name", "string"],
    ]);
    const row = { user_password: "hunter2", notes: "entry", name: "admin" };
    expect(
      JSON.parse(serializeMetaFields(row, ["user_password", "notes", "name"], "sys_user", types))
    ).toEqual({ name: "admin" });
  });

  it("never serializes a dot-walked column, whatever the row carries", () => {
    const row = { name: "admin", "manager.user_password": "hunter2" };
    expect(JSON.parse(serializeMetaFields(row, ["name", "manager.user_password"], "sys_user"))).toEqual({
      name: "admin",
    });
  });

  it("reports the classifier column a sidecar read must fetch", () => {
    expect(metaSecretClassifierFields("sys_properties")).toEqual(["type"]);
    expect(metaSecretClassifierFields("sys_script_include")).toEqual([]);
    expect(metaSecretClassifierFields(undefined)).toEqual([]);
  });

  it("fetches type and redacts value on a bulk download even when metaFields omit type", async () => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockImplementation(async (table: string) =>
      table === "sys_properties"
        ? {
            data: {
              result: [
                { sys_id: "p-1", name: "x_demo.api.key", type: "password2", value: "s3cr3t" },
              ],
            },
          }
        : { data: { result: [] } }
    );

    const tableMap = await buildBulkDownloadFromTableAPI(
      { sys_properties: { "p-1": [metaFile()] } },
      createClient(tableAPIGet),
      {},
      undefined,
      { sys_properties: ["name", "value"] }
    );

    const record = Object.values(tableMap.sys_properties.records)[0];
    const sidecar = record.files.find(isMetaFile);
    expect(JSON.parse(String(sidecar?.content))).toEqual({ name: "x_demo.api.key" });
    const call = tableAPIGet.mock.calls.find((c) => c[0] === "sys_properties");
    expect(String(call?.[2]).split(",")).toEqual(expect.arrayContaining(["name", "type", "value"]));
  });
});
