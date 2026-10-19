// SPDX-License-Identifier: GPL-3.0-or-later
import { adfToText } from "../src/adf";

function paragraph(...content: unknown[]): unknown {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

describe("adfToText link marks", () => {
  it("keeps the URL of linked text", () => {
    const doc = paragraph(
      { type: "text", text: "See " },
      {
        type: "text",
        text: "the runbook",
        marks: [{ type: "strong" }, { type: "link", attrs: { href: "https://wiki.acme.com/rb" } }],
      },
      { type: "text", text: "." }
    );
    expect(adfToText(doc)).toBe("See the runbook (https://wiki.acme.com/rb).");
  });

  it("does not repeat a URL whose text already is the URL", () => {
    const url = "https://wiki.acme.com/rb";
    const doc = paragraph({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] });
    expect(adfToText(doc)).toBe(url);
  });

  it("ignores a link mark without a usable string href", () => {
    const doc = paragraph(
      { type: "text", text: "a", marks: [{ type: "link", attrs: { href: 42 } }] },
      { type: "text", text: "b", marks: [{ type: "link" }, null] }
    );
    expect(adfToText(doc)).toBe("ab");
  });
});
