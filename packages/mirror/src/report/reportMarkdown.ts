// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `MIRROR-REPORT.md` — the human half of the ReportGenerator (WP-M8, §5.11).
 *
 * `coverage.json` is what a script reads; this is what a person reads when they
 * open the mirror repository and ask the only question a backup has to answer:
 * what is in here, what is knowably not, and why. Both files describe the same
 * run, so this module derives the prose from the report object rather than from
 * the sweep — a renderer that took its own inputs could disagree with the JSON,
 * and two committed files disagreeing about one sweep is worse than either alone.
 *
 * **Pure by construction.** No filesystem, no clock, no `Date.now()`. Every value
 * it prints comes from the {@link CoverageReport} argument, which means the output
 * is a function of that argument and nothing else — the property that makes a
 * committed file testable at all. The bytes are written by `writeMirrorReport` in
 * `report/coverageReport.ts`, which owns the `WriterFs` seam; keeping the I/O
 * there and the rendering here is what lets the golden-text assertions run with no
 * filesystem in sight.
 *
 * **Ordering is load-bearing.** This file is COMMITTED. A `Record` iterated in
 * insertion order renders in whatever sequence the sweep happened to finish
 * tables in, so a re-run that fetched the same rows in a different order would
 * produce a different file, and every mirror commit would carry a diff nobody
 * caused (INV-1). So the renderer sorts everything it prints — table rows and
 * suppression rows alike — with {@link compareBytewise}, and does so even though
 * `buildCoverageReport` already sorted the suppressions: the renderer accepts any
 * `CoverageReport`, including one assembled by hand, and a stability guarantee
 * that depends on the caller having been careful is not a guarantee.
 *
 * **The word "snapshot" may not appear in the output.** Architecture §7 rule 1 is
 * normative: a mirror commit is an OBSERVED STATE, not a snapshot. The mirror
 * reads table by table over minutes or hours, so the tree is a union of readings
 * taken at different instants; calling it a snapshot would promise an atomic
 * point-in-time image the engine has never been able to produce, and a reader who
 * believed that promise would restore an inconsistent graph believing it whole.
 * `test/reportMarkdown.test.ts` greps the rendered output for the word so a
 * well-meaning future edit cannot reintroduce it.
 */
import type { CoverageReport, CoverageSuppression, TableCoverage } from "../contracts";
import { compareBytewise } from "../order";
import { withTrailingNewline } from "../serialize/serializer";

/** Where the rendered report lives in the mirror repository (§3). Committed. */
export const MIRROR_REPORT_REL_PATH = "MIRROR-REPORT.md";

/** Placeholder for a cell with no value, so the column never collapses. */
const EMPTY_CELL = "-";

/**
 * Render the committed human report for one sweep.
 *
 * Returns text, not bytes, and ends in exactly one newline (§8): the file is
 * diffed on every mirror commit, and a missing final newline turns every later
 * diff into a two-line change of the last line.
 */
export function renderMirrorReport(report: CoverageReport): string {
  const sections = [
    renderHeader(report),
    renderTotals(report),
    renderTables(report),
    renderSuppressions(report),
  ];
  return withTrailingNewline(sections.join("\n\n"));
}

/**
 * Title, the consistency-model caveat, and the run's identity.
 *
 * The caveat is not boilerplate. Everything a reader concludes from the rest of
 * the file depends on knowing that the rows were read at different instants, and
 * the one place they will reliably see it is above the numbers.
 */
function renderHeader(report: CoverageReport): string {
  return [
    "# Mirror report",
    "",
    "This is an **observed state** of the instance, not an instantaneous image of",
    "it: the mirror reads one table at a time, so the tree below is the union of",
    "readings taken at different moments between the two timestamps. Whether the",
    "instance held still across that span is never assumed - it is either proven",
    "by re-reading every table's row count and latest change stamp, or reported as",
    "unverified. See `Consistency` below.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Sweep | \`${escapeCell(report.sweepId)}\` |`,
    `| Mode | ${escapeCell(report.mode)} |`,
    `| Started | ${escapeCell(report.startedAt)} |`,
    `| Finished | ${escapeCell(report.finishedAt)} |`,
    `| Consistency | ${describeConsistency(report.quiescent)} |`,
    `| Exit code | ${describeExitCode(report.exitCode)} |`,
    `| Format version | ${String(report.formatVersion)} |`,
  ].join("\n");
}

/**
 * D1 in words.
 *
 * Three outcomes, three sentences, because the three are different claims and the
 * distinction is the entire reason `quiescent` is `boolean | null`. "We did not
 * check" must never read like "we checked and it was fine", and it must not read
 * like "we checked and it moved" either.
 */
function describeConsistency(quiescent: boolean | null): string {
  if (quiescent === true) {
    return "proven quiescent - every table's row count and latest change stamp were identical before and after the sweep";
  }
  if (quiescent === false) {
    return "NOT quiescent - the instance changed while it was being read, so rows from different tables may not agree";
  }
  return "not verified - quiescence was not requested for this run, so nothing is claimed either way";
}

/** R1's three codes, each with the sentence a CI log needs beside it. */
function describeExitCode(exitCode: 0 | 1 | 2): string {
  if (exitCode === 0) {
    return "0 - complete";
  }
  if (exitCode === 1) {
    return "1 - fatal, the sweep stopped before it finished";
  }
  return "2 - completed, but some tables are partial or failed";
}

/** The run-level counts, exactly the ones `coverage.json` carries. */
function renderTotals(report: CoverageReport): string {
  const totals = report.totals;
  return [
    "## Totals",
    "",
    "| Metric | Count |",
    "| --- | --- |",
    `| Tables discovered | ${String(totals.tablesDiscovered)} |`,
    `| Tables mirrored | ${String(totals.tablesMirrored)} |`,
    `| Records mirrored | ${String(totals.recordsMirrored)} |`,
    `| Redactions | ${String(totals.redactions)} |`,
    `| Dangling references | ${String(totals.danglingRefs)} |`,
    "",
    "Dangling references are reference values naming a record this mirror does not",
    "hold. They are counted and never repaired (D2): the canonical layer records",
    "what the instance said, and inventing or deleting an edge to make the graph",
    "look whole would make the mirror disagree with its source.",
  ].join("\n");
}

/** Per-table outcome, one row each, sorted by table name. */
function renderTables(report: CoverageReport): string {
  const names = Object.keys(report.tables).sort(compareBytewise);
  if (names.length === 0) {
    return ["## Tables", "", "No table outcomes were recorded for this sweep."].join("\n");
  }
  const rows = names.map((name) => renderTableRow(name, report.tables[name]));
  return [
    "## Tables",
    "",
    "| Table | Status | Reason | Expected rows | Mirrored rows | Dangling refs | Not decomposed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderTableRow(name: string, coverage: TableCoverage): string {
  const cells = [
    `\`${escapeCell(name)}\``,
    coverage.status,
    coverage.reason === undefined ? EMPTY_CELL : `\`${escapeCell(coverage.reason)}\``,
    // `expectedRows` is nullable on purpose (§4.4): a null Aggregate means no
    // INDEPENDENT count exists, which is a different statement from zero rows.
    // Printing "0" for it would let a reader compare the sweep against itself.
    coverage.expectedRows === null ? "unknown" : String(coverage.expectedRows),
    String(coverage.mirroredRows),
    coverage.danglingRefs === undefined ? EMPTY_CELL : String(coverage.danglingRefs),
    renderFieldList(coverage.notDecomposed),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** D8's blob fields, or the placeholder when a table decomposed everything. */
function renderFieldList(fields: string[] | undefined): string {
  if (fields === undefined || fields.length === 0) {
    return EMPTY_CELL;
  }
  return [...fields]
    .sort(compareBytewise)
    .map((field) => `\`${escapeCell(field)}\``)
    .join(", ");
}

/**
 * D7 — every active suppression, with the mechanism that caused it.
 *
 * The section exists because a field absent from the tree is otherwise
 * unexplained: a column the instance never sent, a column the user's config
 * excluded, and a column whose TYPE is never safe to mirror all look identical on
 * disk, namely gone. Enumerating them is what turns "not in the mirror" into a
 * statement with a stated cause.
 */
function renderSuppressions(report: CoverageReport): string {
  const heading = [
    "## Suppressed fields",
    "",
    "Every field the mirror deliberately does not store, and what removed it. A",
    "field absent from the tree and absent from this list is a bug, not a policy.",
    "",
  ];
  if (report.suppressions.length === 0) {
    return [...heading, "No suppressions are active for this sweep."].join("\n");
  }
  const rows = [...report.suppressions]
    .sort(compareSuppressions)
    .map(
      (entry) =>
        `| \`${escapeCell(entry.table)}\` | \`${escapeCell(entry.field)}\` | ${describeSuppressionSource(entry.source)} |`
    );
  return [
    ...heading,
    "| Table | Field | Removed by |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "`*` in the table column means the rule applies to every mirrored table.",
  ].join("\n");
}

/** Same key order as `buildCoverageReport` uses, so the two files agree. */
function compareSuppressions(left: CoverageSuppression, right: CoverageSuppression): number {
  return (
    compareBytewise(left.table, right.table) ||
    compareBytewise(left.field, right.field) ||
    compareBytewise(left.source, right.source)
  );
}

/** The three mechanisms, spelled out — the enum value alone explains nothing. */
function describeSuppressionSource(source: CoverageSuppression["source"]): string {
  if (source === "builtin-noise") {
    return "built-in noise column (changes on every write, carries no content)";
  }
  if (source === "config-ignore") {
    return "`ignoreFields` in the mirror config";
  }
  return "field type is never safe to mirror (the API returns ciphertext for it)";
}

/**
 * Make a value safe to put inside a Markdown table cell.
 *
 * A raw `|` ends the cell and shifts every column after it, and a line break ends
 * the ROW, so one hostile field name would silently rewrite the rest of the table
 * into something that still renders and no longer means what it says. Neither
 * character occurs in a ServiceNow column name today; that is exactly the reason
 * to handle them here rather than trusting it to stay true of a name that arrives
 * from a user's config file.
 */
function escapeCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}
