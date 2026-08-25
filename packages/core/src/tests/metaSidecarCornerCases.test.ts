// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22 corner cases: the record metadata layer under inputs the tool does not
// choose.
//
// Two of those inputs are outside our control by design. Column NAMES come from
// `sys_dictionary.element` and from an operator's `tableOptions.<table>.metaFields`
// — and `constructor`, `toString`, `valueOf`, `hasOwnProperty` are all valid
// ServiceNow column-name shapes (lowercase, alphanumeric) that are also members
// of `Object.prototype`. Column VALUES come off the wire in whatever shape the
// configured transport produces. Sidecar BYTES come back from whatever editor
// the user opened the file in.
//
// Each of these used to fail quietly rather than loudly, which is the one
// outcome this feature exists to remove: a push that reports success and changes
// nothing, or a pull that writes a value the instance never sent.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";
import { buildBulkDownloadFromTableAPI } from "../manifestBuilder.js";
import {
  isMetaFile,
  metaFile,
  resolveMetaUpdate,
  serializeMetaFields,
} from "../metaFields.js";

// Every own-name member of Object.prototype whose name a ServiceNow column could
// legally carry. `__proto__` is handled separately below — it is not a plain
// data property but an accessor, so it fails differently.
const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
];

describe("serializeMetaFields under prototype-shaped column names", () => {
  // `field in row` walks the prototype chain, so every one of these names was
  // reported as "the instance returned this column" for a row that carries no
  // such column — and then String()'d, putting a native function body into a
  // file the user is invited to edit and push back.
  it("stays silent about a tracked column the row does not carry", () => {
    const body = JSON.parse(
      serializeMetaFields({ access: "public" }, ["access", ...PROTOTYPE_NAMES])
    );

    expect(body).toEqual({ access: "public" });
    expect(JSON.stringify(body)).not.toMatch(/native code/);
  });

  // The distinction the module already documents for ordinary names — absent
  // from the response is NOT the same as empty — has to hold for these too.
  it("still writes such a column when the row really carries it", () => {
    const row = JSON.parse('{"constructor": "abc", "valueOf": ""}');

    expect(JSON.parse(serializeMetaFields(row, ["constructor", "valueOf"]))).toEqual({
      constructor: "abc",
      valueOf: "",
    });
  });

  // `body["__proto__"] = "x"` on a plain object hits the Object.prototype
  // setter, which ignores a string: no own property, nothing serialized. The
  // column was silently dropped from a file that claims to hold every tracked
  // column.
  it("writes a column literally named __proto__ instead of dropping it", () => {
    const row = JSON.parse('{"__proto__": "x_demo", "access": "public"}');

    const text = serializeMetaFields(row, ["__proto__", "access"]);

    expect(Object.keys(JSON.parse(text))).toEqual(["__proto__", "access"]);
    expect(JSON.parse(text).__proto__).toBe("x_demo");
  });
});

describe("serializeMetaFields under non-string cell values", () => {
  // The object form exists because references arrive as { link, value }. But
  // the unwrap only accepted a string `value` and answered "" for anything
  // else, so a transport that preserves the column's own type — or any client
  // configured with sysparm_display_value — erased the value it was sent to
  // carry, and the sidecar reported the column as empty.
  it("keeps a numeric or boolean cell value rather than erasing it", () => {
    const body = JSON.parse(
      serializeMetaFields(
        {
          order: { value: 100, display_value: "100" },
          active: { value: false },
          ref: { value: "abc", link: "https://x/api/now/table/sys_user/abc" },
        },
        ["order", "active", "ref"]
      )
    );

    expect(body).toEqual({ order: "100", active: "false", ref: "abc" });
  });

  // Unchanged: a shape with no single string form is still "", because
  // inventing "[object Object]" is worse than admitting we have nothing.
  it("still answers empty for a cell with no usable value", () => {
    const body = JSON.parse(
      serializeMetaFields(
        {
          novalue: { link: "https://x/api/now/table/sys_user/def" },
          nulled: { value: null },
          nested: { value: { a: 1 } },
          listed: { value: ["a"] },
        },
        ["novalue", "nulled", "nested", "listed"]
      )
    );

    expect(body).toEqual({ novalue: "", nulled: "", nested: "", listed: "" });
  });
});

describe("bulk download under prototype-shaped field names", () => {
  const client = (row: Record<string, unknown>) =>
    ({
      tableAPIGet: jest.fn(async () => ({ data: { result: [row] } })),
    }) as unknown as import("../snClient").SNClient;

  const missing = (fields: SN.File[]): SN.MissingFileTableMap => ({
    sys_script_include: { "rec-1": fields },
  });

  // Same `in` on the file-field side, and here the cost is a written file: the
  // guard exists precisely to leave a local file untouched when the instance
  // returned no value for its column, and a column named `constructor` walked
  // straight past it and produced `content: function Object() { [native code] }`.
  it("omits a field the row does not carry, whatever it is named", async () => {
    const tableMap = await buildBulkDownloadFromTableAPI(
      missing([
        { name: "script", type: "js" },
        { name: "constructor", type: "js" },
        { name: "toString", type: "js" },
      ]),
      client({ sys_id: "rec-1", name: "Include A", script: "gs.info('a');" }),
      {}
    );

    const files = tableMap.sys_script_include.records["Include A"].files;
    expect(files.map((f) => f.name)).toEqual(["script"]);
  });

  it("still returns such a field when the row carries it", async () => {
    const row = JSON.parse(
      '{"sys_id": "rec-1", "name": "Include A", "constructor": "gs.info(1);"}'
    );

    const tableMap = await buildBulkDownloadFromTableAPI(
      missing([{ name: "constructor", type: "js" }]),
      client(row),
      {}
    );

    expect(tableMap.sys_script_include.records["Include A"].files).toEqual([
      { name: "constructor", type: "js", content: "gs.info(1);" },
    ]);
  });

  // The sidecar rides the same loop, so it has to survive the same row.
  it("still synthesizes the sidecar alongside the omitted field", async () => {
    const tableMap = await buildBulkDownloadFromTableAPI(
      missing([{ name: "toString", type: "js" }, metaFile()]),
      client({ sys_id: "rec-1", name: "Include A", access: "public" }),
      {},
      undefined,
      { sys_script_include: ["access"] }
    );

    const files = tableMap.sys_script_include.records["Include A"].files;
    const sidecar = files.find(isMetaFile);
    expect(files.some((f) => f.name === "toString")).toBe(false);
    expect(JSON.parse(String(sidecar?.content))).toEqual({ access: "public" });
  });
});

describe("resolveMetaUpdate under bytes the user did not type", () => {
  const known = { metaFields: ["access", "active"], readOnlyFields: [] };

  // A UTF-8 BOM is what Notepad, PowerShell redirection and a VS Code workspace
  // with `files.encoding: utf8bom` all write, and syncrona explicitly supports
  // Windows and WSL. JSON.parse rejects it, so a sidecar the user edited
  // correctly failed the push with a message about invalid JSON pointing at a
  // file that looks perfectly valid in the editor that wrote it.
  // Built from a char code on purpose: a literal U+FEFF in this source file is
  // invisible in every editor, including the one reading this test.
  const BOM = String.fromCharCode(0xfeff);

  it("accepts a sidecar saved with a UTF-8 BOM", () => {
    const update = resolveMetaUpdate(
      `${BOM}${JSON.stringify({ active: "false" })}`,
      known
    );

    expect(update.fields).toEqual({ active: "false" });
  });

  it("still reports genuinely unparseable content as a file problem", () => {
    expect(() => resolveMetaUpdate(`${BOM}{not json`, known)).toThrow(
      /not valid JSON/
    );
  });
});

describe("resolveMetaUpdate under prototype-shaped column names", () => {
  // The update body is built by assignment, so a column named `__proto__` was
  // accepted as writable, assigned, and then silently absent from the PATCH —
  // a push that reports success and changes nothing, which is the exact failure
  // this module was written to make impossible.
  it("carries a column literally named __proto__ into the update body", () => {
    const update = resolveMetaUpdate('{"__proto__": "x_demo"}', {
      metaFields: ["__proto__"],
    });

    expect(Object.keys(update.fields)).toEqual(["__proto__"]);
    expect(update.fields.__proto__).toBe("x_demo");
  });

  it("carries the other prototype-shaped names too", () => {
    const update = resolveMetaUpdate(
      JSON.stringify({ constructor: "abc", toString: "def" }),
      { metaFields: ["constructor", "toString"] }
    );

    expect(update.fields.constructor).toBe("abc");
    expect(update.fields.toString).toBe("def");
  });

  // And an unknown key is still rejected by name, not accidentally admitted
  // because `writable` happens to inherit it.
  it("still refuses a prototype-shaped key the table does not track", () => {
    expect(() =>
      resolveMetaUpdate(JSON.stringify({ toString: "x" }), {
        metaFields: ["access"],
      })
    ).toThrow(/does not track/);
  });
});
