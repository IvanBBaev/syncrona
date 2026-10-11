// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import { unsafePathComponentReason } from "./genericUtils.js";

export const DOCS_AUTO_START = "<!-- SYNCRONA:DOCS:START -->";
export const DOCS_AUTO_END = "<!-- SYNCRONA:DOCS:END -->";

/**
 * Short, human-readable descriptions for common ServiceNow tables so generated
 * docs explain what each "package" of artifacts is, not just its name.
 */
const TABLE_DESCRIPTIONS: Record<string, string> = {
  sys_script: "Business Rules — server-side logic that runs on database operations.",
  sys_script_include: "Script Includes — reusable server-side classes and functions.",
  sys_script_client: "Client Scripts — browser-side logic running on forms.",
  sys_script_fix: "Fix Scripts — one-off server-side migration/maintenance scripts.",
  sys_ui_script: "UI Scripts — reusable client-side scripts loaded into the UI.",
  sys_ui_action: "UI Actions — buttons, links, and context-menu actions on forms/lists.",
  sys_ui_page: "UI Pages — Jelly/HTML pages rendered by the platform.",
  sys_ui_macro: "UI Macros — reusable Jelly fragments embedded in pages.",
  sysevent_script_action: "Script Actions — scripts triggered by platform events.",
  sysauto_script: "Scheduled Jobs — scripts executed on a schedule.",
  sys_processor: "Processors — endpoint handlers mapped to URLs.",
  sys_rest_message: "REST Messages — outbound REST integration definitions.",
  sys_transform_map: "Transform Maps — import-set field mapping definitions.",
  sys_web_service: "Scripted Web Services — scripted SOAP/REST endpoints.",
  sys_ws_operation: "Scripted REST Operations — operations on scripted REST APIs.",
  catalog_script_client: "Catalog Client Scripts — client logic on catalog items.",
  sys_atf_test: "ATF Tests — Automated Test Framework test definitions.",
  sys_atf_step: "ATF Steps — individual steps within ATF tests.",
  sp_widget: "Service Portal Widgets — portal UI components (HTML/CSS/client/server).",
  sys_style: "Field Styles — conditional styling rules for fields.",
  sys_security_acl: "ACLs — access control rules.",
};

export interface ScopeTableSummary {
  table: string;
  description: string;
  recordCount: number;
  fileCount: number;
  records: Array<{ name: string; files: string[] }>;
}

export interface ScopeSummary {
  scope: string;
  tableCount: number;
  recordCount: number;
  fileCount: number;
  tables: ScopeTableSummary[];
}

export interface GenerateScopeDocsOptions {
  /** Directory the per-scope markdown file is written to. Default: docs/scopes */
  outDir?: string;
  /** Current date/time injected for deterministic testing. */
  now?: Date;
}

/**
 * Record, file, table and scope names come from the manifest — ultimately from
 * the instance — so they are rendered as data, never as Markdown: a `|` used to
 * split a table row, a line break ended the row, and `<`/backticks turned a name
 * into HTML or broke out of its code span.
 */
function oneLine(value: string): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ");
}

/** Escapes a name for Markdown text (outside a code span). */
function markdownText(value: string): string {
  return oneLine(value).replace(/[\\`*<>[\]]/g, "\\$&");
}

/** Wraps a name in a code span whose fence is longer than any backtick run in it. */
function inlineCode(value: string): string {
  const text = oneLine(value);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes the pipes of a rendered fragment so it stays inside one table cell. */
function tableCell(fragment: string): string {
  return fragment.replace(/\|/g, "\\|");
}

function describeTable(table: string): string {
  return TABLE_DESCRIPTIONS[table] || `Records from the ${inlineCode(table)} table.`;
}

// Plain code-unit order: localeCompare follows the process's ICU locale (under
// "da", "aa" sorts as "å"), so two machines would regenerate the doc in a
// different order and churn it in git.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Builds a deterministic, sorted summary of a downloaded scope manifest. */
export function summarizeManifest(manifest: SN.AppManifest): ScopeSummary {
  const tables: ScopeTableSummary[] = [];
  let totalRecords = 0;
  let totalFiles = 0;

  const tableNames = Object.keys(manifest.tables || {}).sort(byCodeUnit);

  for (const table of tableNames) {
    const tableConfig = manifest.tables[table];
    const recordEntries = Object.values(tableConfig.records || {});
    const records = recordEntries
      .map((record) => ({
        name: record.name,
        files: (record.files || []).map((file) => file.name).sort(byCodeUnit),
      }))
      .sort((a, b) => byCodeUnit(a.name, b.name));

    const fileCount = records.reduce((acc, record) => acc + record.files.length, 0);
    totalRecords += records.length;
    totalFiles += fileCount;

    tables.push({
      table,
      description: describeTable(table),
      recordCount: records.length,
      fileCount,
      records,
    });
  }

  return {
    scope: manifest.scope,
    tableCount: tables.length,
    recordCount: totalRecords,
    fileCount: totalFiles,
    tables,
  };
}

function sanitizeMermaidLabel(value: string): string {
  return String(value || "")
    .replace(/["\\]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Renders a Mermaid flowchart linking the scope to its tables and counts. */
export function buildScopeMermaid(summary: ScopeSummary): string {
  const lines: string[] = ["```mermaid", "flowchart LR"];
  const scopeLabel = sanitizeMermaidLabel(summary.scope) || "scope";
  lines.push(`  scope["${scopeLabel}"]`);

  summary.tables.forEach((table, index) => {
    const label = `${sanitizeMermaidLabel(table.table)}<br/>${table.recordCount} records`;
    lines.push(`  t${index}["${label}"]`);
    lines.push(`  scope --> t${index}`);
  });

  lines.push("```");
  return lines.join("\n");
}

/**
 * Builds the auto-generated documentation block (without the surrounding
 * markers) describing the scope, its tables, and per-record files.
 */
export function buildScopeDocBody(
  summary: ScopeSummary,
  now: Date = new Date()
): string {
  const out: string[] = [];
  out.push(
    `_Generated by SyncroNow AI on ${now.toISOString()}. Content inside this block is regenerated on each sync — add manual notes outside the block._`
  );
  out.push("");
  out.push("## Overview");
  out.push("");
  out.push(`- Scope: ${inlineCode(summary.scope)}`);
  out.push(`- Tables: ${summary.tableCount}`);
  out.push(`- Records: ${summary.recordCount}`);
  out.push(`- Files: ${summary.fileCount}`);
  out.push("");

  out.push("## Architecture");
  out.push("");
  out.push(buildScopeMermaid(summary));
  out.push("");

  out.push("## Tables");
  out.push("");
  if (summary.tables.length === 0) {
    out.push("_No tables were found for this scope._");
  } else {
    out.push("| Table | Description | Records | Files |");
    out.push("| --- | --- | --- | --- |");
    for (const table of summary.tables) {
      out.push(
        `| ${tableCell(inlineCode(table.table))} | ${tableCell(table.description)} | ${table.recordCount} | ${table.fileCount} |`
      );
    }
  }
  out.push("");

  for (const table of summary.tables) {
    out.push(`### ${inlineCode(table.table)}`);
    out.push("");
    out.push(table.description);
    out.push("");
    if (table.records.length === 0) {
      out.push("_No records._");
      out.push("");
      continue;
    }
    out.push("| Record | Files |");
    out.push("| --- | --- |");
    for (const record of table.records) {
      const files =
        record.files.length > 0 ? record.files.map((f) => inlineCode(f)).join(", ") : "—";
      out.push(`| ${tableCell(markdownText(record.name))} | ${tableCell(files)} |`);
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/** Wraps the auto body in the start/end markers. */
export function wrapAutoSection(body: string): string {
  return `${DOCS_AUTO_START}\n${body}\n${DOCS_AUTO_END}`;
}

/** Finds `marker` as a whole line (surrounding blanks allowed) at or after `from`. */
function findMarkerLine(
  text: string,
  marker: string,
  from: number
): { start: number; end: number } | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // In multiline mode `$` also stops before a `\r`, so CRLF files match too.
  const re = new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, "gm");
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * Performs a logical update of existing doc content:
 * - If the markers exist, only the content between them is replaced. A marker
 *   counts only on a line of its own, and the block ends at the first end marker
 *   after the start marker, so a marker quoted in manual notes or in a generated
 *   name cannot cut the block short or swallow the notes after it.
 * - If no markers exist but content is present, the auto block is appended,
 *   preserving the manual content.
 * - A start marker without an end marker after it is refused: appending would
 *   leave that orphan start to pair with the new block's end marker on the next
 *   run, replacing every manual line between them.
 * - If there is no existing content, a titled document with the block is created.
 */
export function upsertDocsSection(
  existing: string,
  scope: string,
  autoBlock: string
): string {
  const start = findMarkerLine(existing, DOCS_AUTO_START, 0);
  const end = start ? findMarkerLine(existing, DOCS_AUTO_END, start.end) : null;

  if (start && end) {
    const before = existing.slice(0, start.start);
    const after = existing.slice(end.end);
    return `${before}${autoBlock}${after}`;
  }
  if (start) {
    throw new Error(
      `the existing doc has a ${DOCS_AUTO_START} line but no ${DOCS_AUTO_END} line after it; ` +
        "put the end marker back after the generated block so the notes below it are kept."
    );
  }

  if (existing.trim().length > 0) {
    return `${existing.trimEnd()}\n\n${autoBlock}\n`;
  }

  return `# Scope: ${markdownText(scope)}\n\n${autoBlock}\n`;
}

/**
 * Generates (or logically updates) the markdown documentation for a downloaded
 * scope manifest and writes it to disk. Returns the path written.
 */
export async function generateScopeDocs(
  manifest: SN.AppManifest,
  options: GenerateScopeDocsOptions = {}
): Promise<string> {
  const outDir = options.outDir || path.join(process.cwd(), "docs", "scopes");
  const summary = summarizeManifest(manifest);
  const body = buildScopeDocBody(summary, options.now);
  const autoBlock = wrapAutoSection(body);

  // INJ-1: `summary.scope` comes from the manifest, i.e. ultimately from the
  // instance, and was interpolated straight into a filename. A scope containing
  // a separator or ".." (or an absolute path, which path.join does not stop
  // from escaping via "..") made this write a Markdown file anywhere the
  // process can reach. Validate the component, then verify the joined path
  // really stays under outDir.
  const unsafeScope = unsafePathComponentReason(summary.scope);
  if (unsafeScope) {
    throw new Error(
      `Refusing to write scope documentation: unsafe scope name ${JSON.stringify(summary.scope)}: ` +
        `${unsafeScope.reason}.`
    );
  }
  await fsp.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${summary.scope}.md`);
  const relative = path.relative(outDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to write scope documentation outside ${outDir} (resolved to ${filePath}).`
    );
  }

  let existing = "";
  try {
    existing = await fsp.readFile(filePath, "utf8");
  } catch {
    existing = "";
  }

  const next = upsertDocsSection(existing, summary.scope, autoBlock);
  await fsp.writeFile(filePath, next, "utf8");
  return filePath;
}
