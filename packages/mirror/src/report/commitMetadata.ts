// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * D10 — the suggested commit message for a mirror sweep (WP-M8, §5.11).
 *
 * **This module does not commit anything, and that is the design.** There is no
 * `child_process` import here and there must never be one. §5.11 is explicit: the
 * mirror never runs `git commit` itself in Phase 1 — it prints a message and stops.
 * Three reasons, and the first is the one that matters:
 *
 *  - The mirror repository is backup-equivalent (§9, threat model T1/T2). A tool
 *    that stages and commits on the operator's behalf is a tool that can commit a
 *    sweep the operator has not looked at, into a branch they did not choose, with
 *    whatever else happened to be in the working tree. The review step between
 *    "the bytes are on disk" and "the bytes are history" is a safety property, not
 *    friction.
 *  - Committing is a policy decision the mirror has no basis for. Whether a run
 *    with exit code 2 (honest but partial) is worth a commit depends on the
 *    operator's retention rules; whether it is one commit or one per scope depends
 *    on their repository layout. Both are answered by the CI recipe in Phase 3,
 *    which is a place where those answers can be written down.
 *  - Shelling out to git would make this module's behaviour depend on a git
 *    binary, a working tree, an index lock and a user identity — four inputs a
 *    pure function does not have and four failure modes the sweep would inherit
 *    at the very end, after all the expensive work was already done.
 *
 * So: {@link buildMirrorCommitMessage} is a pure `CoverageReport -> string`. What
 * the caller does with the string is the caller's business.
 *
 * The trailers are the machine-readable half. Written as git trailers — last
 * paragraph, `Key: value` per line — so `git log --format='%(trailers:key=...)'`
 * and `git interpret-trailers` can read them without parsing prose, which is what
 * makes "which sweep produced this commit" answerable years later from the
 * repository alone.
 */
import type { CoverageReport } from "../contracts";
import { compareBytewise } from "../order";

/** The sweep this commit records — ties the commit to its `coverage.json`. */
export const MIRROR_TRAILER_SWEEP = "Mirror-Sweep";
/** How many tables this sweep touched. */
export const MIRROR_TRAILER_TABLES_CHANGED = "Mirror-Tables-Changed";
/** Which application scopes the sweep covered. */
export const MIRROR_TRAILER_SCOPES = "Mirror-Scopes";
/** D1: present only when quiescence was PROVEN. See {@link buildMirrorCommitMessage}. */
export const MIRROR_TRAILER_CONSISTENCY = "Mirror-Consistency";

/** Inputs for the suggested commit message. */
export interface CommitMetadataInputs {
  /** The report for the sweep being committed. */
  report: CoverageReport;
  /**
   * Tables whose content this sweep changed, when the caller can observe that.
   *
   * Optional because the mirror itself cannot answer it in Phase 1. The writer
   * re-writes every record it fetches and relies on byte-identical output to make
   * an unchanged record produce no diff (INV-1), so "changed" is a fact about the
   * git index, not about the sweep — and this module is forbidden to ask git.
   * Omitted, the count falls back to the tables that received at least one record,
   * which is the honest superset the report can support. A caller with better
   * evidence (the Phase 3 CI recipe, which may consult `git status --porcelain`)
   * passes the precise set.
   */
  changedTables?: readonly string[];
  /** Application scopes the sweep covered, in any order; deduplicated and sorted here. */
  scopes?: readonly string[];
}

/**
 * Render the suggested commit message: subject, body, trailer block.
 *
 * `Mirror-Consistency: quiescent` appears if and only if `report.quiescent` is
 * exactly `true`. Not when it is `null`, which means the check was never
 * requested. §7 rule 3 says quiescence is only ever proven, and a trailer is the
 * most durable claim the mirror makes — it outlives the report, the log and the
 * operator, and someone reading a five-year-old commit will take it literally. A
 * trailer asserted from an absent check would be exactly the assumed consistency
 * the rule forbids. There is deliberately no `Mirror-Consistency: not-quiescent`
 * counterpart either: the absence of the trailer means "not proven", and the
 * distinction between "moved" and "not checked" lives in `coverage.json`, which is
 * the file with room to explain itself.
 */
export function buildMirrorCommitMessage(inputs: CommitMetadataInputs): string {
  const report = inputs.report;
  const tablesChanged = countChangedTables(inputs);
  const scopes = normalizeScopes(inputs.scopes ?? []);

  const trailers = [
    `${MIRROR_TRAILER_SWEEP}: ${report.sweepId}`,
    `${MIRROR_TRAILER_TABLES_CHANGED}: ${String(tablesChanged)}`,
  ];
  if (scopes.length > 0) {
    // Omitted rather than emitted empty when nothing is known. `Key:` with no
    // value parses as a present trailer whose value is the empty string, so a
    // reader cannot tell "we determined the scope set and it is empty" from "we
    // have no scope information" — and those are different facts.
    trailers.push(`${MIRROR_TRAILER_SCOPES}: ${scopes.join(",")}`);
  }
  if (report.quiescent === true) {
    trailers.push(`${MIRROR_TRAILER_CONSISTENCY}: quiescent`);
  }

  return [renderSubject(report, tablesChanged), renderBody(report), trailers.join("\n")].join(
    "\n\n"
  );
}

/**
 * The subject line: what kind of read this was, and how much moved.
 *
 * Conventional-commit shape (`mirror(<mode>): …`) because the mirror repository is
 * a git repository like any other and its history is read with the same tools.
 */
function renderSubject(report: CoverageReport, tablesChanged: number): string {
  const noun = tablesChanged === 1 ? "table" : "tables";
  return `mirror(${report.mode}): ${String(tablesChanged)} ${noun} changed`;
}

/**
 * The body: enough for someone reading `git log` to decide whether to open
 * `coverage.json`.
 *
 * Counts are rendered with `String`, never `toLocaleString`. Locale-aware number
 * formatting inserts separators that depend on the ICU data in the Node build, so
 * the same sweep would produce different commit messages on different machines —
 * the class of machine-dependence INV-1 exists to keep out of this repository.
 */
function renderBody(report: CoverageReport): string {
  const totals = report.totals;
  const lines = [
    `Observed state of ${String(totals.tablesMirrored)} of ${String(totals.tablesDiscovered)} discovered tables,`,
    `${String(totals.recordsMirrored)} records, ${String(totals.redactions)} redactions, ${String(totals.danglingRefs)} dangling references.`,
  ];
  const degraded = countByStatus(report);
  if (degraded.partial > 0 || degraded.failed > 0 || degraded.skipped > 0) {
    lines.push(
      `${String(degraded.partial)} partial, ${String(degraded.failed)} failed, ${String(degraded.skipped)} skipped - see coverage.json for the reason on each.`
    );
  }
  if (report.exitCode !== 0) {
    // Stated in the body as well as the trailers because a non-zero exit is the
    // one thing a reader must not miss, and prose survives a tool that strips
    // trailers on rebase or squash.
    lines.push(`Sweep exit code ${String(report.exitCode)}: this mirror is not complete.`);
  }
  return lines.join("\n");
}

/** Per-status tallies, so the body can say which kind of gap the run has. */
function countByStatus(report: CoverageReport): {
  partial: number;
  failed: number;
  skipped: number;
} {
  const tally = { partial: 0, failed: 0, skipped: 0 };
  for (const coverage of Object.values(report.tables)) {
    if (coverage.status === "partial") {
      tally.partial += 1;
    } else if (coverage.status === "failed") {
      tally.failed += 1;
    } else if (coverage.status === "skipped") {
      tally.skipped += 1;
    }
  }
  return tally;
}

/**
 * How many tables the trailer claims.
 *
 * Deduplicated, because a caller accumulating names per shard flush would
 * otherwise count a large table once per flush and report a number larger than
 * the instance has tables.
 */
function countChangedTables(inputs: CommitMetadataInputs): number {
  if (inputs.changedTables !== undefined) {
    return new Set(inputs.changedTables).size;
  }
  return Object.values(inputs.report.tables).filter((coverage) => coverage.mirroredRows > 0).length;
}

/**
 * Deduplicated, byte-sorted scope list.
 *
 * Sorted for the same reason the report's rows are: the message is generated from
 * the sweep, and the order the scopes were discovered in is a scheduling detail.
 * Two runs over an unchanged instance should propose the same message, or the
 * suggestion is noise the operator learns to ignore.
 */
function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort(compareBytewise);
}
