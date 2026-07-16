// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  parseAllFilesLineCoverage,
} = require('../scripts/check-coverage-gate.js');

// --- parseArgs: the flags the gate is actually invoked with ---

test('parseArgs applies defaults when no flags are given', () => {
  // Default line gate 90; branch gate disabled (0) until a caller opts in.
  assert.deepEqual(parseArgs([]), { lineThreshold: 90, branchThreshold: 0 });
});

test('parseArgs reads both thresholds in the space-separated form', () => {
  // The exact invocation from `test:coverage:gate`.
  assert.deepEqual(parseArgs(['--line-threshold', '90', '--branch-threshold', '80']), {
    lineThreshold: 90,
    branchThreshold: 80,
  });
});

test('parseArgs reads a single threshold (gate100 invocation)', () => {
  assert.deepEqual(parseArgs(['--line-threshold', '100']), {
    lineThreshold: 100,
    branchThreshold: 0,
  });
});

test('parseArgs accepts the --flag=value form', () => {
  assert.deepEqual(parseArgs(['--line-threshold=88', '--branch-threshold=77']), {
    lineThreshold: 88,
    branchThreshold: 77,
  });
});

// --- parseArgs: the silent-ignore class of bug this hardening closes ---

test('parseArgs rejects a misspelled flag instead of silently ignoring it', () => {
  // The whole point: `--branch-threshhold 80` used to leave the branch gate at
  // its default of 0 (OFF) while the run still reported success.
  assert.throws(
    () => parseArgs(['--branch-threshhold', '80']),
    /Unknown argument "--branch-threshhold"/
  );
});

test('parseArgs rejects a stray positional argument', () => {
  assert.throws(() => parseArgs(['90']), /Unknown argument "90"/);
});

test('parseArgs rejects a missing flag value', () => {
  assert.throws(() => parseArgs(['--line-threshold']), /Missing value for --line-threshold/);
  assert.throws(() => parseArgs(['--line-threshold=']), /Missing value for --line-threshold/);
});

test('parseArgs rejects a non-numeric threshold', () => {
  assert.throws(
    () => parseArgs(['--line-threshold', 'ninety']),
    /Invalid numeric value for --line-threshold: "ninety"/
  );
});

test('parseArgs rejects a threshold outside 0..100', () => {
  // A dropped decimal point (`900`) can never be met; catch it at parse time.
  assert.throws(
    () => parseArgs(['--line-threshold', '900']),
    /between 0 and 100, got 900/
  );
  assert.throws(
    () => parseArgs(['--branch-threshold', '-5']),
    /between 0 and 100, got -5/
  );
});

// --- parseAllFilesLineCoverage: the report row parser ---

test('parseAllFilesLineCoverage reads line and branch percentages from the summary row', () => {
  const report = [
    'file             | line % | branch % | funcs % | uncovered',
    'all files        |  94.20 |  87.10   |  90.00  |',
  ].join('\n');
  assert.deepEqual(parseAllFilesLineCoverage(report), { linePct: 94.2, branchPct: 87.1 });
});

test('parseAllFilesLineCoverage tolerates a leading "# " comment marker on the row', () => {
  const report = '# all files | 91.5 | 80.0 |';
  assert.deepEqual(parseAllFilesLineCoverage(report), { linePct: 91.5, branchPct: 80 });
});

test('parseAllFilesLineCoverage returns null branchPct when the branch cell is not numeric', () => {
  const report = 'all files | 91.5 | n/a |';
  assert.deepEqual(parseAllFilesLineCoverage(report), { linePct: 91.5, branchPct: null });
});

test('parseAllFilesLineCoverage returns null when no all-files row is present', () => {
  assert.equal(parseAllFilesLineCoverage('some unrelated output\nno summary here'), null);
});
