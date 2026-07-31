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

// ---------------------------------------------------------------------------
// The code fence — the one construct in this renderer that can be broken out of.
//
// adf.test.ts pins REV-202 by example: content holding ``` gets a longer fence.
// What an example cannot state is the actual security contract, which is not
// "the fence is longer" but "no character of the untrusted content is ever read
// as document structure". So instead of asserting on the emitted string, the
// property below runs a CommonMark fenced-code scanner over the rendered output
// and asserts on what a *consumer* sees: exactly one closed code region, its
// content byte-identical to the input (modulo the renderer's declared
// trailing-whitespace normalization), and nothing outside it but the two
// paragraphs the document really contained.
// ---------------------------------------------------------------------------

type FenceRegion = { fenceLength: number; info: string; lines: string[]; closed: boolean };

/**
 * Split text into fenced-code regions and the lines outside them, following the
 * CommonMark rules the renderer relies on: an opener is up to three spaces of
 * indent, a run of >= 3 backticks and an info string with no backtick in it; only
 * a run at least as long as the opener, alone on its line, closes it.
 */
function scanFences(text: string): { regions: FenceRegion[]; outside: string[] } {
  const regions: FenceRegion[] = [];
  const outside: string[] = [];
  let open: FenceRegion | null = null;
  for (const line of text.split("\n")) {
    if (open) {
      const closer = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
      if (closer && closer[1].length >= open.fenceLength) {
        open.closed = true;
        regions.push(open);
        open = null;
        continue;
      }
      open.lines.push(line);
      continue;
    }
    const opener = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
    if (opener) {
      open = { fenceLength: opener[1].length, info: opener[2], lines: [], closed: false };
      continue;
    }
    outside.push(line);
  }
  if (open) {
    regions.push(open);
  }
  return { regions, outside };
}

// Lines that a fixed three-backtick fence — or a naive "count only whole-line
// runs" fix — would let through: bare runs of every length around the boundary,
// runs with an info string, runs indented by the up-to-three spaces CommonMark
// still accepts, and runs buried mid-line.
const backtickRun = fc.integer({ min: 1, max: 6 }).map((n) => "`".repeat(n));
const fenceLikeLine = fc.oneof(
  backtickRun,
  backtickRun.map((run) => `${run}js`),
  backtickRun.map((run) => `   ${run}`),
  backtickRun.map((run) => `${run}  `),
  backtickRun.map((run) => `text ${run} text`),
  fc.constantFrom(
    "```",
    "````",
    "`````",
    "~~~",
    "   ~~~",
    "",
    " ",
    "\t",
    "plain line",
    "``` ```"
  )
);

const codeContent = fc
  .array(
    fc.oneof({ arbitrary: fenceLikeLine, weight: 4 }, { arbitrary: fc.string({ maxLength: 12 }), weight: 1 }),
    { maxLength: 6 }
  )
  .map((lines) => lines.join("\n"));

// The info string is the second half of REV-202: a language carrying a backtick or
// a newline broke the opener itself.
const languageAttr = fc.oneof(
  fc.constantFrom(
    "js",
    "ts",
    "c++",
    "c#",
    "shell_session",
    "asp.net",
    "",
    "js`",
    "js\n```\nescaped",
    "  js",
    "js x",
    "`",
    "\n",
    "a".repeat(40)
  ),
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.constant(undefined)
);

/**
 * What the code content must look like coming back out. The renderer declares one
 * transformation of a root block — `[ \t]+\n` collapses and the block is
 * right-trimmed — so trailing whitespace on a code line, and at the very end of
 * the content, is expected to be gone. Everything else must survive byte for byte.
 */
function normalizedCode(code: string): string {
  return `${code}\n`.replace(/[ \t]+\n/g, "\n").slice(0, -1);
}

describe("adfToText code fence (property, REV-202)", () => {
  const render = (code: string, language: unknown): string =>
    adfToText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "BEFORE" }] },
        {
          type: "codeBlock",
          attrs: language === undefined ? {} : { language },
          content: [{ type: "text", text: code }],
        },
        { type: "paragraph", content: [{ type: "text", text: "AFTER" }] },
      ],
    });

  it("never lets code-block content escape the fence into document structure", () => {
    fc.assert(
      fc.property(codeContent, languageAttr, (code, language) => {
        const { regions, outside } = scanFences(render(code, language));
        // Exactly one region, properly closed: an unclosed or a second region both
        // mean the content terminated the fence and the rest of it is now prose.
        expect(regions).toHaveLength(1);
        expect(regions[0].closed).toBe(true);
        // And the only lines a consumer reads as document text are the two
        // paragraphs that really were document text.
        expect(outside.filter((line) => line.length > 0)).toEqual(["BEFORE", "AFTER"]);
      }),
      { numRuns: 3000 }
    );
  });

  it("preserves the code content exactly, up to the declared trailing-whitespace trim", () => {
    // The fence must be widened, never the content edited: a renderer that escaped
    // or stripped the backticks would satisfy the property above while corrupting
    // every script an agent is asked to read.
    fc.assert(
      fc.property(codeContent, languageAttr, (code, language) => {
        const { regions } = scanFences(render(code, language));
        expect(regions[0].lines.join("\n")).toBe(normalizedCode(code));
      }),
      { numRuns: 3000 }
    );
  });

  it("emits an info string that is either empty or a real language identifier", () => {
    const SAFE_CODE_LANGUAGE = /^[A-Za-z0-9+#._-]{1,32}$/;
    fc.assert(
      fc.property(codeContent, languageAttr, (code, language) => {
        const { regions } = scanFences(render(code, language));
        const info = regions[0].info;
        expect(info === "" || SAFE_CODE_LANGUAGE.test(info)).toBe(true);
        // Round-trip: a legitimate language must not be dropped, so the drop rule
        // cannot degenerate into "always emit nothing".
        if (typeof language === "string" && SAFE_CODE_LANGUAGE.test(language)) {
          expect(info).toBe(language);
        }
      }),
      { numRuns: 2000 }
    );
  });

  it("keeps holding when the fenced block is nested inside a list item", () => {
    // renderCodeBlock's output is re-joined by its parents, so the fence has to
    // survive being embedded, not just being a root block. A list item hangs its
    // continuation lines under the marker, which is a list *container* — the fence
    // and its content are then read relative to the item's content column. The
    // scanner above is flat, so undo that one container (drop the marker and the
    // matching pad) first; without it the scanner reports the renderer's correct
    // output as broken, which is how this test was first written and how
    // fast-check caught it, shrinking to the empty code block { seed: -1451706671,
    // path: "0:0" } where "- ```" is not an opener to a flat scanner but "  ```"
    // is.
    const undoListContainer = (rendered: string): string =>
      rendered
        .split("\n")
        .map((line) => (line.startsWith("- ") || line.startsWith("  ") ? line.slice(2) : line))
        .join("\n");

    fc.assert(
      fc.property(codeContent, (code) => {
        const rendered = adfToText({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "BEFORE" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "codeBlock", content: [{ type: "text", text: code }] }],
                },
              ],
            },
            { type: "paragraph", content: [{ type: "text", text: "AFTER" }] },
          ],
        });
        const { regions, outside } = scanFences(undoListContainer(rendered));
        expect(regions).toHaveLength(1);
        expect(regions[0].closed).toBe(true);
        expect(regions[0].lines.join("\n")).toBe(normalizedCode(code));
        expect(outside.filter((line) => line.length > 0)).toEqual(["BEFORE", "AFTER"]);
      }),
      { numRuns: 1500 }
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
