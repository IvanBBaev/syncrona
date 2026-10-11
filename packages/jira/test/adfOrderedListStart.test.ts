// SPDX-License-Identifier: GPL-3.0-or-later
import { adfToText } from "../src/adf";

function orderedList(attrs: Record<string, unknown> | undefined, ...texts: string[]): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "orderedList",
        ...(attrs ? { attrs } : {}),
        content: texts.map((text) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      },
    ],
  };
}

describe("adfToText ordered list start", () => {
  it("starts numbering at attrs.order", () => {
    expect(adfToText(orderedList({ order: 3 }, "c", "d"))).toBe("3. c\n4. d");
  });

  it("accepts a start of 0", () => {
    expect(adfToText(orderedList({ order: 0 }, "a", "b"))).toBe("0. a\n1. b");
  });

  it("falls back to 1 for a missing or unusable order", () => {
    for (const attrs of [undefined, { order: -2 }, { order: 1.5 }, { order: "5" }]) {
      expect(adfToText(orderedList(attrs, "a", "b"))).toBe("1. a\n2. b");
    }
  });
});
