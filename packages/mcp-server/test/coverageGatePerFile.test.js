// SPDX-License-Identifier: GPL-3.0-or-later
//
// GATE-1 (REV-95): the coverage gate's `all files` ratchet is an AGGREGATE. A
// single source file at ~0% that IS present in the report (a test imported the
// module but exercised nothing in it) barely moves the aggregate and ships green,
// which is the exact opposite of what a coverage gate is for. The per-file floor
// scores every reported source file on its own so a present-but-untested file
// fails even while the aggregate stays above its threshold.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  parsePerFileCoverage,
  parsePerFileLineCoverage,
  resolveFloorsFor,
  findFloorViolations,
  findStaleFloors,
  findFilesBelowFloor,
  listCoverageCandidates,
  globToRegExp,
  MODULE_FLOORS,
  PER_FILE_LINE_FLOOR,
  PER_FILE_BRANCH_FLOOR,
} = require('../scripts/check-coverage-gate.js');

// REV-213: the fixtures below trip a real MODULE_FLOORS entry, and the floor they
// trip is READ from the table instead of typed into the assertion. Raising a floor
// is the routine, expected event here — the table is a ratchet — and a hardcoded
// "< 94.00%" turns every raise into a red test in a file that has nothing to do with
// the module being raised. That is what happened: three floors went up and this was
// the only thing that objected. Each fixture also asserts its own percentage is
// still below the floor, so a future raise past the fixture value fails loudly
// rather than quietly testing nothing.
function floorFor(pattern) {
  const entry = MODULE_FLOORS.find((candidate) => candidate.pattern === pattern);
  assert.ok(entry, `${pattern} must still be in MODULE_FLOORS for this fixture to mean anything`);
  return entry;
}

// The same indented TAP tree the coverage runner emits: one space of indent per
// depth level, directory rows carry blank percentage cells, the `all files`
// summary row is an aggregate, not a file.
const CLEAN_REPORT = [
  '# start of coverage report',
  '# --------------------------------------------------------------',
  '# file          | line % | branch % | funcs % | uncovered lines',
  '# --------------------------------------------------------------',
  '# dist          |        |          |         | ',
  '#  a.js         | 100.00 |    66.67 |  100.00 | ',
  '#  handlers     |        |          |         | ',
  '#   deep.js     |  92.50 |    66.67 |  100.00 | ',
  '# --------------------------------------------------------------',
  '# all files     |  95.00 |    71.43 |  100.00 | ',
  '# --------------------------------------------------------------',
  '# end of coverage report',
].join('\n');

test('parsePerFileLineCoverage flattens the report tree into { file, linePct } rows', () => {
  assert.deepEqual(parsePerFileLineCoverage(CLEAN_REPORT), [
    { file: 'dist/a.js', linePct: 100 },
    { file: 'dist/handlers/deep.js', linePct: 92.5 },
  ]);
});

test('parsePerFileLineCoverage ignores directory rows and the all-files summary', () => {
  const rows = parsePerFileLineCoverage(CLEAN_REPORT);
  const names = rows.map((r) => r.file);
  assert.ok(!names.includes('dist'), 'a directory row carries a blank line% cell and is not a file');
  assert.ok(!names.includes('dist/handlers'), 'a nested directory row is not a file');
  assert.ok(!names.includes('all files'), 'the aggregate summary is not a file');
});

test('findFilesBelowFloor passes a report whose every file clears the floor', () => {
  // Both files (100% and 92.5%) are far above the per-file floor.
  assert.deepEqual(findFilesBelowFloor(CLEAN_REPORT), []);
});

test('findFilesBelowFloor flags a file present in the report but effectively untested', () => {
  // `ghost.js` is IN the report at 0% — invisible to the `all files` aggregate,
  // which still reads a healthy 92% — yet has no real test at all.
  const report = [
    '# start of coverage report',
    '# file          | line % | branch % | funcs % | uncovered lines',
    '# dist          |        |          |         | ',
    '#  a.js         | 100.00 |    66.67 |  100.00 | ',
    '#  ghost.js     |   0.00 |     0.00 |    0.00 | 1-40',
    '# all files     |  92.00 |    71.43 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(
    findFilesBelowFloor(report),
    [{ file: 'dist/ghost.js', linePct: 0 }],
    'a ~0% file that the aggregate hides must fail on its own'
  );
});

test('findFilesBelowFloor honors COVERAGE_EXCLUDES (the pure-data schema literal)', () => {
  // `toolSchemas.js` is a ~1500-line static data literal V8 cannot mark executed
  // (verified 1.9%); it is excluded from the aggregate, so the floor must not fail
  // on it either — otherwise the excludes would be meaningless.
  const report = [
    '# start of coverage report',
    '# file            | line % | branch % | funcs % | uncovered lines',
    '# dist            |        |          |         | ',
    '#  a.js           | 100.00 |    66.67 |  100.00 | ',
    '#  toolSchemas.js |   1.90 |     0.00 |    0.00 | 1-1500',
    '# all files       |  95.00 |    71.43 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(
    findFilesBelowFloor(report),
    [],
    'a deliberately excluded file cannot fail the per-file floor'
  );
});

test('findFilesBelowFloor accepts a caller-supplied floor', () => {
  // The default floor catches ~0% files; a caller may tighten it. At a floor of
  // 95 the 92.5% file falls below while the 100% file clears.
  assert.deepEqual(findFilesBelowFloor(CLEAN_REPORT, 95), [
    { file: 'dist/handlers/deep.js', linePct: 92.5 },
  ]);
});

test('the per-file floor stays well below the aggregate line ratchet', () => {
  // It is a floor that catches untested files, not a second aggregate ratchet:
  // it must never approach the `--line-threshold 90` global gate, or it would
  // start failing legitimately-thin-but-tested files.
  assert.ok(PER_FILE_LINE_FLOOR > 0, 'a floor of 0 would catch nothing');
  assert.ok(
    PER_FILE_LINE_FLOOR < 90,
    'the floor must sit well under the 90% aggregate so it only catches ~0% files'
  );
});

// --- GATE-2: per-module floors and the branch floor ---------------------------
//
// A single default floor is still an average in disguise: it has to be sized for the
// weakest file in the tree, so the modules that matter most (policy, validation,
// audit, transport) may shed 10-15 points and stay green. MODULE_FLOORS pins those
// to what they measure today, and the branch floor catches the regression a line
// floor structurally cannot see — a deleted guard whose lines the happy path still
// executes.

test('parsePerFileCoverage keeps the branch cell, and nulls it when unparseable', () => {
  const report = [
    '# start of coverage report',
    '# file      | line % | branch % | funcs % | uncovered lines',
    '# dist      |        |          |         | ',
    '#  a.js     | 100.00 |    66.67 |  100.00 | ',
    '#  odd.js   |  90.00 |          |  100.00 | ',
    '# all files |  95.00 |    66.67 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(parsePerFileCoverage(report), [
    { file: 'dist/a.js', linePct: 100, branchPct: 66.67 },
    // A blank cell must NOT read as 0%: that would fail the file for a report-format
    // problem rather than for a coverage one.
    { file: 'dist/odd.js', linePct: 90, branchPct: null },
  ]);
  // The line-only view is still exactly the old shape its own callers expect.
  assert.deepEqual(parsePerFileLineCoverage(report), [
    { file: 'dist/a.js', linePct: 100 },
    { file: 'dist/odd.js', linePct: 90 },
  ]);
});

test('resolveFloorsFor falls back to the defaults for an unlisted module', () => {
  const floors = resolveFloorsFor('dist/analysis/semantic.js', MODULE_FLOORS);
  assert.equal(floors.line, PER_FILE_LINE_FLOOR);
  assert.equal(floors.branch, PER_FILE_BRANCH_FLOOR);
  assert.equal(floors.pattern, null, 'no module entry matched, so nothing to name');
});

test('resolveFloorsFor applies the module floor and names the pattern', () => {
  const floors = resolveFloorsFor('dist/safetyPolicy.js', MODULE_FLOORS);
  assert.equal(floors.pattern, 'dist/safetyPolicy.js');
  assert.ok(
    floors.line > PER_FILE_LINE_FLOOR && floors.branch > PER_FILE_BRANCH_FLOOR,
    'a safety-relevant module must be held to more than the tree-wide default'
  );
});

test('overlapping floor patterns tighten, never relax', () => {
  // Two patterns match the same file with different values. Taking the strictest of
  // each metric means adding a broad `dist/**` entry can only raise the bar; a `max`
  // the other way round would let a loose glob silently undo a specific floor.
  const floors = resolveFloorsFor(
    'dist/audit.js',
    [
      { pattern: 'dist/*.js', line: 70, branch: 95 },
      { pattern: 'dist/audit.js', line: 94, branch: 88 },
    ],
    { line: 0, branch: 0 }
  );
  assert.equal(floors.line, 94);
  assert.equal(floors.branch, 95);
});

test('a module regression fails on its own while the aggregate stays green', () => {
  // audit.js drops from its measured 96.33% to 84% — well above the tree-wide
  // default of 80 — and `all files` still reads a healthy 96.10%. Only the module
  // floor can see it, and the message must name the file, the value and the floor.
  const report = [
    '# start of coverage report',
    '# file           | line % | branch % | funcs % | uncovered lines',
    '# dist           |        |          |         | ',
    '#  audit.js      |  84.00 |    91.74 |  100.00 | 40-70',
    '#  toolDispatch.js | 100.00 |  100.00 |  100.00 | ',
    '# all files      |  96.10 |    98.00 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  const violations = findFloorViolations(report);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'dist/audit.js');
  const auditLineFloor = floorFor('dist/audit.js').line;
  assert.ok(auditLineFloor > 84, 'the fixture must sit below the floor it is meant to trip');
  assert.match(
    violations[0].reasons.join(' '),
    new RegExp(`line 84\\.00% < ${auditLineFloor.toFixed(2)}%`)
  );
  assert.match(violations[0].reasons.join(' '), /floor for dist\/audit\.js/);
  assert.ok(
    violations[0].linePct > PER_FILE_LINE_FLOOR,
    'the point of the module floor: the default would have waved this through'
  );
});

test('a deleted guard is caught by the branch floor with lines still at 100%', () => {
  // Removing the negative case of an `if` leaves every line executed by the happy
  // path, so line coverage is untouched at 100% while the branch is gone. This is the
  // regression a line-only floor structurally cannot report.
  const report = [
    '# start of coverage report',
    '# file             | line % | branch % | funcs % | uncovered lines',
    '# dist             |        |          |         | ',
    '#  safetyPolicy.js | 100.00 |    71.00 |  100.00 | ',
    '# all files        | 100.00 |    71.00 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  const violations = findFloorViolations(report);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'dist/safetyPolicy.js');
  assert.equal(violations[0].linePct, 100);
  const safetyBranchFloor = floorFor('dist/safetyPolicy.js').branch;
  assert.ok(safetyBranchFloor > 71, 'the fixture must sit below the floor it is meant to trip');
  assert.match(
    violations[0].reasons.join(' '),
    new RegExp(`branch 71\\.00% < ${safetyBranchFloor.toFixed(2)}%`)
  );
});

test('an unverifiable branch cell fails closed instead of passing', () => {
  // The gate cannot check a floor it cannot read. "Cannot verify" must never be
  // reported as "passed", so a blank branch cell on a floored module is a failure.
  const report = [
    '# start of coverage report',
    '# file             | line % | branch % | funcs % | uncovered lines',
    '# dist             |        |          |         | ',
    '#  safetyPolicy.js | 100.00 |          |  100.00 | ',
    '# all files        | 100.00 |          |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  const violations = findFloorViolations(report);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reasons.join(' '), /branch % missing from the report/);
});

test('findFloorViolations honors COVERAGE_EXCLUDES like the aggregate does', () => {
  // The excluded pure-data schema literal is not counted by the aggregate, so no
  // floor may fail on it either — otherwise the exclusion would be meaningless.
  const report = [
    '# start of coverage report',
    '# file            | line % | branch % | funcs % | uncovered lines',
    '# dist            |        |          |         | ',
    '#  toolSchemas.js |   1.90 |     0.00 |    0.00 | 1-1500',
    '# all files       |   1.90 |     0.00 |    0.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(findFloorViolations(report), []);
});

test('findStaleFloors reports a floor whose module is no longer in the report', () => {
  // A floor on a renamed or deleted module passes forever while protecting nothing,
  // which is how a per-file gate quietly stops gating.
  const report = [
    '# start of coverage report',
    '# file        | line % | branch % | funcs % | uncovered lines',
    '# dist        |        |          |         | ',
    '#  renamed.js | 100.00 |   100.00 |  100.00 | ',
    '# all files   | 100.00 |   100.00 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(findStaleFloors(report, [{ pattern: 'dist/audit.js', line: 94, branch: 88 }]), [
    'dist/audit.js',
  ]);
  assert.deepEqual(
    findStaleFloors(report, [{ pattern: 'dist/renamed.js', line: 90, branch: 90 }]),
    [],
    'a pattern that matches a reported file is live, not stale'
  );
});

test('every MODULE_FLOORS pattern matches a module that exists on disk', () => {
  // The same staleness check the gate performs at runtime, done here against the
  // built tree so a rename is reported by the unit suite too, not only by a full
  // coverage run.
  const candidates = listCoverageCandidates(path.resolve(__dirname, '..'));
  assert.ok(candidates.length > 0, 'dist/ must be built for this assertion to mean anything');
  for (const { pattern } of MODULE_FLOORS) {
    const re = globToRegExp(pattern);
    assert.ok(
      candidates.some((file) => re.test(file)),
      `MODULE_FLOORS pattern "${pattern}" matches no built module — rename or remove it`
    );
  }
});

test('no MODULE_FLOORS entry is a misleading no-op below the defaults', () => {
  // Floors resolve to the STRICTEST match, so an entry below a default silently has
  // no effect while reading like a deliberate (lower) decision.
  for (const entry of MODULE_FLOORS) {
    assert.ok(
      entry.line >= PER_FILE_LINE_FLOOR,
      `${entry.pattern}: line floor ${entry.line} is below the default ${PER_FILE_LINE_FLOOR} and does nothing`
    );
    assert.ok(
      entry.branch >= PER_FILE_BRANCH_FLOOR,
      `${entry.pattern}: branch floor ${entry.branch} is below the default ${PER_FILE_BRANCH_FLOOR} and does nothing`
    );
    assert.ok(entry.line <= 100 && entry.branch <= 100, `${entry.pattern}: floor above 100%`);
  }
});

test('every MODULE_FLOORS floor agrees with the measured value recorded beside it', () => {
  // The annotation is the only record of what a floor was derived from, and Jest's
  // core-side equivalent (coverageFloors.test.ts, GATE-3) pins the same rule. It is
  // not decoration: `dist/scopePaths.js` shipped as `line: 99 // measured 97.73`,
  // an unsatisfiable floor that turned the whole gate red on a module that had not
  // regressed at all. A floor ABOVE its annotation cannot pass; a floor far BELOW
  // it is the GATE-1 defect in miniature — present, readable, and not gating.
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'check-coverage-gate.js'),
    'utf8'
  );
  const annotations = new Map();
  for (const line of source.split('\n')) {
    const entry = line.match(
      /\{\s*pattern:\s*'([^']+)',\s*line:\s*[\d.]+,\s*branch:\s*[\d.]+\s*\},\s*\/\/\s*measured\s+([\d.]+)\s*\/\s*([\d.]+)/
    );
    if (entry) {
      annotations.set(entry[1], { line: Number(entry[2]), branch: Number(entry[3]) });
    }
  }

  // The match is unanchored on the right, so an annotation that declares a second
  // reading — `// measured 96.83 / 92.62 (also 96.83 / 92.65: cause)`, the form
  // scripts/check-coverage-annotations.mjs allows on THIS package because V8 range
  // coverage is not reproducible run-to-run — is read here as its FIRST pair only.
  // That is why the declaration grammar requires the lower reading first: this
  // audit and its core twin both size headroom against pair one, so a higher value
  // there would quietly widen the allowance by the gap between the two readings.

  // Branch coverage is the metric that drifts between macOS and Linux CI, so the
  // headroom allowance matches the core suite's 8 points rather than demanding an
  // exact pin.
  const MAX_HEADROOM_POINTS = 8;
  assert.equal(
    annotations.size,
    MODULE_FLOORS.length,
    'every MODULE_FLOORS entry needs a `// measured L / B` annotation on its own line (a trailing `(also L / B: cause)` declaration is allowed and read as its first pair)'
  );
  for (const entry of MODULE_FLOORS) {
    const measured = annotations.get(entry.pattern);
    assert.ok(measured, `${entry.pattern}: no measured annotation found`);
    for (const metric of ['line', 'branch']) {
      assert.ok(
        entry[metric] <= measured[metric],
        `${entry.pattern}: ${metric} floor ${entry[metric]} exceeds the measured ${measured[metric]} — no run can satisfy it`
      );
      assert.ok(
        measured[metric] - entry[metric] <= MAX_HEADROOM_POINTS,
        `${entry.pattern}: ${metric} floor ${entry[metric]} is ${(measured[metric] - entry[metric]).toFixed(2)} points under the measured ${measured[metric]} — too slack to gate`
      );
    }
  }
});

test('findFilesBelowFloor stays the line-only view after the branch floor landed', () => {
  // The narrow helper answers a line-only question and must keep answering exactly
  // that: a file that fails on branches alone is invisible to it by design, so its
  // existing callers cannot start failing for a metric they never asked about.
  // findFloorViolations is the check that sees both.
  const report = [
    '# start of coverage report',
    '# file             | line % | branch % | funcs % | uncovered lines',
    '# dist             |        |          |         | ',
    '#  safetyPolicy.js | 100.00 |     0.00 |  100.00 | ',
    '# all files        | 100.00 |     0.00 |  100.00 | ',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(findFilesBelowFloor(report), []);
  assert.equal(findFloorViolations(report).length, 1, 'the full check still fails it');
});
