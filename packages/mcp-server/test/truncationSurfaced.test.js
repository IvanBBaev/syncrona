// SPDX-License-Identifier: GPL-3.0-or-later
// REV-101 regression: a result set capped at the row limit must surface an
// explicit truncation notice per type, not be silently reported as complete.
// Both capped sites expose a pure, exported truncation signal so the "row count
// reached the limit" decision is testable without a live ServiceNow instance:
//   - handlers/insightCompareInstances.ts -> buildTruncationNote
//   - analysis/scopeDiscovery.ts          -> isTableResultTruncated / SCOPE_DISCOVERY_ROW_LIMIT
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTruncationNote } = require('../dist/handlers/insightCompareInstances.js');
const {
  SCOPE_DISCOVERY_ROW_LIMIT,
  isTableResultTruncated,
} = require('../dist/analysis/scopeDiscovery.js');

// ---------------------------------------------------------------------------
// insightCompareInstances.ts: buildTruncationNote
// ---------------------------------------------------------------------------

test('REV-101: buildTruncationNote returns null when neither side reaches the limit', () => {
  assert.equal(buildTruncationNote('sys_script', 499, 100, 500), null);
  assert.equal(buildTruncationNote('sys_script', 0, 0, 500), null);
});

test('REV-101: a full (limit-sized) result set produces a truncation notice, not a silent cap', () => {
  const note = buildTruncationNote('sys_script', 500, 100, 500);
  assert.notEqual(note, null);
  assert.match(note, /sys_script/);
  assert.match(note, /500-row limit/);
  assert.match(note, /profileA/);
  assert.match(note, /may be incomplete/);
  // only the capped side is named
  assert.doesNotMatch(note, /profileB/);
});

test('REV-101: an over-limit count on the B side is flagged for profileB', () => {
  const note = buildTruncationNote('sys_ui_script', 10, 600, 500);
  assert.notEqual(note, null);
  assert.match(note, /profileB/);
  assert.doesNotMatch(note, /profileA/);
});

test('REV-101: both sides capped names both profiles', () => {
  const note = buildTruncationNote('sys_script_include', 500, 500, 500);
  assert.match(note, /profileA and profileB/);
});

test('REV-101: the note honours a lower effective limit (default 200)', () => {
  const note = buildTruncationNote('sys_script', 200, 0, 200);
  assert.notEqual(note, null);
  assert.match(note, /200-row limit/);
  // a set below the lowered limit is not flagged
  assert.equal(buildTruncationNote('sys_script', 199, 0, 200), null);
});

// ---------------------------------------------------------------------------
// scopeDiscovery.ts: isTableResultTruncated / SCOPE_DISCOVERY_ROW_LIMIT
// ---------------------------------------------------------------------------

test('REV-101: scope discovery exposes the 500-row cap as a named constant', () => {
  assert.equal(SCOPE_DISCOVERY_ROW_LIMIT, 500);
});

test('REV-101: isTableResultTruncated flags a fetch that reached the default cap', () => {
  assert.equal(isTableResultTruncated(500), true);
  assert.equal(isTableResultTruncated(501), true);
  assert.equal(isTableResultTruncated(499), false);
  assert.equal(isTableResultTruncated(0), false);
});

test('REV-101: isTableResultTruncated honours an explicit limit override', () => {
  assert.equal(isTableResultTruncated(50, 50), true);
  assert.equal(isTableResultTruncated(49, 50), false);
});
