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
 * by blank lines, list items render their full block content (multi-paragraph and
 * nested lists included), tables collapse to ` | `-joined rows, code blocks are
 * fenced, and inline marks are dropped.
 */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Inline nodes that compose a single line of text (no block separators). */
function renderInline(nodes: AdfNode[] | undefined): string {
  if (!Array.isArray(nodes)) {
    return "";
  }
  return nodes.map((node) => renderInlineNode(node)).join("");
}

function renderInlineNode(node: AdfNode | undefined): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return "\n";
    case "mention":
      return typeof node.attrs?.text === "string" ? String(node.attrs.text) : "";
    case "emoji":
      return typeof node.attrs?.shortName === "string"
        ? String(node.attrs.shortName)
        : "";
    default:
      // Unknown inline node (or a stray block in inline position) — flatten its
      // text so nothing is dropped, joining inline so the line is not broken.
      return renderInline(node.content);
  }
}

/** Render the block children of a node, joining them with single newlines. */
function renderBlockChildren(node: AdfNode): string {
  const children = Array.isArray(node.content) ? node.content : [];
  return children
    .map((child) => renderBlock(child))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Render one list item. A listItem holds *block* children (paragraphs, nested
 * lists), so render each as a block and hang them under the marker, indenting the
 * continuation lines to line up beneath the first.
 */
function renderListItem(item: AdfNode, marker: string): string {
  const body = renderBlockChildren(item);
  const lines = body.split("\n");
  const first = lines.shift() ?? "";
  const pad = " ".repeat(marker.length);
  const rest = lines.map((line) => (line.length > 0 ? pad + line : line));
  return [`${marker}${first}`, ...rest].join("\n");
}

function renderList(node: AdfNode, ordered: boolean): string {
  const items = Array.isArray(node.content) ? node.content : [];
  return items
    .map((item, index) =>
      renderListItem(item, ordered ? `${index + 1}. ` : "- ")
    )
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/** Fence a code block, preserving its (already newline-bearing) text content. */
function renderCodeBlock(node: AdfNode): string {
  const code = renderInline(node.content);
  const language =
    typeof node.attrs?.language === "string" ? node.attrs.language : "";
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** Collapse a table cell's block content to a single ` `-joined line. */
function renderTableCell(cell: AdfNode): string {
  return renderBlockChildren(cell).split("\n").join(" ").trim();
}

function renderTableRow(row: AdfNode): string {
  const cells = Array.isArray(row.content) ? row.content : [];
  return cells.map((cell) => renderTableCell(cell)).join(" | ");
}

function renderTable(node: AdfNode): string {
  const rows = Array.isArray(node.content) ? node.content : [];
  return rows
    .map((row) => renderTableRow(row))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Render a block-level node to (possibly multi-line) text. */
function renderBlock(node: AdfNode | undefined): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  switch (node.type) {
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
      // Inline node encountered at block level — render it inline.
      return renderInlineNode(node);
    case "paragraph":
    case "heading":
      return renderInline(node.content);
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "listItem":
      // Normally reached via renderListItem; handle a direct call too.
      return renderBlockChildren(node);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return renderBlockChildren(node);
    case "table":
      return renderTable(node);
    case "rule":
      return "";
    default:
      // Unknown block/inline node — recurse over its block children so text is
      // not lost (e.g. panel, expand, mediaSingle wrapping a paragraph).
      return renderBlockChildren(node);
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
    return renderBlock(doc).trim();
  }

  return blocks
    .map((block) => renderBlock(block))
    .map((text) => text.replace(/[ \t]+\n/g, "\n").trimEnd())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}
