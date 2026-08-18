// SPDX-License-Identifier: GPL-3.0-or-later
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The two recognized flags and the option key each writes.
const THRESHOLD_FLAGS = {
  '--line-threshold': 'lineThreshold',
  '--branch-threshold': 'branchThreshold',
};

function parseArgs(argv) {
  const out = {
    lineThreshold: 90,
    // 0 disables the branch gate (kept opt-in for callers that only ratchet lines).
    branchThreshold: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];

    // Accept both `--flag value` and `--flag=value`. Splitting on `=` first means
    // an inline form is recognized rather than treated as an unknown token.
    let flag = item;
    let inlineValue = null;
    if (typeof item === 'string' && item.startsWith('--')) {
      const eq = item.indexOf('=');
      if (eq !== -1) {
        flag = item.slice(0, eq);
        inlineValue = item.slice(eq + 1);
      }
    }

    // A typo in a threshold flag used to be silently ignored, leaving the gate at
    // its default — most dangerously `--branch-threshhold 80` left the branch gate
    // OFF (default 0) with the run still reporting success. Reject every
    // unrecognized token so a misspelled flag fails loudly instead of no-op'ing.
    const optionKey = THRESHOLD_FLAGS[flag];
    if (!optionKey) {
      throw new Error(
        `Unknown argument "${item}". Expected --line-threshold and/or --branch-threshold.`
      );
    }

    let rawValue;
    if (inlineValue !== null) {
      rawValue = inlineValue;
    } else {
      rawValue = argv[i + 1];
      i += 1;
    }

    if (rawValue === undefined || String(rawValue).trim() === '') {
      throw new Error(`Missing value for ${flag}.`);
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${flag}: "${rawValue}".`);
    }
    // A threshold is a percentage; anything outside 0–100 (e.g. a dropped decimal
    // point, `--line-threshold 900`) can never be met or is meaningless.
    if (parsed < 0 || parsed > 100) {
      throw new Error(`Threshold for ${flag} must be between 0 and 100, got ${parsed}.`);
    }
    out[optionKey] = parsed;
  }

  return out;
}

function parseAllFilesLineCoverage(output) {
  const lines = output.split(/\r?\n/);
  const row = lines.find((line) => /^\s*#?\s*all files\s*\|/i.test(line));
  if (!row) {
    return null;
  }

  const normalized = row.replace(/^\s*#\s*/, '');
  const cells = normalized.split('|').map((v) => v.trim());
  if (cells.length < 2) {
    return null;
  }

  const linePct = Number(cells[1]);
  const branchPct = Number(cells[2]);
  return Number.isFinite(linePct)
    ? { linePct, branchPct: Number.isFinite(branchPct) ? branchPct : null }
    : null;
}

// Scope coverage to this package's OWN compiled output (`dist/**`). The test
// suite loads code from sibling workspace packages it depends on at runtime
// (@syncrona/core CLI commands, credential-store, jira, sn-transport); those
// files are exercised — and coverage-gated — by their own package suites, so
// counting their module-load-only lines here would double-count and drag the
// ratio down with code this package does not own. `dist/**` (relative to the
// package root, the gate's cwd) matches only this package's build output;
// sibling packages resolve to `../<pkg>/dist/...` and are excluded.
const COVERAGE_INCLUDE = 'dist/**';

// The directory COVERAGE_INCLUDE scopes to, resolved against the gate's cwd.
const COVERAGE_ROOT = 'dist';

// Where the raw coverage report is persisted after a successful run, relative to
// the gate's cwd (the package root). `coverage/` is gitignored, so this is a build
// artifact and never committed.
//
// It exists so `scripts/check-coverage-annotations.mjs` can verify the
// `// measured L / B` comments in MODULE_FLOORS against the SAME bytes this gate
// just scored, instead of paying for a second full `node --test` run (or, worse,
// inventing a second source of truth that could disagree with this one).
//
// Reading the same bytes is not a nicety here: two `node --test` runs over an
// UNCHANGED tree do not always produce the same percentages (see the note above
// MODULE_FLOORS), so a second run would be a second measurement, not a check of
// this one. Keeping a report from a failed run would be worse still — hence
// removeReportFile() below.
const REPORT_FILE = path.join('coverage', 'coverage-report.txt');

function writeReportFile(output, rootDir = process.cwd()) {
  const target = path.join(rootDir, REPORT_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, 'utf-8');
  return target;
}

// Drop the persisted report when a run does NOT produce a trustworthy one. Without
// this, an aborted or failed run leaves the PREVIOUS run's file on disk, and a
// downstream reader would happily judge today's tree against yesterday's numbers —
// the exact "passes vacuously" failure these gates exist to prevent.
function removeReportFile(rootDir = process.cwd()) {
  fs.rmSync(path.join(rootDir, REPORT_FILE), { force: true });
}

// `toolSchemas` is ~1500 lines of a single top-level declarative object literal
// (the MCP tool schema catalogue). V8's line coverage cannot mark the body of a
// static data literal as executed — even a test that requires the module and
// iterates every entry leaves the literal reported as uncovered (verified:
// 1.9%). It carries no branch/logic to exercise, so excluding this pure-data
// file keeps the "all files" line ratio honest about actual code.
//
// Coverage is measured WITHOUT source maps, i.e. against the emitted `dist/*.js`
// directly, so the ratio reflects real executable lines. Source-mapped `.ts`
// coverage is deflated by non-executable declaration lines (imports, `type`
// aliases, interface bodies) that compile to nothing yet count as "uncovered";
// the raw dist figure is the honest measure of what actually ran. (`.ts` glob
// kept in the exclude list as a harmless guard if source maps are reintroduced.)
const COVERAGE_EXCLUDES = ['**/toolSchemas.ts', '**/toolSchemas.js'];

// Per-file line-coverage floor. The `all files` ratchet is an AGGREGATE: a single
// new file at 0% that IS present in the report (some test imported the module but
// exercised nothing in it) barely moves the aggregate and ships green, which is
// the exact opposite of what a coverage gate is for. This floor scores every
// reported source file on its own, so a present-but-untested file fails even while
// the aggregate stays above its threshold. It stays below the `--line-threshold 90`
// aggregate on purpose: the aggregate raises the ceiling, this is only the floor.
//
// GATE-2: this floor used to be 10, which meant a module could rot from 98% to 11%
// and still ship green because the aggregate absorbed it — `dist/scopeBootstrap.js`
// really did sit at 24.32% under a green gate. Measured 2026-07-30 across all 55
// reported dist modules, the WEAKEST line coverage is 88.17%
// (`semanticIndexState.js`), so 80 leaves ~8pts of headroom for legitimately-thin
// new code while still failing a module that loses a third of its coverage.
//
// REV-213: that module is no longer the weakest — it measures 98.63 now that the
// walk's skip/refusal arms and the in-flight build collapse are pinned. The floor
// stays at 80 because the argument is unchanged, not because the number is: the
// weakest reported module today is `analysis/scopeDiscovery.js` at 90.63, so the
// same ~10pts of headroom still separates a thin file from a collapsing one.
const PER_FILE_LINE_FLOOR = 80;

// Per-file BRANCH floor. Lines alone hide the dangerous regression: deleting the
// guard case of an `if` keeps every line executed by the happy path but drops the
// branch, so a line-only floor cannot see a safety check losing its only negative
// test. Measured 2026-07-30, the weakest reported branch coverage is 55.56%
// (`dist/index.js`, the stdio server bootstrap, whose argv/env branches are
// process-level), so the default sits at 45 to catch collapse rather than to police
// thin files. Modules that must do better carry an explicit MODULE_FLOORS entry.
const PER_FILE_BRANCH_FLOOR = 45;

// Per-module floors for the safety-relevant modules, pinned just under what each
// one MEASURES today (a ratchet, not a cliff). The defaults above are a blunt
// instrument sized for the weakest file in the tree; without these, the modules that
// evaluate policy, validate input, write the audit trail, spawn processes and build
// ServiceNow paths could each shed 10-15 points and still pass every gate.
//
// `pattern` is matched against the report path with the same glob syntax as
// COVERAGE_EXCLUDES. Measured line/branch values are recorded per entry (2026-07-30,
// `node --test --experimental-test-coverage` against dist/, no source maps). Raise a
// floor when coverage rises; never lower one to turn a red build green — that
// regression is exactly what the floor exists to report.
//
// A pattern that matches nothing in the report FAILS the gate (findStaleFloors): a
// floor naming a module that was renamed or deleted is dead weight, and that is how
// a per-file gate quietly stops gating.
//
// Five entries carry a second reading, `// measured L / B (also L / B: cause)`. V8 range
// coverage is not reproducible run-to-run on an unchanged tree: across 45 tables here,
// audit.js reported 92.62% branches 42 times and 92.65% three times, inputValidation.js
// 96.15% 44 times and 96.30% once — with a byte-identical uncovered-line list every time,
// because V8 counted one extra range that was already being executed (226/244 vs 227/245;
// 25/26 vs 26/27). No test can drive a range that is already covered, and both candidate
// V8 flags were A/B tested and refuted, so the second value is DECLARED rather than
// tolerated: exactly those two readings pass the annotations gate and a third is drift.
// The LOWER reading is written first on purpose — the headroom audit in
// test/coverageGatePerFile.test.js parses the first pair and ignores the rest, so the
// floor is still checked against the conservative measurement.
//
// REV-213 raised three floors that had drifted 4-8 points below what their module
// measures (processRunner, healthServer, safetyPolicy's branch floor); the measured
// pairs beside them did not move, only the floors did. Each new floor sits 2.6-3.9
// points under its measurement rather than flush against it, and the reason is the CI
// matrix: these numbers were measured on macOS and the gate also runs on
// ubuntu-latest. When REV-213 landed, every entry in this table was annotation-exact
// on BOTH runners; `semanticIndexState.js` has since become the first entry where the
// platforms split — ubuntu counts two branch ranges that darwin never reports (65/69
// against 63/67, with a byte-identical uncovered-line list), so its ubuntu reading is
// declared below exactly like the run-to-run flickers. `servicenowCore.js` is the
// second, and it split on a commit that touched neither the module nor its tests: the
// same +2/+2 shape (265/289 against 263/287), the same byte-identical uncovered-line
// list, and one extra function range on top (62/64 against 61/64). Two entries is no
// longer an outlier — assume any entry can split. Agreement observed is not
// agreement guaranteed, and a floor set flush turns the first one-branch difference
// into a red build on a platform the author never ran. Three points is roughly one
// branch in a 30-branch module: enough to absorb a granularity difference, far too
// little to hide a test being deleted.
//
// The same pass then added the three entries in the last group below. Those modules had
// NO named floor at all, so they were scored only by the 80/45 defaults — `runtimeConfig`
// could have shed 42 branch points and still passed. They are sized by the same rule
// (2.6-3.9 points under measurement) and for the same reason, which bites hardest here:
// `runtimeConfig` resolves the package version by walking up from `__dirname`, and
// `metricsStore` is all filesystem, so these two are exactly the kind of module whose
// branch count can differ between the macOS and ubuntu-latest legs of the matrix.
const MODULE_FLOORS = [
  // Guardrail evaluation and the mutating-tool policy: the fail-closed paths here
  // are the difference between a blocked and an executed write.
  { pattern: 'dist/safetyPolicy.js', line: 97, branch: 96 }, // measured 99.74 / 98.64
  { pattern: 'dist/policyConfig.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
  { pattern: 'dist/createTablePolicy.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
  { pattern: 'dist/endpointPolicy.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
  // Input validation is the injection/traversal boundary for every tool argument.
  { pattern: 'dist/inputValidation.js', line: 97, branch: 93 }, // measured 99.30 / 96.15 (also 99.30 / 96.30: V8 range granularity, 25/26 vs 26/27 branches, same uncovered lines)
  // The audit trail is the tamper-evident record; a lost branch here is an event
  // that silently is not written.
  // WP-M1 moved the secret-detection helpers out to @syncrona/redaction (-117
  // lines, all of them fully covered), so both percentages fell without a single
  // branch going untested: the denominators shrank. The declared second reading
  // that used to sit here (96.83 / 92.65, 226/244 vs 227/245) is deliberately NOT
  // carried forward — it was evidence about a file that no longer exists, and a
  // stale declaration is just a tolerance. If the V8 flicker reappears on this
  // file, re-declare it from a fresh pair of readings.
  { pattern: 'dist/audit.js', line: 94, branch: 88 }, // measured 96.74 / 92.17
  // Preflight, dry-run and the mutating-tool wrappers.
  // The declared reading here runs the other way: 92.05 is what 61 of 62 runs print,
  // and the odd one is LOWER. An extra range appeared that was NOT executing, so the
  // denominator grew alone. The grammar still wants the lower value first, which is
  // why the number you will almost always measure is the one in parentheses.
  { pattern: 'dist/toolService.js', line: 90, branch: 87 }, // measured 92.60 / 91.53 (also 92.60 / 92.05: V8 range granularity, 162/177 vs 162/176 branches, same uncovered lines; 162/176 measured from raw V8 data, the 177 denominator is the only pair within +-12 on both counters that renders 91.53)
  { pattern: 'dist/toolDispatch.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
  { pattern: 'dist/toolModules.js', line: 87, branch: 91 }, // measured 90.22 / 95.65
  // Transport and scope handling: a scope code reaches both a ServiceNow URL and a
  // local filesystem path.
  // Both readings moved UP together (98.50 -> 99.05 line, 91.64 -> 93.49 branch):
  // newly covered branches, not a granularity flicker. The old declared pair
  // (98.50 / 91.70) now sits BELOW the measurement, so per the checker's own rule
  // it is dropped rather than carried — a second reading under the first is a
  // tolerance, not a declaration.
  //
  // Dropping it does NOT mean the split went away, and the next author should not
  // read its absence as agreement. This is the entry the header block calls the
  // second splitter: darwin printed 263/287 branch ranges where ubuntu printed
  // 265/289 — same uncovered-line list, plus one extra covered function range.
  // Nothing here fixed that; the module simply gained coverage, which re-based both
  // counters and made the ubuntu pair evidence about ranges that no longer exist.
  // Expect the ubuntu leg to land one notch above 93.49 again. That is the known
  // split, NOT drift: re-declare it from that leg's own report in this table's
  // grammar (`(also <line> / <branch>: cause)`, lower reading first) rather than
  // loosening the floor. The value is deliberately left unpredicted — every other
  // declared pair here was measured on the runner that printed it, and a computed
  // guess wearing the word `measured` is the single thing these annotations exist
  // to prevent.
  { pattern: 'dist/servicenowCore.js', line: 96, branch: 88 }, // measured 99.05 / 93.49
  { pattern: 'dist/scopePaths.js', line: 99, branch: 92 }, // measured 100.00 / 95.00
  { pattern: 'dist/scopeBootstrap.js', line: 96, branch: 90 }, // measured 98.65 / 93.18
  { pattern: 'dist/sessionContext.js', line: 96, branch: 89 }, // measured 99.03 / 92.75
  // A single reading, not a declared pair: the move from 99.04 was a source edit,
  // not range flicker. `wrapUntrustedData` gained seven comment lines explaining why
  // its zero-width space is written as `\u200b`, tsc emits comments, and seven more
  // covered lines under one unchanged uncovered line (17, `trimOutput`'s truncation
  // arm) is exactly 103/104 -> 110/111. Branch coverage did not move at all, which is
  // what a comment-only change should do.
  { pattern: 'dist/runtimeUtils.js', line: 96, branch: 73 }, // measured 99.10 / 77.27
  // Anything that starts a process or a listener, plus the handlers that actually
  // mutate the instance.
  { pattern: 'dist/processRunner.js', line: 95, branch: 88 }, // measured 98.08 / 91.89
  { pattern: 'dist/gracefulShutdown.js', line: 95, branch: 95 }, // measured 100.00 / 100.00
  { pattern: 'dist/healthServer.js', line: 97, branch: 66 }, // measured 100.00 / 69.70
  { pattern: 'dist/handlers/serviceNowCrudHandlers.js', line: 96, branch: 95 }, // measured 100.00 / 100.00
  // REV-213: process-lifetime state and on-disk telemetry. None of these three had a
  // named floor before, and each just rose a long way — the semantic index cache from
  // 88.17 once the walk's refusal arms were pinned, the metrics store from 93.01/82.93
  // once its prune's two load-bearing catches were driven on purpose. A module that
  // jumps and is not pinned can fall back just as far under the defaults.
  { pattern: 'dist/semanticIndexState.js', line: 96, branch: 91 }, // measured 98.63 / 94.03 (also 98.63 / 94.20: V8 range granularity, 63/67 vs 65/69 branches, same uncovered lines; darwin prints 63/67 under Node 22.23.0 and 22.23.2 alike, and 65/69 is the only pair within +-12 of both counters that renders the ubuntu 94.20)
  { pattern: 'dist/runtimeConfig.js', line: 97, branch: 84 }, // measured 100.00 / 87.50
  { pattern: 'dist/metricsStore.js', line: 96, branch: 89 }, // measured 98.77 / 92.86
];

// `--test-coverage-include` only FILTERS the modules the run actually loaded; V8
// reports coverage for scripts it saw execute. A dist module that no test ever
// imports is therefore absent from the report entirely — it cannot lower the
// "all files" ratio and cannot fail this gate. Left alone, a module with zero
// tests is invisible rather than scored 0%, which is the exact opposite of what
// a coverage gate is for (verified: a 2-function module no test imports leaves
// "all files" reading 100.00%).
//
// So the reported set is diffed against what is actually on disk, and any owned
// module missing from the report fails the gate. The report is a TREE (one space
// of indent per level, directory rows carry empty percentage cells), not a list
// of paths, so the paths are reconstructed with an indent stack.
const REPORT_START_REGEX = /^\s*#?\s*start of coverage report\s*$/i;
const REPORT_END_REGEX = /^\s*#?\s*end of coverage report\s*$/i;

function parseReportedFiles(output) {
  const files = new Set();
  const stack = [];
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (REPORT_START_REGEX.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (REPORT_END_REGEX.test(line)) {
      break;
    }
    // Drop the TAP comment marker only; the spaces after it encode the depth.
    const body = line.replace(/^\s*#/, '');
    if (!body.includes('|')) {
      continue;
    }
    const cells = body.split('|');
    const label = cells[0];
    const name = label.trim();
    if (name === '' || /^-+$/.test(name) || /^all files$/i.test(name)) {
      continue;
    }
    if (name === 'file' && /line\s*%/i.test(cells[1] || '')) {
      continue;
    }
    const depth = label.length - label.trimStart().length - 1;
    if (depth < 0) {
      continue;
    }
    stack.length = depth;
    stack.push(name);
    // A directory row leaves the line% cell blank; only file rows carry numbers.
    // `Number('')` is 0 and finite, so the emptiness must be tested first.
    const linePct = (cells[1] || '').trim();
    if (linePct !== '' && Number.isFinite(Number(linePct))) {
      files.add(stack.join('/'));
    }
  }
  return files;
}

// Per-file coverage as an array of { file, linePct, branchPct }, reconstructed from
// the SAME indented TAP tree parseReportedFiles walks: one space of indent per depth
// level, directory rows carry a blank line% cell (skipped), only file rows carry a
// finite number. Kept separate from parseReportedFiles because that returns a Set
// of paths for the unreported-module diff, whereas this must retain the percentages.
//
// branchPct is null when the cell is missing or unparseable rather than 0: a missing
// cell is a REPORT-FORMAT problem, and scoring it 0 would fail every file for the
// wrong reason. Callers that enforce a branch floor treat null as a parse failure
// (fail closed) instead of silently skipping the check.
function parsePerFileCoverage(output) {
  const files = [];
  const stack = [];
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (REPORT_START_REGEX.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (REPORT_END_REGEX.test(line)) {
      break;
    }
    const body = line.replace(/^\s*#/, '');
    if (!body.includes('|')) {
      continue;
    }
    const cells = body.split('|');
    const label = cells[0];
    const name = label.trim();
    if (name === '' || /^-+$/.test(name) || /^all files$/i.test(name)) {
      continue;
    }
    if (name === 'file' && /line\s*%/i.test(cells[1] || '')) {
      continue;
    }
    const depth = label.length - label.trimStart().length - 1;
    if (depth < 0) {
      continue;
    }
    stack.length = depth;
    stack.push(name);
    // A directory row leaves the line% cell blank; `Number('')` is a finite 0, so
    // the emptiness must be tested first or every directory would score 0%.
    const linePct = (cells[1] || '').trim();
    if (linePct !== '' && Number.isFinite(Number(linePct))) {
      const branchCell = (cells[2] || '').trim();
      files.push({
        file: stack.join('/'),
        linePct: Number(linePct),
        branchPct:
          branchCell !== '' && Number.isFinite(Number(branchCell)) ? Number(branchCell) : null,
      });
    }
  }
  return files;
}

// Line-only view of the report, kept as the shape the per-file gate was originally
// built on (and asserted by coverageGatePerFile.test.js).
function parsePerFileLineCoverage(output) {
  return parsePerFileCoverage(output).map(({ file, linePct }) => ({ file, linePct }));
}

// Reported files, minus the ones the aggregate itself does not count. Honoring
// COVERAGE_EXCLUDES here means no floor can ever fail on a file that was
// deliberately excluded from the ratio.
function coveredReportRows(output) {
  const excludes = COVERAGE_EXCLUDES.map(globToRegExp);
  return parsePerFileCoverage(output).filter(({ file }) => !excludes.some((re) => re.test(file)));
}

// The floors that apply to one reported file: its MODULE_FLOORS entry if it has one,
// otherwise the defaults. A file matched by several patterns takes the STRICTEST of
// each metric, so an overlapping glob can only tighten a floor, never relax it.
function resolveFloorsFor(file, moduleFloors = MODULE_FLOORS, defaults = {}) {
  const defaultLine = defaults.line === undefined ? PER_FILE_LINE_FLOOR : defaults.line;
  const defaultBranch = defaults.branch === undefined ? PER_FILE_BRANCH_FLOOR : defaults.branch;
  let line = defaultLine;
  let branch = defaultBranch;
  let matched = null;
  for (const entry of moduleFloors) {
    if (!globToRegExp(entry.pattern).test(file)) {
      continue;
    }
    matched = matched === null ? entry.pattern : `${matched}, ${entry.pattern}`;
    if (typeof entry.line === 'number') {
      line = Math.max(line, entry.line);
    }
    if (typeof entry.branch === 'number') {
      branch = Math.max(branch, entry.branch);
    }
  }
  return { line, branch, pattern: matched };
}

// Every reported file that misses a floor, one row per FILE listing which metrics
// failed. `reasons` carries a ready-to-print explanation so the CLI message can name
// the file, the measured value, the floor it missed and where that floor came from.
function findFloorViolations(output, options = {}) {
  const moduleFloors = options.moduleFloors === undefined ? MODULE_FLOORS : options.moduleFloors;
  const violations = [];

  for (const row of coveredReportRows(output)) {
    const floors = resolveFloorsFor(row.file, moduleFloors, options.defaults);
    const source = floors.pattern === null ? 'default floor' : `floor for ${floors.pattern}`;
    const reasons = [];

    if (floors.line > 0 && row.linePct < floors.line) {
      reasons.push(
        `line ${row.linePct.toFixed(2)}% < ${floors.line.toFixed(2)}% (${source})`
      );
    }
    if (floors.branch > 0) {
      if (row.branchPct === null) {
        // Fail closed: an unparseable branch cell means the gate cannot verify the
        // floor, and "cannot verify" must never read as "passed".
        reasons.push(`branch % missing from the report, cannot verify ${source}`);
      } else if (row.branchPct < floors.branch) {
        reasons.push(
          `branch ${row.branchPct.toFixed(2)}% < ${floors.branch.toFixed(2)}% (${source})`
        );
      }
    }

    if (reasons.length > 0) {
      violations.push({ ...row, lineFloor: floors.line, branchFloor: floors.branch, reasons });
    }
  }

  return violations;
}

// MODULE_FLOORS entries that match no reported file. A floor on a module that was
// renamed, split or deleted keeps passing forever while protecting nothing, so the
// stale entry itself is a gate failure — the table has to stay honest about the tree.
function findStaleFloors(output, moduleFloors = MODULE_FLOORS) {
  const rows = coveredReportRows(output);
  return moduleFloors
    .filter((entry) => {
      const re = globToRegExp(entry.pattern);
      return !rows.some(({ file }) => re.test(file));
    })
    .map((entry) => entry.pattern);
}

// Reported source files scoring below the per-file LINE floor. Retained as the
// narrow, line-only primitive (main() uses findFloorViolations, which also applies
// branch floors and the per-module table).
function findFilesBelowFloor(output, floor = PER_FILE_LINE_FLOOR) {
  return findFloorViolations(output, {
    moduleFloors: [],
    defaults: { line: floor, branch: 0 },
  }).map(({ file, linePct }) => ({ file, linePct }));
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// A `.ts` file that exports only types compiles to a stub with no executable
// body — no statement, so nothing for V8 to report and no importer to load it.
// Its absence from the report proves nothing, so it is not a coverage hole. A
// module with real code always has a body left after this strip and is reported
// as missing, which is the failure mode this check exists to produce.
function isTypeOnlyEmit(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/["']use strict["'];?/g, '')
    .replace(/Object\.defineProperty\(\s*exports\s*,\s*["']__esModule["']\s*,\s*\{[^}]*\}\s*\)\s*;?/g, '')
    .replace(/exports\.__esModule\s*=\s*(?:true|!0)\s*;?/g, '')
    .trim();
  return stripped === '';
}

// Every `.js` under dist/ that the include glob covers and no exclude removes.
function listCoverageCandidates(rootDir) {
  const base = path.join(rootDir, COVERAGE_ROOT);
  if (!fs.existsSync(base)) {
    return [];
  }
  const excludes = COVERAGE_EXCLUDES.map(globToRegExp);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        if (!excludes.some((re) => re.test(rel))) {
          found.push(rel);
        }
      }
    }
  };
  walk(base);
  return found;
}

// Owned modules the report never mentioned, i.e. modules no test loaded.
function findUnreportedModules(output, rootDir) {
  const reported = parseReportedFiles(output);
  const candidates = listCoverageCandidates(rootDir);
  return candidates.filter((rel) => {
    if (reported.has(rel)) {
      return false;
    }
    let source;
    try {
      source = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
    } catch {
      return true;
    }
    return !isTypeOnlyEmit(source);
  });
}

// Enumerate the test files in JS rather than leaning on a shell to expand
// `test/*.test.js`. The child is spawned with `shell: false`, so the coverage
// include/exclude GLOBS reach Node verbatim (Node matches them internally); a
// shell would otherwise expand `dist/**` against the filesystem and shatter the
// single include argument into dozens of stray positional paths.
function listTestFiles() {
  const testDir = path.join(process.cwd(), 'test');
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('test', name));
}

function runCoverage() {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-include',
      COVERAGE_INCLUDE,
      ...COVERAGE_EXCLUDES.flatMap((glob) => ['--test-coverage-exclude', glob]),
      ...listTestFiles(),
    ],
    {
      encoding: 'utf-8',
      shell: false,
      stdio: 'pipe',
    }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = `${stdout}\n${stderr}`;

  // A run killed by a signal (e.g. OOM, timeout) reports status=null; the old
  // `status || 0` collapsed that to 0 and treated the kill as success, letting
  // an aborted test run pass the gate. Surface signal deaths and a null status
  // as a non-zero failure so the coverage gate cannot be silently bypassed.
  if (result.error) {
    return { exitCode: 1, output: `${combined}\nCoverage runner error: ${result.error.message}` };
  }
  if (result.signal) {
    return { exitCode: 1, output: `${combined}\nCoverage run terminated by signal ${result.signal}.` };
  }
  if (result.status === null || result.status === undefined) {
    return { exitCode: 1, output: `${combined}\nCoverage run ended with no exit status.` };
  }

  return {
    exitCode: result.status,
    output: combined,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Coverage gate: ${error.message}`);
    process.exit(1);
    return;
  }
  const run = runCoverage();

  process.stdout.write(run.output);

  if (run.exitCode !== 0) {
    removeReportFile();
    console.error('Coverage run failed before threshold check.');
    process.exit(run.exitCode);
  }

  // Persisted BEFORE the floor checks on purpose: when a floor fails, the report is
  // still the freshest true measurement of the tree, and that is exactly when
  // someone needs `npm run test:coverage:annotations` to tell them which recorded
  // numbers to correct.
  writeReportFile(run.output);

  // Run this BEFORE the ratio checks: an untested module is absent from the
  // report rather than scored, so "all files" can read 100% while real code has
  // no test at all. The ratio cannot speak for modules it never saw.
  const unreported = findUnreportedModules(run.output, process.cwd());
  if (unreported.length > 0) {
    console.error(
      `Coverage gate failed: ${unreported.length} module(s) under ${COVERAGE_ROOT}/ were never ` +
        'loaded by any test, so they carry no coverage at all:'
    );
    for (const rel of unreported) {
      console.error(`- ${rel}`);
    }
    console.error(
      'Add a test that exercises each module, or exclude it deliberately via COVERAGE_EXCLUDES ' +
        'with a stated reason.'
    );
    process.exit(1);
  }

  // A stale floor is checked FIRST: if MODULE_FLOORS names a module that no longer
  // exists, every later verdict about that module is meaningless, and the table has
  // to be corrected before its results can be trusted.
  const staleFloors = findStaleFloors(run.output);
  if (staleFloors.length > 0) {
    console.error(
      `Coverage gate failed: ${staleFloors.length} MODULE_FLOORS pattern(s) match no file in the ` +
        'coverage report, so they gate nothing:'
    );
    for (const pattern of staleFloors) {
      console.error(`- ${pattern}`);
    }
    console.error(
      'Point each pattern at the module it was meant to protect (renamed? split?), or delete the ' +
        'entry with a stated reason.'
    );
    process.exit(1);
  }

  // Per-file floors, checked BEFORE the aggregate: a single module's regression is
  // invisible to the `all files` ratio, so the aggregate can read 90%+ while a
  // specific module has lost a third of its coverage — or has no real test at all.
  const violations = findFloorViolations(run.output);
  if (violations.length > 0) {
    console.error(
      `Coverage gate failed: ${violations.length} file(s) under ${COVERAGE_ROOT}/ are below their ` +
        `per-file floor (defaults: line ${PER_FILE_LINE_FLOOR.toFixed(2)}%, branch ` +
        `${PER_FILE_BRANCH_FLOOR.toFixed(2)}%):`
    );
    for (const { file, reasons } of violations) {
      console.error(`- ${file}: ${reasons.join('; ')}`);
    }
    console.error(
      'Add tests that cover the lost lines/branches in each file. A floor may only be lowered ' +
        'with a stated reason, and never to make a red build green.'
    );
    process.exit(1);
  }

  const coverage = parseAllFilesLineCoverage(run.output);
  if (coverage === null) {
    console.error('Could not parse all files line coverage from report.');
    process.exit(1);
  }
  const lineCoverage = coverage.linePct;

  if (args.branchThreshold > 0) {
    if (coverage.branchPct === null) {
      console.error('Could not parse all files branch coverage from report.');
      process.exit(1);
    }
    if (coverage.branchPct < args.branchThreshold) {
      console.error(
        `Coverage gate failed: all files branch coverage ${coverage.branchPct.toFixed(2)}% < ${args.branchThreshold.toFixed(2)}%`
      );
      process.exit(1);
    }
    console.log(
      `Branch coverage gate passed: ${coverage.branchPct.toFixed(2)}% >= ${args.branchThreshold.toFixed(2)}%`
    );
  }

  if (lineCoverage < args.lineThreshold) {
    console.error(
      `Coverage gate failed: all files line coverage ${lineCoverage.toFixed(2)}% < ${args.lineThreshold.toFixed(2)}%`
    );
    process.exit(1);
  }

  console.log(
    `Coverage gate passed: all files line coverage ${lineCoverage.toFixed(2)}% >= ${args.lineThreshold.toFixed(2)}%`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseAllFilesLineCoverage,
  parseReportedFiles,
  parsePerFileCoverage,
  parsePerFileLineCoverage,
  coveredReportRows,
  resolveFloorsFor,
  findFloorViolations,
  findStaleFloors,
  findFilesBelowFloor,
  listCoverageCandidates,
  findUnreportedModules,
  isTypeOnlyEmit,
  globToRegExp,
  writeReportFile,
  removeReportFile,
  REPORT_FILE,
  MODULE_FLOORS,
  PER_FILE_LINE_FLOOR,
  PER_FILE_BRANCH_FLOOR,
};
