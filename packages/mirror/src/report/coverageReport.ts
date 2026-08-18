// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `coverage.json` — the machine half of the ReportGenerator (WP-M8, §5.11, §4.4).
 *
 * This is the mirror's answer to the only question that matters about a backup:
 * not "did it succeed" but "what is in it, and what is knowably not". R3 makes
 * that answer total — every skip and every degradation lands here, and silence is
 * defined as a bug rather than a policy — so the file is written on every outcome
 * including a fatal one. A sweep that died halfway still has a coverage story, and
 * a missing report is the single result a reader cannot interpret.
 *
 * Three properties of this module are worth stating before anything is changed in
 * it, because each one exists to stop a specific way the file goes wrong:
 *
 * **The clock is a parameter.** `startedAt` and `finishedAt` arrive in
 * {@link CoverageReportInputs}; nothing here calls `Date.now()`. A report that
 * stamped itself would be untestable at the byte level — the one assertion this
 * file most needs is "two runs over an unchanged instance produce identical bytes
 * apart from the timestamps and the sweep id" (INV-1), and that assertion cannot
 * be written against a function whose output changes every millisecond.
 *
 * **The exit code is derived, not accepted.** {@link buildCoverageReport} computes
 * R1's 0/1/2 from the table outcomes rather than taking it as an argument. An
 * argument would let the number disagree with the rows underneath it, and CI reads
 * the number: a run reporting 0 with a failed table in the body is worse than a
 * run reporting nothing, because it is trusted.
 *
 * **The bytes go through the §8 renderer and the `WriterFs` seam.** Not
 * `JSON.stringify`, not `node:fs`. `coverage.json` is committed, so it obeys the
 * same canonical rules as every other file the mirror writes — sorted keys, LF,
 * two-space indent, one trailing newline — and it is written with the same
 * temp-plus-rename atomicity (R4), because a half-written coverage file is a
 * committed lie about a sweep that may have gone perfectly.
 */
import type { TableSuppressions } from "../catalog/catalogService";
import { NOISE_ELEMENTS } from "../catalog/fieldPolicy";
import type {
  CoverageReason,
  CoverageReport,
  CoverageSuppression,
  MirrorFailureClass,
  QuiescenceReading,
  SyncPlan,
  TableCoverage,
} from "../contracts";
import { compareBytewise } from "../order";
import { canonicalJsonBytes, encodeUtf8 } from "../serialize/serializer";
import { atomicWriteFile } from "../write/atomicWrite";
import { toNativePath, type WriterFs } from "../write/fs";
import { MIRROR_REPORT_REL_PATH, renderMirrorReport } from "./reportMarkdown";

/** Where the machine-readable report lives in the mirror repository (§3). Committed. */
export const COVERAGE_REL_PATH = "coverage.json";

/**
 * Coverage reasons that mean the RUN stopped, not that one table degraded.
 *
 * The failure taxonomy (analyses §2) splits the two: F1 exhausts its retries and
 * fails a single table while the sweep carries on (exit 2), whereas F4 finds the
 * instance gone and there is nothing left to read (exit 1). Both produce a table
 * row, so the row alone cannot tell them apart — the reason can.
 */
const FATAL_COVERAGE_REASONS: ReadonlySet<CoverageReason> = new Set<CoverageReason>([
  "instance-unreachable",
]);

/**
 * Failure classes that END a sweep (F2, F4, F8).
 *
 * These exist as a separate input because two of them leave NO coverage row at
 * all: the taxonomy's coverage column is "—" for F2 (auth expiry, one refresh
 * retry then fatal) and F8 (local disk or git lock failure), since neither is a
 * statement about a table. Without this set an `ENOSPC` mid-flush would produce a
 * report full of complete tables and exit 0 — a run that lost the rest of the
 * instance claiming it mirrored everything it tried.
 *
 * `hibernating` sits beside `unreachable` because D4 splits the diagnosis for the
 * user's benefit (a hibernating PDI is woken at developer.servicenow.com, an
 * unreachable one is not), while the consequence for the sweep is identical.
 */
const FATAL_FAILURE_CLASSES: ReadonlySet<MirrorFailureClass> = new Set<MirrorFailureClass>([
  "auth",
  "unreachable",
  "hibernating",
  "local-io",
]);

/** Everything {@link buildCoverageReport} needs, and nothing it can derive itself. */
export interface CoverageReportInputs {
  /**
   * The plan this sweep executed.
   *
   * Taken whole rather than as three loose fields so the report cannot be built
   * from a `sweepId` belonging to one run and a `preQuiescence` belonging to
   * another — the exact mistake that would make the D1 verdict describe a
   * different sweep than the shards beside it. Only `sweepId`, `mode` and
   * `preQuiescence` are read; `tables` is deliberately NOT cross-checked against
   * {@link tables}, see the note on that field.
   */
  plan: SyncPlan;
  /** ISO-8601 instant the sweep started. Injected — this module has no clock. */
  startedAt: string;
  /** ISO-8601 instant the sweep finished. Injected — this module has no clock. */
  finishedAt: string;
  /**
   * Per-table outcome, keyed by table name.
   *
   * The caller owns completeness. A planned table missing from this map is not
   * silently filled in here: the closed {@link CoverageReason} vocabulary has no
   * member meaning "the run stopped before this table was read", so a synthesized
   * row would have to borrow someone else's reason — reporting a disk failure as
   * `instance-unreachable`, for instance. Inventing a wrong cause is worse than
   * the honest signal the taxonomy already specifies for F2 and F8, which is exit
   * code 1 with no row.
   */
  tables: Record<string, TableCoverage>;
  /** Tables the catalog discovered, BEFORE config and tier filtering. */
  tablesDiscovered: number;
  /** Field values the Redactor replaced or dropped across the whole run. */
  redactions: number;
  /** D7 breakdown from the catalog build — one entry per included table. */
  suppressions?: readonly TableSuppressions[];
  /**
   * D1: the Aggregate readings re-taken AFTER the sweep, when `--verify-quiescent`
   * was requested. Absent when the re-check never ran.
   */
  postQuiescence?: Record<string, QuiescenceReading>;
  /**
   * The failure class that ended the run, when one did (F2 / F4 / F8).
   *
   * Absent means the sweep ran to its own end, whatever individual tables did.
   */
  fatal?: MirrorFailureClass;
}

/**
 * Assemble the §4.4 report. Pure: same inputs, same object, every time.
 *
 * `totals` is recomputed from the table rows rather than accepted, for the same
 * reason the exit code is: the file states each count once for a reader, and a
 * count that can disagree with the rows it summarizes is a count nobody can use.
 */
export function buildCoverageReport(inputs: CoverageReportInputs): CoverageReport {
  // Shallow copy so a caller that keeps mutating its accumulator after the report
  // is built cannot change what a report already written to disk claims.
  const tables: Record<string, TableCoverage> = { ...inputs.tables };
  const outcomes = Object.values(tables);
  return {
    formatVersion: 1,
    sweepId: inputs.plan.sweepId,
    mode: inputs.plan.mode,
    startedAt: inputs.startedAt,
    finishedAt: inputs.finishedAt,
    quiescent: evaluateQuiescence(inputs.plan.preQuiescence, inputs.postQuiescence),
    exitCode: deriveExitCode(outcomes, inputs.fatal),
    totals: {
      tablesDiscovered: inputs.tablesDiscovered,
      tablesMirrored: outcomes.filter((coverage) => coverage.mirroredRows > 0).length,
      recordsMirrored: outcomes.reduce((sum, coverage) => sum + coverage.mirroredRows, 0),
      redactions: inputs.redactions,
      danglingRefs: outcomes.reduce((sum, coverage) => sum + (coverage.danglingRefs ?? 0), 0),
    },
    suppressions: collectSuppressions(inputs.suppressions ?? []),
    tables,
  };
}

/**
 * D1 — the tri-state quiescence verdict.
 *
 * `null` is load-bearing and is the reason `quiescent` is not a boolean. "We did
 * not ask" and "we asked and the instance moved" are different claims about the
 * instance, and a boolean defaulting to `false` would let an unchecked run read as
 * a DISPROVEN one — which, since §7 rule 3 says quiescence is only ever proven,
 * would be the mirror manufacturing evidence in the one direction it must not.
 *
 * The pre-reading absent means `--verify-quiescent` was not requested. The
 * post-reading absent means the question was asked and never answered — the run
 * ended before the re-check — which is also `null`, because no comparison
 * happened and "the instance moved" is a positive claim that needs one.
 *
 * Once BOTH readings exist they are the evidence, and the comparison spans the
 * union of their table names. A table present on one side only is not treated as
 * missing data but as movement: a table that appeared or vanished between the two
 * readings is precisely the instance changing under the sweep, and recording that
 * as "not checked" would discard the strongest signal of the pair.
 */
function evaluateQuiescence(
  pre: Record<string, QuiescenceReading> | undefined,
  post: Record<string, QuiescenceReading> | undefined
): boolean | null {
  if (pre === undefined || post === undefined) {
    return null;
  }
  // Maps rather than index access: a table named `constructor` or `toString`
  // would resolve up `Object.prototype` on a plain object and compare against a
  // function, so the reading of a table the instance never had would look present.
  const before = new Map(Object.entries(pre));
  const after = new Map(Object.entries(post));
  for (const table of new Set([...before.keys(), ...after.keys()])) {
    const start = before.get(table);
    const end = after.get(table);
    if (start === undefined || end === undefined) {
      return false;
    }
    if (start.count !== end.count || start.maxUpdatedOn !== end.maxUpdatedOn) {
      return false;
    }
  }
  return true;
}

/**
 * R1's exit code, derived from what the run actually achieved.
 *
 * The order of the tests is the contract: 1 dominates 2 dominates 0, because
 * "the sweep stopped" is a stronger statement than "a table is partial", and a
 * run that hit both must report the stronger one. CI distinguishes them —
 * 2 means the mirror is honest but incomplete and a commit is still worth making,
 * 1 means the tree does not yet describe the instance.
 *
 * `skipped` never degrades the code. Its reasons (`excluded-config`,
 * `excluded-tier`, `not-exportable`) are all deliberate exclusions, and a run that
 * did exactly what it was configured to do is complete.
 */
function deriveExitCode(
  outcomes: readonly TableCoverage[],
  fatal: MirrorFailureClass | undefined
): 0 | 1 | 2 {
  if (fatal !== undefined && FATAL_FAILURE_CLASSES.has(fatal)) {
    return 1;
  }
  let degraded = false;
  for (const coverage of outcomes) {
    if (coverage.reason !== undefined && FATAL_COVERAGE_REASONS.has(coverage.reason)) {
      return 1;
    }
    if (coverage.status === "partial" || coverage.status === "failed") {
      degraded = true;
    }
  }
  return degraded ? 2 : 0;
}

/**
 * D7 — every active suppression, tagged with the mechanism that caused it.
 *
 * The requirement is total: a field absent from the tree must always have a
 * stated cause here, because on disk a column the instance never sent, a column
 * the user's config excluded and a column whose type is never safe to mirror are
 * indistinguishable — all three are simply gone.
 *
 * The built-in noise columns are emitted ONCE against `*` rather than repeated for
 * every table that has them. The rule genuinely is global (it is keyed on the
 * column name, not the table), and this file is committed and diffed: repeating
 * three rows across a few thousand tables would add tens of thousands of lines
 * that say the same thing and would re-order themselves whenever the table set
 * changed. A per-table `engineNoise` entry that is NOT one of the global names is
 * still emitted per table — it would otherwise be a suppression with no stated
 * cause, which is the one outcome D7 exists to forbid.
 *
 * Sorted by (table, field, source) with {@link compareBytewise}. Insertion order
 * here is catalog order, which is a scheduling decision; committing it would make
 * the file churn whenever the planner's ordering changed (INV-1).
 */
function collectSuppressions(tables: readonly TableSuppressions[]): CoverageSuppression[] {
  const seen = new Set<string>();
  const collected: CoverageSuppression[] = [];
  const add = (table: string, field: string, source: CoverageSuppression["source"]): void => {
    // JSON as the identity key rather than a delimiter-joined string: a field name
    // is user-supplied, and any separator it could contain would fuse two distinct
    // suppressions into one key and drop a row from a report that promises to be
    // exhaustive.
    const key = JSON.stringify([source, table, field]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    collected.push({ table, field, source });
  };
  for (const field of NOISE_ELEMENTS) {
    add("*", field, "builtin-noise");
  }
  for (const entry of tables) {
    for (const field of entry.engineNoise) {
      if (!NOISE_ELEMENTS.has(field)) {
        add(entry.table, field, "builtin-noise");
      }
    }
    for (const field of entry.userIgnored) {
      add(entry.table, field, "config-ignore");
    }
    for (const field of entry.denied) {
      add(entry.table, field, "redaction-deny");
    }
  }
  collected.sort(
    (left, right) =>
      compareBytewise(left.table, right.table) ||
      compareBytewise(left.field, right.field) ||
      compareBytewise(left.source, right.source)
  );
  return collected;
}

/**
 * Write `coverage.json` at the mirror root, atomically and in canonical bytes.
 *
 * `canonicalJsonBytes` rather than `JSON.stringify` because every file the mirror
 * commits goes through one renderer (§8): sorted keys at every level, LF, one
 * trailing newline. `atomicWriteFile` rather than a plain write because R4 admits
 * no window in which the tree holds half a file.
 */
export async function writeCoverageReport(
  fs: WriterFs,
  root: string,
  report: CoverageReport
): Promise<void> {
  await writeRepoRootFile(fs, root, COVERAGE_REL_PATH, canonicalJsonBytes(report));
}

/**
 * Write `MIRROR-REPORT.md` beside it, from the same report object.
 *
 * The I/O lives here and not in `reportMarkdown.ts` on purpose: that module is a
 * pure `CoverageReport -> string`, which is what lets its golden text be asserted
 * with no filesystem anywhere near the test. This function is the only place the
 * two meet.
 */
export async function writeMirrorReport(
  fs: WriterFs,
  root: string,
  report: CoverageReport
): Promise<void> {
  await writeRepoRootFile(
    fs,
    root,
    MIRROR_REPORT_REL_PATH,
    encodeUtf8(renderMirrorReport(report))
  );
}

/**
 * The shared write path.
 *
 * `makeDir(root)` first because {@link atomicWriteFile} stages its temp file as a
 * sibling of the target: the rename is only atomic within one directory, so that
 * directory has to exist before either step. On a normal run the mirror root is
 * already there and the call is a no-op; on the first sweep into a fresh
 * repository it is what makes the report writable at all.
 */
async function writeRepoRootFile(
  fs: WriterFs,
  root: string,
  repoRelative: string,
  bytes: Uint8Array
): Promise<void> {
  await fs.makeDir(root);
  await atomicWriteFile(fs, toNativePath(root, repoRelative), bytes);
}
