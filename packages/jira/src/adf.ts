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

/**
 * Hard cap on block-nesting recursion. ADF from Jira is acyclic and shallow, but
 * a hand-crafted or corrupted document could nest deeply enough to overflow the
 * stack; past this depth we stop descending and drop the remaining sub-tree. Set
 * far above any realistic Jira nesting so normal documents are never truncated.
 */
const MAX_DEPTH = 100;

/**
 * Largest absolute epoch-millis value `new Date(ms).toISOString()` accepts before
 * it throws `RangeError: Invalid time value` (the ECMAScript maximum date, ±100
 * million days from the epoch). A crafted ADF `date` node can carry a finite but
 * out-of-range `timestamp`, so we range-check before formatting.
 */
const MAX_TIMESTAMP_MS = 8.64e15;

/** Read a string attr, returning "" when absent or not a string. */
function attrString(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Render an ADF node whose payload lives entirely in `attrs` (no `content`) —
 * `inlineCard`/`blockCard` (pasted links), `status` (lozenge), `date`, and the
 * `media`/`mediaInline` attachment nodes. These would otherwise flatten to the
 * empty string and silently drop their text (finding #37). Returns null when the
 * node is not one of these attrs-only kinds so the caller can fall through.
 */
function renderAttrsOnlyNode(node: AdfNode): string | null {
  switch (node.type) {
    case "inlineCard":
    case "blockCard":
      // A pasted URL: `attrs.url`, or a resolved smart-link `attrs.data.url`.
      return attrString(node, "url") || dataUrl(node) || "";
    case "status":
      // A status lozenge, e.g. "IN PROGRESS": the label lives in `attrs.text`.
      return attrString(node, "text");
    case "date": {
      // A date pill: `attrs.timestamp` is epoch millis (string or number).
      const ts = node.attrs?.timestamp;
      const millis =
        typeof ts === "number"
          ? ts
          : typeof ts === "string" && ts.trim()
            ? Number(ts)
            : NaN;
      // A finite but out-of-range value would make `.toISOString()` throw
      // RangeError and abort the whole issue fetch, so degrade to "" like every
      // other bad input rather than break the module's never-throws contract.
      if (Number.isFinite(millis) && Math.abs(millis) <= MAX_TIMESTAMP_MS) {
        return new Date(millis).toISOString().slice(0, 10);
      }
      return "";
    }
    case "media":
    case "mediaInline": {
      // An attachment: no readable text, so emit a placeholder naming it when a
      // filename (`attrs.alt`) is present, otherwise a generic marker.
      const alt = attrString(node, "alt");
      return alt ? `[attachment: ${alt}]` : "[attachment]";
    }
    default:
      return null;
  }
}

/** Extract a URL from a smart-link's resolved `attrs.data.url`, if present. */
function dataUrl(node: AdfNode): string {
  const data = node.attrs?.data;
  if (data && typeof data === "object") {
    const url = (data as Record<string, unknown>).url;
    if (typeof url === "string") {
      return url;
    }
  }
  return "";
}

/** Inline nodes that compose a single line of text (no block separators). */
function renderInline(nodes: AdfNode[] | undefined, depth = 0): string {
  if (!Array.isArray(nodes)) {
    return "";
  }
  return nodes.map((node) => renderInlineNode(node, depth)).join("");
}

function renderInlineNode(node: AdfNode | undefined, depth = 0): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  // Inline path has its own recursion bound: the default case below flattens an
  // unknown node's children back through renderInline, so a hand-crafted deeply
  // nested inline tree could overflow the stack just like the block path. Stop
  // descending past MAX_DEPTH and drop the remaining sub-tree.
  if (depth > MAX_DEPTH) {
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
    default: {
      // Attrs-only inline nodes (inlineCard/status/date/media) carry their text
      // in `attrs` with no `content` — render that before falling through.
      const attrsText = renderAttrsOnlyNode(node);
      if (attrsText !== null) {
        return attrsText;
      }
      // Unknown inline node (or a stray block in inline position) — flatten its
      // text so nothing is dropped, joining inline so the line is not broken.
      return renderInline(node.content, depth + 1);
    }
  }
}

/** Render the block children of a node, joining them with single newlines. */
function renderBlockChildren(node: AdfNode, depth: number): string {
  const children = Array.isArray(node.content) ? node.content : [];
  return children
    .map((child) => renderBlock(child, depth))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Render one list item. A listItem holds *block* children (paragraphs, nested
 * lists), so render each as a block and hang them under the marker, indenting the
 * continuation lines to line up beneath the first.
 */
function renderListItem(item: AdfNode, marker: string, depth: number): string {
  const body = renderBlockChildren(item, depth);
  const lines = body.split("\n");
  const first = lines.shift() ?? "";
  const pad = " ".repeat(marker.length);
  const rest = lines.map((line) => (line.length > 0 ? pad + line : line));
  return [`${marker}${first}`, ...rest].join("\n");
}

function renderList(node: AdfNode, ordered: boolean, depth: number): string {
  const items = Array.isArray(node.content) ? node.content : [];
  return items
    .map((item, index) =>
      renderListItem(item, ordered ? `${index + 1}. ` : "- ", depth)
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
function renderTableCell(cell: AdfNode, depth: number): string {
  return renderBlockChildren(cell, depth).split("\n").join(" ").trim();
}

function renderTableRow(row: AdfNode, depth: number): string {
  const cells = Array.isArray(row.content) ? row.content : [];
  return cells.map((cell) => renderTableCell(cell, depth)).join(" | ");
}

function renderTable(node: AdfNode, depth: number): string {
  const rows = Array.isArray(node.content) ? node.content : [];
  return rows
    .map((row) => renderTableRow(row, depth))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Render a block-level node to (possibly multi-line) text. */
function renderBlock(node: AdfNode | undefined, depth: number): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  // Defensive bound: stop descending into pathologically deep trees so the
  // converter degrades gracefully (drops the sub-tree) instead of overflowing.
  if (depth > MAX_DEPTH) {
    return "";
  }
  const next = depth + 1;

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
      return renderList(node, false, next);
    case "orderedList":
      return renderList(node, true, next);
    case "listItem":
      // Normally reached via renderListItem; handle a direct call too.
      return renderBlockChildren(node, next);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return renderBlockChildren(node, next);
    case "table":
      return renderTable(node, next);
    case "rule":
      return "";
    default: {
      // Attrs-only nodes (blockCard, or a bare status/date/media at block level)
      // carry their text in `attrs` with no `content`; render that first so it is
      // not lost to the empty-children recursion below.
      const attrsText = renderAttrsOnlyNode(node);
      if (attrsText !== null && attrsText.length > 0) {
        return attrsText;
      }
      // Unknown block/inline node — recurse over its block children so text is
      // not lost (e.g. panel, expand, mediaSingle/mediaGroup wrapping media).
      return renderBlockChildren(node, next);
    }
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
    return renderBlock(doc, 0).trim();
  }

  return blocks
    .map((block) => renderBlock(block, 0))
    .map((text) => text.replace(/[ \t]+\n/g, "\n").trimEnd())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}
