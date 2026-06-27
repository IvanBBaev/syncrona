// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Atlassian Document Format (ADF) → plain text.
 *
 * Jira Cloud (REST v3) returns rich-text fields (description, comment bodies) as
 * an ADF JSON document tree rather than a string. Jira Server/Data Center (v2)
 * returns plain text or wiki markup as a string. This module flattens an ADF
 * document to readable plain text; non-object (already-string) inputs are passed
 * through unchanged so the same code path handles both deployments.
 *
 * It is intentionally lossy and pure: we want the model and the developer to read
 * the intent, not to faithfully reconstruct formatting. Block nodes are separated
 * by blank lines, list items are bulleted/numbered, and inline marks are dropped.
 */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
};

function renderInline(nodes: AdfNode[] | undefined): string {
  if (!Array.isArray(nodes)) {
    return "";
  }
  return nodes.map((node) => renderNode(node)).join("");
}

function renderList(node: AdfNode, ordered: boolean): string {
  const items = Array.isArray(node.content) ? node.content : [];
  return items
    .map((item, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const inner = renderInline(item.content).trim();
      return `${marker}${inner}`;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function renderNode(node: AdfNode | undefined): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
      return renderInline(node.content);
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "listItem":
      return renderInline(node.content);
    case "codeBlock":
      return renderInline(node.content);
    case "blockquote":
      return renderInline(node.content);
    case "mention":
      return typeof node.attrs?.text === "string" ? String(node.attrs.text) : "";
    case "emoji":
      return typeof node.attrs?.shortName === "string"
        ? String(node.attrs.shortName)
        : "";
    case "rule":
      return "";
    default:
      // Unknown block/inline node — recurse so its text content is not lost.
      return renderInline(node.content);
  }
}

/**
 * Convert an ADF document (or a plain string) to plain text. Block-level nodes at
 * the document root are joined by blank lines; the result is trimmed.
 */
export function adfToText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const doc = value as AdfNode;
  const blocks = Array.isArray(doc.content) ? doc.content : [];
  if (blocks.length === 0) {
    // A bare node (not a full document) — render it directly.
    return renderNode(doc).trim();
  }

  return blocks
    .map((block) => renderNode(block))
    .map((text) => text.replace(/[ \t]+\n/g, "\n").trimEnd())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}
