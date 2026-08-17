#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Coverage-ANNOTATION drift gate.
//
// WHY THIS EXISTS: both coverage gates in this repo record, next to every
// per-file floor, the measurement that floor was derived from:
//
//   packages/core/jest.config.cjs
//     './src/manifestBuilder.ts': { lines: 91, branches: 74 }, // measured 94.39 / 78.96
//   packages/mcp-server/scripts/check-coverage-gate.js
//     { pattern: 'dist/policyConfig.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
//
// Two static audits already read those annotations — `coverageFloors.test.ts`
// (GATE-3, core) and `coverageGatePerFile.test.js` (mcp-server) — but both compare
// the FLOOR to the ANNOTATION and take the annotation itself on faith. Nothing
// compared the annotation to reality, so the numbers rotted unnoticed:
// `manifestBuilder.ts` recorded 94.39 / 78.96 while measuring 93.55 / 81.02, and
// `downloadPipeline.ts` recorded 85.39 branches while measuring 84.61. Both had
// drifted DOWNWARD, the dangerous direction: the file was closer to its floor than
// the comment beside it claimed. Ten annotations across the two configs were stale
// when this gate first ran.
//
// That is not cosmetic. "measured minus floor" is the HEADROOM the team reasons
// with when deciding whether a floor is safe to raise and whether a file is at risk
// on another OS, and BOTH audits above enforce a maximum headroom against the
// recorded number. A drifted annotation makes manifestBuilder's real 2.55 points of
// line headroom read as 3.39 — and lets a floor that is in fact unsatisfiable slip
// past the very assertion written to catch unsatisfiable floors.
//
// This checker closes the loop: it reads the same annotations and compares them to
// the coverage report each package actually produced.
//
// NO TOLERANCE — BUT A SECOND READING MAY BE DECLARED. Both reporters quantise to
// two decimals before anyone sees them (istanbul's `percent()` floors to 1/100th
// before writing coverage-summary.json, Node's test-coverage reporter prints
// `toFixed(2)`), and the annotation is a transcription of exactly that rendering,
// so anything other than an exact match at two decimals is a transcription that no
// longer describes the tree. Recorded values are compared as numbers
// (`Number(x).toFixed(2)`), so `100` and `100.00` are the same value, but 78.96 and
// 81.02 are not "close enough" — they are a different file.
//
// That rule originally rested on both sides coming from the same DETERMINISTIC
// instrumentation. Measurement showed that to be true of only one of them; see
// "THE INSTRUMENT IS NOT REPRODUCIBLE" below, where the V8 side reports a different
// number for the same tree often enough to redden CI on a branch nobody touched.
// The answer is NOT a tolerance window — the same window would absorb the real
// regressions catalogued below, which moved this file by as little as 0.42 points.
// It is an explicitly DECLARED second reading:
//
//   { pattern: 'dist/audit.js', line: 94, branch: 88 }, // measured 96.83 / 92.62 (also 96.83 / 92.65: <cause>)
//
// Exactly the two recorded readings pass and a third still fails. A declaration
// must name its cause; the first pair must be the LOWER reading, because the floor
// audits (`coverageGatePerFile.test.js`, `coverageFloors.test.ts`) read that first
// pair and compute headroom from it, so it has to be the conservative one; and only
// the V8 target accepts a declaration at all — one on the istanbul side is rejected
// as malformed rather than quietly widening the deterministic gate.
//
// WHAT "DETERMINISTIC INSTRUMENTATION" ASSUMES, AND WHERE IT BIT. Exact matching is
// only as stable as the least-deliberately-covered line in the tree. The first red
// this gate produced on a tree nobody had touched was `dist/policyConfig.js`,
// 100.00 / 100.00 recorded against 97.60 / 99.00 measured — and the honest reading
// was that the FILE was nondeterministic, not the comment. Lines 311-318 are the
// REV-197 refusal of a `requireDryRun` guardrail naming a tool that cannot honour a
// dry run, and no suite covered them on purpose: measured file by file across all 60
// mcp-server suites, not one reaches line 311 alone. The arm was being covered by
// whatever the concurrent full run happened to do, so it moved between runs. The fix
// belonged in the tests, not here — `guardrailFailClosed.test.js` now drives that
// refusal directly, and the file is 100 / 100 by construction. When this gate reddens
// on a file no PR touched, ask which branch has no test of its own before assuming
// the annotation rotted; do NOT introduce a tolerance to absorb it, because the same
// tolerance would absorb a real regression.
//
// The very next run produced a second one, so treat this as a class rather than an
// anecdote. `dist/audit.js` had been recorded three ways — 96.33/91.74, 96.57/92.12,
// 96.25/91.70 — and the way to localise it is cheap: keep a few saved reports and diff
// their per-file rows. The whole difference was one range, the `while (existsSync(...))`
// collision arm of `toCorruptAuditPath`, which fires only when the same audit file is
// quarantined twice inside one millisecond; the `.corrupt.` cap test does five in a tight
// loop, so an idle machine collided and a loaded one did not. That one needed a SOURCE
// change, not just a test — the clock was embedded in the function, which made the arm
// unreachable on purpose rather than merely untested. Both shapes are the same underneath:
// a branch whose coverage depended on something other than a test.
//
// A third run, a third carrier, same class: `./src/commands.ts` flapped between
// 96.73/83.11 and 96.19/81.81, and the row-diff pinned the whole gap to one statement and
// one branch — `if (process.exitCode)`, the guard that stops `downloadCommand` announcing
// success over a pull that lost a table. `process.exitCode` is per-PROCESS: Jest packs
// many suites into one worker, ~20 source sites set it, and not every suite restores it,
// so the arm was chosen by whatever ran earlier in that worker. Pinned in the suite's
// hooks now, and driven deliberately.
//
// Two lessons worth keeping. Localising costs seconds — save a few reports and diff the
// per-file rows; the flapping range falls out. And re-measure with the SAME command this
// gate uses: two samples taken with `--testPathPatterns` ran a subset of the suites that
// touch `commands.ts`, agreed with each other, and argued for "correcting" the annotation
// in exactly the wrong direction. A subset run is not a sample of this number.
//
// THE INSTRUMENT IS NOT REPRODUCIBLE, AND THAT IS A DIFFERENT CLASS. Every carrier above
// was a branch whose coverage depended on something other than a test, and every one was
// closed by a test or a source change. Then a fourth shape appeared that no test can reach.
// Over 45 mcp-server tables, `dist/audit.js` read 92.62% branches in 42 of them and 92.65% in
// 3; `dist/inputValidation.js` read 96.15% in 44 and 96.30% in 1. Across all 45, each file
// reported exactly ONE uncovered-line list — the column did not move at all, in either file,
// at either percentage. The corpus is not one tree end to end: a test file landed after the
// first four tables, so those four are a different tree. It does not weaken the result, and
// saying so is cheaper than letting someone discover it later — all three flickering files
// read their modal value in all four, and every odd reading falls inside the homogeneous
// 41-table block that follows.
//
// The arithmetic says what happened. 226/244 = 92.62 against 227/245 = 92.65; 25/26 = 96.15
// against 26/27 = 96.30. Numerator AND denominator each rose by one, so V8 reported one
// extra range that was ALREADY being executed. There is no branch to drive: a test cannot
// pin a range that is already covered.
//
// THE CLASS RUNS IN BOTH DIRECTIONS, which is why "measured >= recorded" is not the cheap
// fix it looks like. In the same 45 tables `dist/toolService.js` read 92.05% branches in 44
// and 91.53% in one — again a single uncovered-line list across all 45, again the same 44/1
// ratio, but the odd reading is LOWER: an extra range that was NOT executing enlarges the
// denominator alone. `dist/workflowHandlers.js` shows the same sign, moving 99/118 = 83.90 to
// 99/122 = 81.15. So direction does not sort the classes and neither does size — the odd
// readings here span 0.03 to 0.52 points, and real defects this repo has fixed moved a file
// by as little as 0.42. Only the uncovered-line column sorts them.
// Both mechanical fixes were tested and refuted, not guessed at: interleaved A/B runs
// of `--no-flush-bytecode` and of `--no-lazy-feedback-allocation`, six rounds each with the
// later rounds under CPU load, flags verified to reach the per-file child processes through
// execArgv. Both arms kept moving, and the second flag flaked MORE than the default.
//
// The other side of the comparison was measured rather than assumed: three full istanbul
// runs on an unchanged tree produced a byte-identical coverage-summary.json. That is
// run-to-run on one host — it says nothing about the cross-OS drift core's floors are
// deliberately sized to absorb — but it is why exact matching stays the rule for core and
// the declaration is confined to the V8 target.
//
// SO: WHICH CLASS IS IN FRONT OF YOU? When this gate reddens on a file no PR touched, diff
// two saved reports and read the UNCOVERED-LINE column before the percentage.
//   - the uncovered lines MOVED     -> a branch really changed. One of the classes above:
//                                      find the arm with no test of its own and drive it.
//   - the uncovered lines are IDENTICAL and only the percentage moved -> V8 range
//                                      granularity. Record the second reading with the
//                                      arithmetic that explains it. Do not chase it with a
//                                      test, and do not "correct" the annotation to the new
//                                      value — that only moves the flake to the other side.
// Over 16 tables, six files moved their branch percentage and only two moved their
// uncovered-line list, so the column is what separates the classes, not the percentage.
//
// FAIL-CLOSED. This gate refuses to render a verdict it cannot back:
//   - a coverage report that is missing, unreadable or older than the sources it
//     claims to describe exits 2 ("cannot judge") instead of reporting "no drift";
//   - a report in which an annotated file measures 0.00% lines against a non-zero
//     annotation exits 2 as a suspected PARTIAL report: a filtered run (e.g.
//     `jest --testPathPatterns x`) overwrites the report with subset numbers, and
//     `collectCoverageFrom` still lists every unloaded file at 0% — so every key
//     resolves, the mtime check reads "fresh" (the report is NEWER than the
//     sources), and without this guard the verdict would be exit-1 "drift" with
//     `fix: // measured 0.00 / 0.00` directives that must never be pasted;
//   - a floor entry with no annotation fails, so the drift cannot be silenced by
//     deleting the comment;
//   - an annotation naming a file the report does not contain fails, rather than
//     being skipped;
//   - an unparseable `// measured ...` payload fails as malformed rather than
//     being ignored by a regex that quietly matched nothing;
//   - a declared second reading fails as malformed if it names no cause, repeats
//     the first reading, sits below it, or appears on the istanbul target — the
//     escape hatch is narrow on purpose, because a wide one is a tolerance.
// The repo has been burned by the opposite: `--rounds` parsed to NaN, zero rounds
// ran, and the lock-race gate reported success (see CONTRIBUTING.md). A gate that
// passes vacuously is worse than no gate.
//
// INPUTS (both are gitignored build artifacts, never committed):
//   packages/core/coverage/coverage-summary.json
//       Jest's `json-summary` reporter, written by `npm run test:core`.
//   packages/mcp-server/coverage/coverage-report.txt
//       The verbatim TAP coverage report `check-coverage-gate.js` just judged,
//       persisted by that gate. Deliberately the SAME bytes the gate scored — this
//       checker re-parses it with the gate's own `parsePerFileCoverage`, so the two
//       can never disagree about what the report says, and no second (expensive)
//       test run is needed to answer the question.
//
// EXIT CODES: 0 every annotation matches; 1 at least one annotation is wrong,
// missing or malformed; 2 the inputs do not allow a verdict.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");

/** Exit code for "the annotations are wrong". */
const EXIT_DRIFT = 1;
/** Exit code for "the inputs do not support any verdict". */
const EXIT_CANNOT_JUDGE = 2;

// ---------------------------------------------------------------------------
// Annotation parsing
// ---------------------------------------------------------------------------

const DECLARED_SECOND_READING =
  /\s*\(\s*also\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*:\s*([^)]*[^)\s])\s*\)$/i;

/**
 * A recorded or measured percentage at the resolution the instrument actually
 * has: two decimals, which is what both reporters print.
 *
 * Every comparison in this file goes through it, and that uniformity is the
 * point. `agrees` always rounded; the declaration checks originally compared raw
 * Numbers, so `92.617` was "below" `92.62` here and equal to it there. A
 * `fix:` directive built on one rule and re-parsed under the other can emit text
 * this gate then rejects as malformed — a gate that disagrees with its own
 * suggested fix teaches people to stop trusting it.
 */
const atReportPrecision = (value) => Number(Number(value).toFixed(2));

/**
 * Why a declared second reading is rejected, or null when it is well formed.
 *
 * The rules that are not merely cosmetic:
 *   - it needs the "<lines> / <branches>" shape, because the flicker being
 *     declared is a branch-denominator artefact and a file with no branches has
 *     nothing to flicker;
 *   - the FIRST pair must be the lower one. `coverageGatePerFile.test.js` and
 *     `coverageFloors.test.ts` both parse the first pair and ignore the rest, so
 *     they keep computing headroom against the conservative reading only as long
 *     as the conservative reading is the one written first;
 *   - the cause must contain a letter. This is a floor, not a judgement: it costs
 *     a declaration nothing to write "." or an invisible U+200B and satisfy a
 *     merely-non-empty check, and a declaration whose cause says nothing is the
 *     tolerance this design exists to avoid. Whether the cause is TRUE is checked
 *     one level up, by the drift test that requires the live declarations to
 *     record their arithmetic; no regex can do that job here.
 */
function secondReadingFault(pair, alternative) {
  if (!pair) {
    return 'a second reading needs the "<lines> / <branches>" shape — a file reported as "N lines (0 branches)" has no branch total to flicker';
  }
  if (!/\p{L}/u.test(alternative.reason)) {
    return `the second reading names no cause (${JSON.stringify(alternative.reason)}) — say why the instrument reports two values, with the arithmetic, or do not declare it`;
  }
  const [, primaryLines, primaryBranches] = pair;
  const altLines = atReportPrecision(alternative.recordedLines);
  const altBranches = atReportPrecision(alternative.recordedBranches);
  const firstLines = atReportPrecision(primaryLines);
  const firstBranches = atReportPrecision(primaryBranches);
  if (altLines === firstLines && altBranches === firstBranches) {
    return `the second reading repeats the first (${primaryLines} / ${primaryBranches}) — declare it only when the instrument really reports two values`;
  }
  if (altLines < firstLines || altBranches < firstBranches) {
    return `the second reading ${alternative.recordedLines} / ${alternative.recordedBranches} is below the first ${primaryLines} / ${primaryBranches} — record the LOWER reading first, because the floor audits compute headroom from the first pair alone`;
  }
  return null;
}

/**
 * Every `// measured ...` annotation in a source file, keyed by the floor key it
 * sits on.
 *
 * One parser serves both files because both spell an entry the same way: a
 * single-quoted key, then the floor object, then the annotation at end of line
 * (`'./src/x.ts': {...}, // measured L / B` and
 * `{ pattern: 'dist/x.js', ... }, // measured L / B`). The key is the FIRST
 * single-quoted string left of the annotation.
 *
 * PROSE IS NOT AN ANNOTATION. Both files discuss measurement at length, and both
 * quote the annotation format inside their own comments ("recorded per entry as
 * `measured L/B`", "the `// measured L / B` annotations are MACHINE-CHECKED"), so
 * a naive text match reports the documentation as broken annotations. The
 * discriminator is the quoted floor key: a real entry is a quoted key, then the
 * floor object, then the comment — every prose mention has no quoted key to its
 * left and is skipped.
 *
 * Skipping is safe precisely because it is not the fail-closed mechanism.
 * `compareTarget` requires an annotation for EVERY floor key the config declares,
 * so an annotation this parser fails to recognise surfaces as "no `// measured`
 * annotation" on the entry it belongs to — never as silence.
 */
export function parseMeasuredAnnotations(source, { allowSecondReading = false } = {}) {
  const annotations = new Map();
  const malformed = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i];
    const match = /\/\/\s*measured\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const keyMatch = /'([^']+)'/.exec(line.slice(0, match.index));
    if (!keyMatch) {
      continue;
    }
    const key = keyMatch[1];

    // Shape C — an optional declared second reading appended to shape A:
    // "measured 96.83 / 92.62 (also 96.83 / 92.65: <cause>)". Stripped first so
    // the two anchored shapes below still see exactly what they always saw.
    let payload = match[1];
    let alternative = null;
    let declarationFault = null;
    const declared = DECLARED_SECOND_READING.exec(payload);
    const mentionsDeclaration = declared !== null || /\(\s*also\b/i.test(payload);
    // Order matters. "This target does not accept one at all" outranks "this one
    // is written wrong": on the istanbul side the grammar advice would be a
    // correct-looking instruction to write a form this target rejects
    // unconditionally, so someone following it lands on a second failure that
    // reads as the gate contradicting itself.
    if (mentionsDeclaration && !allowSecondReading) {
      declarationFault =
        'a second reading is not accepted for this target — "(also ...)" exists for the V8 instrument, which is not reproducible; istanbul is, so an istanbul annotation that no longer matches is drift, not flicker';
    } else if (declared) {
      payload = payload.slice(0, declared.index);
      alternative = {
        recordedLines: declared[1],
        recordedBranches: declared[2],
        reason: declared[3].trim(),
      };
    } else if (mentionsDeclaration) {
      declarationFault =
        'unparseable second reading — expected "(also <lines> / <branches>: <cause>)", with a cause that names why the instrument reports two values and no nested parentheses';
    }

    if (declarationFault) {
      malformed.push({ lineNumber, text: line.trim(), reason: declarationFault });
      continue;
    }

    // Shape A — "measured 98.21 / 91.80": lines / branches.
    const pair = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(payload);
    // Shape B — "measured 100.00 lines (0 branches)": a file that declares no
    // branch at all, where a branch floor would gate nothing (istanbul and V8
    // both report 0/0 branches as 100%).
    const linesOnly = /^(\d+(?:\.\d+)?)\s+lines\s*\(\s*0\s+branches\s*\)$/.exec(payload);

    if (!pair && !linesOnly) {
      malformed.push({
        lineNumber,
        text: line.trim(),
        reason: `unrecognised payload "${payload}" — expected "<lines> / <branches>" or "<lines> lines (0 branches)"`,
      });
      continue;
    }

    if (alternative) {
      const fault = secondReadingFault(pair, alternative);
      if (fault) {
        malformed.push({ lineNumber, text: line.trim(), reason: fault });
        continue;
      }
    }

    if (annotations.has(key)) {
      malformed.push({
        lineNumber,
        text: line.trim(),
        reason: `duplicate annotation for "${key}" (also on line ${annotations.get(key).lineNumber})`,
      });
      continue;
    }

    annotations.set(key, {
      key,
      lineNumber,
      recordedLines: pair ? pair[1] : linesOnly[1],
      recordedBranches: pair ? pair[2] : null,
      zeroBranches: !pair,
      alternative,
    });
  }

  return { annotations, malformed };
}

/**
 * The corrected comment text for an entry, ready to paste over the old one — on a
 * target that allows a declared second reading, only after confirming the
 * uncovered-LINE column really moved. If it did not, pasting this over the old text
 * does not fix anything; it moves the flicker to the value you just replaced.
 *
 * A declared second reading is carried through rather than dropped: it is knowledge
 * someone paid repeated runs to establish, and whether it survived a change is a
 * judgement for the person reading the diff, not one a `fix:` directive should make
 * silently. It is carried through only while it still sits ABOVE the new
 * measurement, because a directive must never emit text this gate would itself
 * reject as malformed — which is also why the comparison rounds to the instrument's
 * two decimals rather than comparing raw Numbers, so "above" here means exactly what
 * it means in `secondReadingFault`. When it cannot be carried, `compareTarget` says
 * so in the report rather than letting it disappear between two runs.
 */
export function formatAnnotation({ lines, branches, zeroBranches, alternative = null }) {
  const head = zeroBranches
    ? `// measured ${lines.toFixed(2)} lines (0 branches)`
    : `// measured ${lines.toFixed(2)} / ${branches.toFixed(2)}`;
  if (!alternative || zeroBranches) {
    return head;
  }
  const altLines = atReportPrecision(alternative.recordedLines);
  const altBranches = atReportPrecision(alternative.recordedBranches);
  const newLines = atReportPrecision(lines);
  const newBranches = atReportPrecision(branches);
  const stillAbove = altLines >= newLines && altBranches >= newBranches;
  const differs = altLines !== newLines || altBranches !== newBranches;
  if (!stillAbove || !differs) {
    return head;
  }
  return `${head} (also ${alternative.recordedLines} / ${alternative.recordedBranches}: ${alternative.reason})`;
}

/** Exact agreement at the two decimals both reporters emit. */
function agrees(recorded, actual) {
  return atReportPrecision(recorded) === atReportPrecision(actual);
}

/**
 * True when `actual` matches either recorded reading. Exactly the declared values
 * pass — a third value is drift, which is what keeps this from being a tolerance:
 * a window absorbs whatever lands inside it, a declaration absorbs one named value.
 */
function agreesWithEither(annotation, actualLines, actualBranches) {
  const primary =
    agrees(annotation.recordedLines, actualLines) &&
    agrees(annotation.recordedBranches, actualBranches);
  if (primary || !annotation.alternative) {
    return primary;
  }
  return (
    agrees(annotation.alternative.recordedLines, actualLines) &&
    agrees(annotation.alternative.recordedBranches, actualBranches)
  );
}

// ---------------------------------------------------------------------------
// Report freshness
// ---------------------------------------------------------------------------

/** Every file under `dir` (recursively) whose name ends with one of `extensions`. */
function listFiles(dir, extensions) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(abs);
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Report inputs that are NEWER than the report, i.e. proof the report describes a
 * tree that no longer exists.
 *
 * Freshness is measured against SOURCES (`src/**` and mcp-server's `test/**`), not
 * against build output. Two reasons, both load-bearing:
 *   - `dist/` is rewritten by every `tsc` run, and the `check` chain rebuilds
 *     mcp-server AFTER the coverage gate (SKIP_TESTS=1 quality:all), so a dist
 *     comparison would report a false "stale" for a report that is perfectly
 *     current;
 *   - the annotated files themselves (jest.config.cjs, check-coverage-gate.js) are
 *     deliberately excluded: correcting a drifted annotation edits exactly those
 *     files and does not change a single measurement, so counting them would make
 *     the fix for this gate's own failure look like a new failure.
 * Editing a source or a test DOES change coverage, so those are the honest inputs.
 */
export function findNewerInputs(reportPath, inputFiles) {
  const reportMtime = fs.statSync(reportPath).mtimeMs;
  return inputFiles
    .filter((file) => fs.statSync(file).mtimeMs > reportMtime)
    .map((file) => path.relative(REPO_ROOT, file));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The core package: floors live in `coverageThreshold`, measurements in Jest's
 * json-summary report.
 *
 * The floor KEYS are taken from the required config rather than re-parsed out of
 * the source, so the set this gate audits is by definition the set Jest enforces.
 * Glob keys (`./src/**\/*.ts`) score a whole group and carry no single
 * measurement, so only concrete keys are annotated and audited.
 */
export function coreTarget() {
  const packageRoot = path.join(REPO_ROOT, "packages", "core");
  const configPath = path.join(packageRoot, "jest.config.cjs");
  const summaryPath = path.join(packageRoot, "coverage", "coverage-summary.json");

  const config = require(configPath);
  const keys = Object.keys(config.coverageThreshold ?? {}).filter(
    (key) => key !== "global" && !/[*?[\]!]/.test(key)
  );

  const load = () => {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const byKey = new Map();
    for (const [absolute, entry] of Object.entries(summary)) {
      if (absolute === "total" || !path.isAbsolute(absolute)) {
        continue;
      }
      const relative = path.relative(packageRoot, absolute).split(path.sep).join("/");
      if (relative.startsWith("..")) {
        continue;
      }
      byKey.set(`./${relative}`, {
        lines: entry.lines.pct,
        branches: entry.branches.pct,
        branchesTotal: entry.branches.total,
      });
    }
    if (byKey.size === 0) {
      throw new Error("the report lists no source files");
    }
    return (key) => (byKey.has(key) ? { status: "ok", ...byKey.get(key) } : { status: "missing" });
  };

  return {
    label: "packages/core",
    annotatedFile: path.relative(REPO_ROOT, configPath),
    source: fs.readFileSync(configPath, "utf8"),
    keys,
    keyNoun: "coverageThreshold key",
    reportPath: summaryPath,
    reportLabel: "Jest json-summary",
    refreshCommand: "npm run test:core",
    inputFiles: [
      ...listFiles(path.join(packageRoot, "src"), [".ts"]),
      // The measurement's configuration, not just its tree: jest.setup.cjs
      // forces SYNCRONA_USE_KEYCHAIN=0 (which decides which keychain branches a
      // run can reach at all), and package.json carries the jest invocation the
      // report comes from (coverage switches, reporters). Editing either
      // changes what a "fresh" report would say.
      path.join(packageRoot, "jest.setup.cjs"),
      path.join(packageRoot, "package.json"),
    ].filter((file) => fs.existsSync(file)),
    load,
  };
}

/**
 * The mcp-server package: floors live in `MODULE_FLOORS`, measurements in the TAP
 * coverage report the gate persists.
 *
 * `MODULE_FLOORS` and the report parser are imported from the gate itself, so this
 * checker cannot drift from the thing it audits — same table, same glob semantics,
 * same column reading.
 */
export function mcpTarget() {
  const packageRoot = path.join(REPO_ROOT, "packages", "mcp-server");
  const gatePath = path.join(packageRoot, "scripts", "check-coverage-gate.js");
  const gate = require(gatePath);
  const reportPath = path.join(packageRoot, gate.REPORT_FILE);

  const load = () => {
    const rows = gate.parsePerFileCoverage(fs.readFileSync(reportPath, "utf8"));
    if (rows.length === 0) {
      throw new Error("the report lists no modules");
    }
    return (pattern) => {
      const re = gate.globToRegExp(pattern);
      const matches = rows.filter((row) => re.test(row.file));
      if (matches.length === 0) {
        return { status: "missing" };
      }
      if (matches.length > 1) {
        return { status: "ambiguous", matches: matches.map((row) => row.file) };
      }
      return {
        status: "ok",
        lines: matches[0].linePct,
        branches: matches[0].branchPct,
        branchesTotal: null,
      };
    };
  };

  return {
    label: "packages/mcp-server",
    annotatedFile: path.relative(REPO_ROOT, gatePath),
    source: fs.readFileSync(gatePath, "utf8"),
    keys: gate.MODULE_FLOORS.map((entry) => entry.pattern),
    keyNoun: "MODULE_FLOORS pattern",
    // This target, and only this target, may declare a second reading: its
    // instrument is V8 range coverage, measured here as not reproducible
    // run-to-run on an unchanged tree. See the header.
    allowSecondReading: true,
    reportPath,
    reportLabel: "node --test coverage",
    refreshCommand: "npm run test:coverage:mcp",
    inputFiles: [
      ...listFiles(path.join(packageRoot, "src"), [".ts"]),
      ...listFiles(path.join(packageRoot, "test"), [".js"]),
      // Same reasoning as the core target: package.json carries the `node
      // --test` invocation (and its coverage flags) the report comes from.
      path.join(packageRoot, "package.json"),
    ].filter((file) => fs.existsSync(file)),
    load,
  };
}

// ---------------------------------------------------------------------------
// Partial-report detection
// ---------------------------------------------------------------------------

/**
 * Floor keys whose file measures 0.00% lines while the annotation records real
 * coverage — the signature of a PARTIAL report, not of drift.
 *
 * A filtered run (`jest --testPathPatterns x` with coverage on) overwrites the
 * report with subset numbers, and `collectCoverageFrom` still emits every
 * unloaded file at 0%. That report defeats both other freshness defences: every
 * key resolves (so nothing reads as "missing"), and the report is NEWER than the
 * sources (so the mtime check reads "fresh"). Left alone, the comparison would
 * render exit-1 "drift" with `fix: // measured 0.00 / 0.00` directives — telling
 * the developer to transcribe the artifact of their own filtered run.
 *
 * An annotated file at a genuine 0.00% is indistinguishable from that shape from
 * here, so this gate refuses to judge either way and asks for a full run; if the
 * zero is real, the coverage floor gate itself is the thing that must go red.
 */
export function findPartialReportSuspects({ keys, source, resolve, allowSecondReading = false }) {
  // The option is threaded through for a reason: without it, an annotation
  // carrying a declared second reading parses as malformed here, drops out of the
  // map, and its file stops being watched for the 0.00% partial-report shape.
  const { annotations } = parseMeasuredAnnotations(source, { allowSecondReading });
  const suspects = [];
  for (const key of keys) {
    const annotation = annotations.get(key);
    if (!annotation || Number(annotation.recordedLines) === 0) {
      continue;
    }
    const actual = resolve(key);
    if (actual.status === "ok" && actual.lines === 0) {
      suspects.push(key);
    }
  }
  return suspects;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare one target's annotations with its coverage report.
 *
 * `resolve(key)` returns the measured pair for a floor key. Injected so the pure
 * comparison can be exercised without a coverage run.
 *
 * `allowSecondReading` is per-target and defaults to off, so a target that does not
 * opt in keeps the exact-match rule it always had.
 */
export function compareTarget({
  keys,
  source,
  resolve,
  keyNoun = "floor key",
  allowSecondReading = false,
}) {
  const { annotations, malformed } = parseMeasuredAnnotations(source, { allowSecondReading });
  const problems = [];

  for (const entry of malformed) {
    problems.push({
      kind: "malformed",
      lineNumber: entry.lineNumber,
      message: `line ${entry.lineNumber}: unusable \`// measured\` annotation — ${entry.reason}\n    ${entry.text}`,
    });
  }

  for (const key of keys) {
    const annotation = annotations.get(key);
    if (!annotation) {
      // Without this, the cheapest way to silence a drift report is to delete the
      // comment — which also deletes the only record of where the floor came from.
      problems.push({
        kind: "unannotated",
        key,
        message:
          `${key}: no \`// measured\` annotation on its line. Every ${keyNoun} must record ` +
          "the measurement its floor was derived from, on the same line.",
      });
      continue;
    }

    const actual = resolve(key);
    if (actual.status === "missing") {
      problems.push({
        kind: "no-coverage",
        key,
        lineNumber: annotation.lineNumber,
        message:
          `${key}: annotated \`measured ${describeRecorded(annotation)}\` (line ${annotation.lineNumber}) ` +
          "but the coverage report contains no data for it. Renamed, deleted, or never loaded by a test?",
      });
      continue;
    }
    if (actual.status === "ambiguous") {
      problems.push({
        kind: "ambiguous",
        key,
        lineNumber: annotation.lineNumber,
        message:
          `${key}: matches ${actual.matches.length} reported files (${actual.matches.join(", ")}), ` +
          "so a single recorded measurement cannot describe it. Narrow the pattern.",
      });
      continue;
    }

    if (annotation.zeroBranches && actual.branchesTotal !== null && actual.branchesTotal !== 0) {
      problems.push({
        kind: "drift",
        key,
        lineNumber: annotation.lineNumber,
        message:
          `${key}: annotation claims "(0 branches)" but the file declares ${actual.branchesTotal} branches ` +
          `(measuring ${actual.branches.toFixed(2)}%).`,
      });
      continue;
    }

    if (!annotation.zeroBranches && actual.branches === null) {
      // The gate's own parser reports a missing branch cell as null rather than 0;
      // "cannot verify" must never read as "verified".
      problems.push({
        kind: "no-coverage",
        key,
        lineNumber: annotation.lineNumber,
        message: `${key}: the coverage report carries no branch percentage, so the recorded branch value cannot be verified.`,
      });
      continue;
    }

    const agreed = annotation.zeroBranches
      ? agrees(annotation.recordedLines, actual.lines)
      : agreesWithEither(annotation, actual.lines, actual.branches);
    if (agreed) {
      continue;
    }

    const fix = formatAnnotation({
      lines: actual.lines,
      branches: actual.branches,
      zeroBranches: annotation.zeroBranches,
      alternative: annotation.alternative,
    });
    problems.push({
      kind: "drift",
      key,
      lineNumber: annotation.lineNumber,
      recorded: describeRecorded(annotation),
      actual: describeActual(actual, annotation.zeroBranches),
      fix,
      droppedAlternative:
        annotation.alternative && !fix.includes("(also ")
          ? `${annotation.alternative.recordedLines} / ${annotation.alternative.recordedBranches}`
          : undefined,
    });
  }

  for (const key of annotations.keys()) {
    if (!keys.includes(key)) {
      const annotation = annotations.get(key);
      problems.push({
        kind: "orphan",
        key,
        lineNumber: annotation.lineNumber,
        message:
          `${key}: line ${annotation.lineNumber} records a measurement but is not a ${keyNoun}. ` +
          "A measurement recorded next to nothing gates nothing.",
      });
    }
  }

  return problems;
}

function describeRecorded(annotation) {
  return annotation.zeroBranches
    ? `${annotation.recordedLines} lines (0 branches)`
    : `${annotation.recordedLines} / ${annotation.recordedBranches}`;
}

function describeActual(actual, zeroBranches) {
  return zeroBranches
    ? `${actual.lines.toFixed(2)} lines (0 branches)`
    : `${actual.lines.toFixed(2)} / ${actual.branches.toFixed(2)}`;
}

/**
 * The banner printed above the per-entry failures.
 *
 * "Update each comment to the measured pair shown below" is right whenever the
 * instrument is reproducible, and WRONG on the V8 target when only the percentage
 * moved: overwriting the recorded value there does not remove the flicker, it moves
 * it onto the value you just wrote, and the next run reds on the number you came
 * from. The `droppedAlternative` note further down cannot cover this, because it only
 * fires for an entry that ALREADY declares a second reading — a file flipping for the
 * first time has none. So the recipe is attached to the banner instead, and only when
 * a failing target actually allows the declaration; on a core-only failure the extra
 * paragraph would be advice the gate would then reject.
 *
 * Exported so the wording is a machine-checked contract rather than a string nobody
 * reads until CI is already red.
 */
export function failureBanner(failures) {
  const count = failures.reduce((sum, failure) => sum + failure.problems.length, 0);
  const declarable = failures.some(({ target }) => target.allowSecondReading === true);
  return (
    `coverage-annotations: ${count} recorded measurement(s) no longer match the coverage report.\n` +
    "The `// measured` value beside a floor is what \"headroom\" is computed from, and both\n" +
    "coverage floor audits enforce a maximum headroom against it — a stale annotation makes\n" +
    "that judgement wrong. Update each comment to the measured pair shown below.\n" +
    (declarable
      ? "\nFIRST, for a failure below on a target that allows a declared second reading: diff the\n" +
        "uncovered-LINE column of this report against the previous one BEFORE the percentage.\n" +
        "A moved column is a real branch change — drive it with a test. An identical column with\n" +
        "a moved percentage is V8 range granularity, and the fix is to record BOTH readings\n" +
        "(`// measured <lower L> / <lower B> (also <higher L> / <higher B>: cause)`), not to\n" +
        "overwrite the first — overwriting only moves the flicker to the other value.\n"
      : "")
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cannotJudge(message) {
  console.error(`coverage-annotations: ${message}`);
  process.exit(EXIT_CANNOT_JUDGE);
}

function main() {
  const targets = [coreTarget(), mcpTarget()];
  const failures = [];

  for (const target of targets) {
    if (!fs.existsSync(target.reportPath)) {
      cannotJudge(
        `${target.label}: the ${target.reportLabel} report is missing.\n` +
          `  expected: ${path.relative(REPO_ROOT, target.reportPath)}\n` +
          `  produce it with: ${target.refreshCommand}\n` +
          "  (refusing to report \"no drift\" from a report that does not exist)"
      );
    }

    const newer = findNewerInputs(target.reportPath, target.inputFiles);
    if (newer.length > 0) {
      const shown = newer.slice(0, 5);
      cannotJudge(
        `${target.label}: the ${target.reportLabel} report is STALE — ` +
          `${newer.length} input file(s) changed after it was written, so it no longer describes this tree.\n` +
          `  report: ${path.relative(REPO_ROOT, target.reportPath)}\n` +
          shown.map((file) => `  newer:  ${file}`).join("\n") +
          (newer.length > shown.length ? `\n  ...and ${newer.length - shown.length} more` : "") +
          `\n  refresh it with: ${target.refreshCommand}`
      );
    }

    let resolve;
    try {
      resolve = target.load();
    } catch (error) {
      cannotJudge(
        `${target.label}: could not read ${path.relative(REPO_ROOT, target.reportPath)} — ${error.message}\n` +
          `  regenerate it with: ${target.refreshCommand}`
      );
    }

    const suspects = findPartialReportSuspects({
      keys: target.keys,
      source: target.source,
      resolve,
      allowSecondReading: target.allowSecondReading === true,
    });
    if (suspects.length > 0) {
      const shown = suspects.slice(0, 5);
      cannotJudge(
        `${target.label}: the ${target.reportLabel} report looks PARTIAL — ` +
          `${suspects.length} annotated file(s) measure 0.00% lines against annotations recording real coverage.\n` +
          shown.map((key) => `  suspect: ${key}`).join("\n") +
          (suspects.length > shown.length ? `\n  ...and ${suspects.length - shown.length} more` : "") +
          "\n  A filtered test run overwrites the report with subset numbers (unloaded files appear at 0%),\n" +
          "  and such a report is NEWER than the sources, so the staleness check cannot catch it.\n" +
          `  Re-run the full suite: ${target.refreshCommand}\n` +
          "  (If a file genuinely collapsed to zero, the coverage floor gate is the thing that must go red.)"
      );
    }

    const problems = compareTarget({
      keys: target.keys,
      source: target.source,
      resolve,
      keyNoun: target.keyNoun,
      allowSecondReading: target.allowSecondReading === true,
    });
    if (problems.length > 0) {
      failures.push({ target, problems });
    }
  }

  if (failures.length === 0) {
    const total = targets.reduce((sum, target) => sum + target.keys.length, 0);
    console.log(
      `coverage-annotations: OK — all ${total} recorded \`// measured\` values match the coverage reports ` +
        `(${targets.map((t) => `${t.label}: ${t.keys.length}`).join(", ")}).`
    );
    return;
  }

  console.error(failureBanner(failures));

  for (const { target, problems } of failures) {
    console.error(`${target.annotatedFile}`);
    for (const problem of problems) {
      if (problem.kind !== "drift" || !problem.fix) {
        console.error(`  - ${problem.message}`);
        continue;
      }
      console.error(`  - line ${problem.lineNumber}  ${problem.key}`);
      console.error(`      recorded: ${problem.recorded}`);
      console.error(`      actual:   ${problem.actual}`);
      console.error(`      fix:      ${problem.fix}`);
      if (problem.droppedAlternative) {
        console.error(
          `      note:     the declared second reading ${problem.droppedAlternative} is not carried into the fix — ` +
            "it no longer sits above the measurement.\n" +
            "                Re-declare it only if the flicker is still there; a stale declaration is a tolerance."
        );
      }
    }
    console.error("");
  }

  console.error(
    "Correct the annotations only — do NOT move a floor to match a drifted comment. If a real\n" +
      "measurement dropped below its floor, the coverage gate itself is the thing that must go red."
  );
  process.exit(EXIT_DRIFT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
