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

const {
  parsePerFileLineCoverage,
  findFilesBelowFloor,
  PER_FILE_LINE_FLOOR,
} = require('../scripts/check-coverage-gate.js');

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
