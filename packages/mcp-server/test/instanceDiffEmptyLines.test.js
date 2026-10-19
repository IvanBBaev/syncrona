// SPDX-License-Identifier: GPL-3.0-or-later
// An empty script has no lines. The line counts in an instance-vs-local diff
// must not count an empty side as one line.
const test = require('node:test');
const assert = require('node:assert/strict');

const { diffInstanceVsLocal } = require('../dist/analysis/instanceDiff.js');

test('a script emptied on the instance counts only the local lines as added', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'BR', value: 'var a = 1;\nvar b = 2;' }],
    instance: [{ name: 'BR', value: '' }],
  });

  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0].addedLines, 2);
  assert.equal(report.changed[0].removedLines, 0);
});

test('an empty record that exists on one side only has no lines', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'LocalOnly', value: '' }],
    instance: [{ name: 'InstanceOnly', value: '  \n' }],
  });

  assert.equal(report.added[0].addedLines, 0);
  assert.equal(report.removed[0].removedLines, 0);
});
