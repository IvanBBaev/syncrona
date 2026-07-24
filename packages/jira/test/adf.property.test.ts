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
      // Children are not always well-formed nodes: a malformed document can hold
      // null/undefined or a bare scalar where a node belongs, so generate those
      // too — a node-only generator cannot reach the unvalidated-child paths.
      content: fc.oneof(
        fc.constant(undefined),
        fc.array(
          fc.oneof(
            tie("node"),
            fc.constant(null),
            fc.constant(undefined),
            fc.string(),
            fc.integer()
          ),
          { maxLength: 4 }
        )
      ),
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

// List items, table rows and table cells are the paths that read a child's
// `.content` without validating the child first, so a null/undefined item, row
// or cell used to abort the whole issue fetch with a TypeError. These pin the
// never-throws contract on each of those sinks directly.
describe("adfToText malformed list/table children (never throws)", () => {
  const cases: Array<[string, unknown]> = [
    ["a null bullet-list item", { type: "bulletList", content: [null] }],
    ["an undefined bullet-list item", { type: "bulletList", content: [undefined] }],
    ["a null ordered-list item", { type: "orderedList", content: [null] }],
    ["a null table row", { type: "table", content: [null] }],
    [
      "a null table cell",
      { type: "table", content: [{ type: "tableRow", content: [null] }] },
    ],
    [
      "a null nested-list item",
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "bulletList", content: [null] }],
          },
        ],
      },
    ],
  ];

  it.each(cases)("returns a string for %s", (_label, block) => {
    const doc = { type: "doc", content: [block] };
    expect(() => adfToText(doc)).not.toThrow();
    expect(typeof adfToText(doc)).toBe("string");
  });

  it("drops a malformed table row or cell rather than throwing", () => {
    expect(adfToText({ type: "doc", content: [{ type: "table", content: [null] }] })).toBe("");
    expect(
      adfToText({
        type: "doc",
        content: [{ type: "table", content: [{ type: "tableRow", content: [null] }] }],
      })
    ).toBe("");
  });

  it("still renders the well-formed siblings of a malformed item", () => {
    // The guard must skip only the broken child, not abandon the whole list.
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            null,
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "kept" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toContain("kept");
  });
});

// The property generators above use fc.integer() (|value| < 2.1e9, always a
// valid Date) and fc.string() (parses to NaN), so neither reaches a finite but
// out-of-range timestamp. That is exactly the value that makes
// `new Date(ms).toISOString()` throw RangeError, so it needs a targeted case.
describe("adfToText date node (out-of-range timestamp)", () => {
  const dateNode = (timestamp: unknown) => ({
    type: "doc",
    content: [{ type: "date", attrs: { timestamp } }],
  });

  it("renders an in-range timestamp as an ISO date", () => {
    // 2021-01-01T00:00:00Z
    expect(adfToText(dateNode(1609459200000))).toBe("2021-01-01");
    expect(adfToText(dateNode("1609459200000"))).toBe("2021-01-01");
  });

  it("degrades to empty text for an out-of-range numeric-string timestamp", () => {
    expect(adfToText(dateNode("99999999999999999"))).toBe("");
  });

  it("degrades to empty text for an out-of-range numeric timestamp", () => {
    expect(adfToText(dateNode(1e18))).toBe("");
    expect(adfToText(dateNode(-1e18))).toBe("");
  });
});
