// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for the serializer's decisions that a golden fixture cannot express
 * cleanly: wire-form quirks, hostile input, and the two Unicode rules that pull
 * in opposite directions (names are normalized, contents are not).
 */
import type { FieldDescriptor, TableCatalogEntry } from "../src/contracts";
import {
  canonicalJsonBytes,
  canonicalJsonText,
  encodeUtf8,
  serializeRow,
  withTrailingNewline,
} from "../src/serialize/serializer";

const field = (partial: Partial<FieldDescriptor>): FieldDescriptor => ({
  element: partial.element ?? "",
  internalType: partial.internalType ?? "string",
  extractAs: partial.extractAs ?? null,
  isJsonBlob: partial.isJsonBlob ?? false,
  isNoise: partial.isNoise ?? false,
  isDenied: partial.isDenied ?? false,
  reference: partial.reference ?? null,
  maxLength: partial.maxLength ?? null,
});

const table = (
  name: string,
  fields: Array<Partial<FieldDescriptor>>
): TableCatalogEntry => ({
  name,
  sysId: "00000000000000000000000000000000",
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: null,
  maxUpdatedOn: null,
  fields: fields.map(field),
  status: "included",
});

describe("wire value forms", () => {
  it("unwraps a reference cell to the referenced sys_id", () => {
    // M7: the Table API returns `{ link, value }` unless the caller sets
    // sysparm_exclude_reference_link. `String({…})` on that object is
    // "[object Object]" — a value that looks like data and is wrong.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        assigned_to: {
          link: "https://example.service-now.com/api/now/table/sys_user/cc11",
          value: "cc11000000000000000000000000dd22",
        },
      },
      table("incident", [{ element: "assigned_to", reference: "sys_user" }])
    );

    expect(record.recordJsonValue.assigned_to).toBe(
      "cc11000000000000000000000000dd22"
    );
  });

  it("drops a cell whose object form carries no usable string", () => {
    // An empty reference arrives as `{ link: …, value: "" }`, and a display-value
    // shape can arrive with no `value` at all. Neither has a string form worth
    // writing, and inventing one would put a fabricated key in git forever.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        empty_ref: { link: "https://example.service-now.com/x", value: "" },
        odd_shape: { display_value: "Something" },
        list_shape: ["a", "b"],
      },
      table("incident", [])
    );

    expect(Object.keys(record.recordJsonValue)).toEqual(["sys_id"]);
  });

  it("renders non-string scalars and drops null", () => {
    // A typed client can hand back real booleans and numbers rather than the
    // Table API's string rendering. Accept both rather than depend on the wire
    // form; `null` has no value to write and is dropped like an empty string.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        active: true,
        order: 50,
        closed_at: null,
      },
      table("incident", [])
    );

    expect(record.recordJsonValue).toEqual({
      active: "true",
      order: "50",
      sys_id: "aa00000000000000000000000000bb00",
    });
  });
});

describe("catalog handling", () => {
  it("resolves a duplicated column to the catalog's first descriptor", () => {
    // D21 has the catalog union a table's own dictionary rows with every
    // inherited row, so a child redeclaring a parent column produces two
    // descriptors. Precedence is the catalog's decision, expressed as ordering;
    // the serializer only promises to honour it deterministically.
    const record = serializeRow(
      { sys_id: "aa00000000000000000000000000bb00", script: "var x = 1;" },
      table("sys_script_include", [
        { element: "script", internalType: "script", extractAs: "js" },
        { element: "script", internalType: "string", extractAs: null },
      ])
    );

    expect(record.extractedFiles).toEqual([
      { fileName: "script.js", contents: "var x = 1;\n" },
    ]);
    expect(record.recordJsonValue.script).toBeUndefined();
  });

  it("keeps a blob whose parsed value is the empty string", () => {
    // Rule 2 drops empty CELLS, and "empty" is a property of the wire text (M8:
    // the Table API returns every column, absent ones as ""). The two characters
    // `""` are not an empty cell — they are a non-empty cell holding the JSON
    // document for the empty string, and its parsed value is data. Dropping it
    // here would also contradict what happens one level down, where an empty
    // string inside a blob object is obviously kept: the serializer does not
    // edit the contents of a blob.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        cache: '""',
        nested: '{"a":"","b":"x"}',
        absent: "",
      },
      table("u_widget", [
        { element: "cache", isJsonBlob: true },
        { element: "nested", isJsonBlob: true },
        { element: "absent", isJsonBlob: true },
      ])
    );

    expect(record.recordJsonValue.cache).toBe("");
    expect(record.recordJsonValue.nested).toEqual({ a: "", b: "x" });
    expect(record.recordJsonValue.absent).toBeUndefined();
    expect(record.parseFailures).toEqual([]);
  });

  it("suppresses a column only when the descriptor says so", () => {
    // D7 requires every active suppression to be enumerable in the run report,
    // which is only true while the descriptor is the sole source of the decision.
    // A column that merely LOOKS like noise is kept.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        sys_mod_count: "17",
        password_like: "still-written",
      },
      table("incident", [{ element: "password_like" }])
    );

    expect(record.recordJsonValue).toEqual({
      password_like: "still-written",
      sys_id: "aa00000000000000000000000000bb00",
      sys_mod_count: "17",
    });
  });
});

describe("Unicode: names are normalized, contents are not", () => {
  // Both forms are written as escapes throughout this block. They are
  // indistinguishable in an editor, so a literal would make the test
  // unreviewable — and reviewability is the whole point of pinning D18.
  const DECOMPOSED_E_ACUTE = "\u0065\u0301";
  const COMPOSED_E_ACUTE = "\u00e9";

  it("normalizes an extracted file name to NFC (D18)", () => {
    // macOS hands out decomposed names while Linux and git store what they are
    // given, so an unnormalized name makes the same record produce two different
    // paths on two developers' machines. Normalizing where the name is minted is
    // what keeps the rule cheap.
    const element = `u_caf${DECOMPOSED_E_ACUTE}_note`;
    const expectedName = `u_caf${COMPOSED_E_ACUTE}_note.txt`;
    expect(`${element}.txt`).not.toBe(expectedName);

    const record = serializeRow(
      { sys_id: "aa00000000000000000000000000bb00", [element]: "x" },
      table("u_widget", [{ element, extractAs: "txt" }])
    );

    expect(record.extractedFiles[0]?.fileName).toBe(expectedName);
  });

  it("leaves decomposed sequences inside content untouched", () => {
    // The mirror records what the instance has. Normalizing content would make
    // the tree differ from the instance and would silently rewrite the bytes of
    // every script that happens to contain a decomposed identifier.
    const script = `var caf${DECOMPOSED_E_ACUTE} = 1;`;
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        script,
        short_description: `caf${DECOMPOSED_E_ACUTE}`,
      },
      table("u_widget", [
        { element: "script", internalType: "script", extractAs: "js" },
        { element: "short_description" },
      ])
    );

    expect(record.extractedFiles[0]?.contents).toBe(`${script}\n`);
    expect(record.recordJsonValue.short_description).toBe(
      `caf${DECOMPOSED_E_ACUTE}`
    );
  });

  it("surfaces both files when NFC collapses two column names into one (F9)", () => {
    // Two columns that differ only by normalization form produce ONE file name.
    // The serializer reports both entries rather than silently dropping one or
    // quietly renaming: F9 is a real failure with a defined handling, and the
    // Writer is the stage that owns it (it is the only stage that can see the
    // whole target directory). A silent drop here would be exactly the kind of
    // invisible data loss R3 forbids.
    const decomposed = `u_caf${DECOMPOSED_E_ACUTE}_note`;
    const composed = `u_caf${COMPOSED_E_ACUTE}_note`;
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        [decomposed]: "first",
        [composed]: "second",
      },
      table("u_widget", [
        { element: decomposed, extractAs: "txt" },
        { element: composed, extractAs: "txt" },
      ])
    );

    expect(record.extractedFiles.map((file) => file.fileName)).toEqual([
      `${composed}.txt`,
      `${composed}.txt`,
    ]);
    expect(record.extractedFiles.map((file) => file.contents).sort()).toEqual([
      "first\n",
      "second\n",
    ]);
  });

  it("escapes a lone surrogate rather than encoding it as U+FFFD", () => {
    // A lone surrogate has no UTF-8 encoding; TextEncoder substitutes U+FFFD,
    // which would silently corrupt the value. JSON.stringify emits it as a
    // \uXXXX escape (well-formed JSON.stringify, ES2019), so the envelope
    // survives the round trip as pure ASCII. Extracted files have no such
    // protection — flagged for the Writer, which owns their encoding.
    const text = canonicalJsonText({ broken: "\ud800" });
    expect(text).toContain("\\ud800");
    expect(Buffer.from(encodeUtf8(text)).toString("utf8")).toBe(text);
  });
});

describe("hostile and degenerate input", () => {
  it("keeps __proto__ as data instead of polluting a prototype", () => {
    // JSON.parse produces `__proto__` as an ordinary own data property. Copying
    // it onto a normal object would hit the inherited setter, which either
    // swallows the value (data loss) or changes the prototype (pollution) — on
    // content we do not control.
    const row = JSON.parse(
      '{"sys_id":"aa00000000000000000000000000bb00","cache":"{\\"__proto__\\":{\\"polluted\\":true},\\"a\\":1}"}'
    ) as Record<string, unknown>;

    const record = serializeRow(
      row,
      table("u_widget", [{ element: "cache", isJsonBlob: true }])
    );

    expect(canonicalJsonText(record.recordJsonValue)).toContain('"__proto__"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(record.parseFailures).toEqual([]);
  });

  it("falls back to raw: when a blob is too deeply nested to canonicalize", () => {
    // T4: the content is untrusted. Valid-but-pathological JSON can overflow the
    // stack in the walk or in JSON.stringify, and that must land in the same
    // honest fallback as "not JSON at all" — a hostile record may not crash the
    // run.
    const depth = 120_000;
    const bomb = "[".repeat(depth) + "]".repeat(depth);
    const record = serializeRow(
      { sys_id: "aa00000000000000000000000000bb00", cache: bomb },
      table("u_widget", [
        { element: "cache", isJsonBlob: true, extractAs: "json" },
      ])
    );

    expect(record.parseFailures).toEqual(["cache"]);
    expect(record.extractedFiles).toEqual([]);
    expect(record.recordJsonValue.cache).toBe(`raw:${bomb}`);
  });

  it("orders keys by code unit even when none of them is an array index", () => {
    // The upper edge of the array-index range: 4294967295 is one past the last
    // index, so JavaScript treats it as an ordinary string key and insertion
    // order already is code-unit order. The fast path must handle it.
    const record = serializeRow(
      {
        sys_id: "aa00000000000000000000000000bb00",
        cache: '{"4294967295":"top","1e3":"exp","x":"plain"}',
      },
      table("u_widget", [{ element: "cache", isJsonBlob: true }])
    );

    expect(canonicalJsonText(record.recordJsonValue)).toBe(
      [
        "{",
        '  "cache": {',
        '    "1e3": "exp",',
        '    "4294967295": "top",',
        '    "x": "plain"',
        "  },",
        '  "sys_id": "aa00000000000000000000000000bb00"',
        "}",
        "",
      ].join("\n")
    );
  });

  it("refuses to render a value JSON.stringify cannot represent", () => {
    // JSON.stringify answers `undefined` — not a string — for undefined,
    // functions and symbols. Interpolating that would write the six characters
    // "undefined" into the mirror as if they were data.
    expect(() => canonicalJsonText(undefined)).toThrow(TypeError);
    expect(() => canonicalJsonBytes(() => "nope")).toThrow(/JSON-serializable/);
  });
});

describe("trailing newline normalization", () => {
  it("appends exactly one newline and never a second", () => {
    expect(withTrailingNewline("a")).toBe("a\n");
    expect(withTrailingNewline("a\n")).toBe("a\n");
    // Two newlines already present are CONTENT, not formatting: the instance has
    // a blank last line and the mirror records what the instance has.
    expect(withTrailingNewline("a\n\n")).toBe("a\n\n");
    expect(withTrailingNewline("")).toBe("\n");
  });

  it("leaves interior CRLF alone", () => {
    // M18 measured that scripts arrive LF-only, so a CRLF that does show up is
    // real content — rewriting it would make the mirror disagree with the
    // instance and would produce a one-off whole-file diff the first time.
    expect(withTrailingNewline("a\r\nb")).toBe("a\r\nb\n");
  });
});

describe("canonical byte helpers", () => {
  it("encodes UTF-8 without a BOM", () => {
    expect(Array.from(encodeUtf8("\u00e9"))).toEqual([0xc3, 0xa9]);
    expect(Array.from(canonicalJsonBytes({}))).toEqual([0x7b, 0x7d, 0x0a]);
  });

  it("sorts nested keys inside arrays too", () => {
    // §8 says "every nesting level", and an object inside an array is a nesting
    // level. Arrays themselves keep their order: they are ordered data.
    expect(canonicalJsonText([{ b: 1, a: 2 }, "z"])).toBe(
      '[\n  {\n    "a": 2,\n    "b": 1\n  },\n  "z"\n]\n'
    );
  });
});
