// SPDX-License-Identifier: GPL-3.0-or-later
// Two records may share a name (e.g. business rules on different tables). The
// instance-vs-local diff pairs them by sys_id when both sides have one and by
// name otherwise, and must never collapse or drop a duplicate.
const test = require('node:test');
const assert = require('node:assert/strict');

const { diffInstanceVsLocal } = require('../dist/analysis/instanceDiff.js');

test('records sharing a name are paired by sys_id', () => {
  const report = diffInstanceVsLocal({
    local: [
      { name: 'Validate', value: 'var a = 1;', sysId: 'sys1' },
      { name: 'Validate', value: 'var b = 2;', sysId: 'sys2' },
    ],
    instance: [
      { name: 'Validate', value: 'var b = 2;', sysId: 'sys2' },
      { name: 'Validate', value: 'var a = 1;', sysId: 'sys1' },
    ],
  });

  assert.equal(report.unchangedCount, 2);
  assert.equal(report.changed.length, 0);
  assert.equal(report.summary.total, 2);
});

test('a duplicate name without sys_ids is not dropped', () => {
  const report = diffInstanceVsLocal({
    local: [
      { name: 'Validate', value: 'var a = 1;' },
      { name: 'Validate', value: 'var b = 2;' },
    ],
    instance: [{ name: 'Validate', value: 'var a = 1;' }],
  });

  assert.equal(report.unchangedCount, 1);
  assert.equal(report.added.length, 1);
  assert.equal(report.summary.total, 2);
});

test('the same name with different sys_ids is an added and a removed record', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'Validate', value: 'x', sysId: 'local1' }],
    instance: [{ name: 'Validate', value: 'x', sysId: 'inst1' }],
  });

  assert.deepEqual(report.added.map((e) => e.sysId), ['local1']);
  assert.deepEqual(report.removed.map((e) => e.sysId), ['inst1']);
});

test('a record with a sys_id on one side only is still paired by name', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'Validate', value: 'x' }],
    instance: [{ name: 'Validate', value: 'y', sysId: 'inst1' }],
  });

  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0].sysId, 'inst1');
});
