// SPDX-License-Identifier: GPL-3.0-or-later
// #20 — property-based invariant for the ADF-to-text flattener.
//
// adfToText() walks untrusted Atlassian Document Format coming straight off the
// Jira API, so its one hard contract is: for ANY input it returns a string and
// never throws. These properties exercise that against arbitrary JSON, arbitrary
// (possibly malformed) ADF trees, and a document wrapper.
import fc from "fast-check";
import { adfToText } from "../src/adf";

// A recursive ADF-ish node: real node types mixed with garbage, optional and
// wrong-typed fields, arbitrary nesting — everything the flattener must survive.
const adfNode: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.record(
    {
      type: fc.constantFrom(
        "doc", "paragraph", "heading", "text", "hardBreak", "mention", "emoji",
        "bulletList", "orderedList", "listItem", "codeBlock", "blockquote",
        "table", "tableRow", "tableCell", "rule", "inlineCard", "blockCard",
        "status", "date", "media", "mediaInline", "panel", "expand", "unknownKind"
      ),
      text: fc.string(),
      attrs: fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
      content: fc.oneof(fc.constant(undefined), fc.array(tie("node"), { maxLength: 4 })),
    },
    { requiredKeys: [] }
  ),
})).node;

describe("adfToText (property, #20)", () => {
  it("returns a string and never throws for arbitrary ADF trees", () => {
    fc.assert(
      fc.property(adfNode, (node) => {
        expect(typeof adfToText(node)).toBe("string");
      }),
      { numRuns: 500 }
    );
  });

  it("returns a string and never throws for arbitrary non-ADF JSON values", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(typeof adfToText(value)).toBe("string");
      })
    );
  });

  it("survives an arbitrary document wrapper", () => {
    fc.assert(
      fc.property(fc.array(adfNode, { maxLength: 6 }), (blocks) => {
        expect(typeof adfToText({ type: "doc", content: blocks })).toBe("string");
      })
    );
  });
});
