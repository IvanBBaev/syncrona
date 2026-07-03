// SPDX-License-Identifier: GPL-3.0-or-later
// #20 — property-based invariants for the pure flat-layout round-trip.
//
// flatLayout.ts documents the folder<->flat mapping as "LOSSLESS and reversible"
// and claims the record name "may contain dots". That holds — but only while
// names are separator-free ('~') AND each field file carries an extension, which
// is the documented layout (<table>/<record>/<field>.<ext>). These properties
// pin the guarantee on that realistic domain and — crucially — force the explicit
// decision on the two known collision classes ('~' in a loose name, and a dotted
// record whose field file has no extension) by asserting they exist, so nobody
// can later claim unconditional losslessness without tripping a test.
import path from "path";
import fc from "fast-check";
import { folderRelToFlat, flatRelToFolder, isFlatEncoded } from "../flatLayout";

const p = (...segs: string[]) => segs.join(path.sep);

// A path segment safe for the "lossless" domain: non-empty, no separator, no
// '~', and never the path-magic '.'/'..' that path.join would normalise away.
// Dots are allowed — the doc guarantees records/fields may contain them.
const SEG_CHARS = "abAB01._-".split("");
const safeSeg = fc
  .stringOf(fc.constantFrom(...SEG_CHARS), { minLength: 1, maxLength: 8 })
  .filter((s) => s !== "." && s !== ".." && !s.includes("~"));

// Field files carry an extension, matching the documented <field>.<ext> layout;
// this is what keeps the last dot on the field side of the '~' and preserves
// losslessness even for dotted record names.
const ext = fc.constantFrom(".js", ".ts", ".xml", ".scss", ".txt", ".json");

// A canonical record-folder file: <table...>/<record>/<field><ext>.
const folderPath = fc.record({
  table: fc.array(safeSeg, { minLength: 1, maxLength: 2 }),
  record: safeSeg,
  field: safeSeg,
  ext,
});

describe("flatLayout round-trip (property, #20)", () => {
  it("folder -> flat -> folder is the identity on the documented domain", () => {
    fc.assert(
      fc.property(folderPath, ({ table, record, field, ext: e }) => {
        const folder = p(...table, record, `${field}${e}`);
        expect(flatRelToFolder(folderRelToFlat(folder))).toBe(folder);
      })
    );
  });

  it("flat -> folder -> flat is the identity on the documented domain", () => {
    fc.assert(
      fc.property(folderPath, ({ table, record, field, ext: e }) => {
        const flat = p(...table, `${record}~${field}${e}`);
        expect(folderRelToFlat(flatRelToFolder(flat))).toBe(flat);
      })
    );
  });

  it("classifies canonical folder files as folder and flat files as flat", () => {
    fc.assert(
      fc.property(folderPath, ({ table, record, field, ext: e }) => {
        const folder = p(...table, record, `${field}${e}`);
        const flat = p(...table, `${record}~${field}${e}`);
        expect(isFlatEncoded(folder)).toBe(false);
        expect(isFlatEncoded(flat)).toBe(true);
      })
    );
  });

  it("known limitation: the '~' encoding is non-injective for loose files", () => {
    // A genuine record-folder file and a loose 2-segment file collapse to the
    // SAME flat string, and the reverse cannot tell them apart. This is why the
    // round-trip guarantee is scoped to ~-free names — pin it so the "LOSSLESS"
    // claim stays honest.
    expect(folderRelToFlat(p("t", "a", "b.js"))).toBe(p("t", "a~b.js"));
    expect(folderRelToFlat(p("t", "a~b.js"))).toBe(p("t", "a~b.js"));
    expect(flatRelToFolder(p("t", "a~b.js"))).toBe(p("t", "a", "b.js"));
  });

  it("known limitation: a dotted record with an extension-less field is not reversible", () => {
    // extname() over the flat basename treats the record's dot as the extension
    // when the field carries none, so the '~' lands in the "extension" and the
    // reverse leaves the path untouched. Lossless flat mode therefore needs the
    // documented <field>.<ext> shape when the record contains a dot.
    const folder = p("t", "a.b", "c"); // record "a.b", field "c", no extension
    expect(folderRelToFlat(folder)).toBe(p("t", "a.b~c"));
    expect(flatRelToFolder(folderRelToFlat(folder))).toBe(p("t", "a.b~c"));
    expect(flatRelToFolder(folderRelToFlat(folder))).not.toBe(folder);
  });
});
