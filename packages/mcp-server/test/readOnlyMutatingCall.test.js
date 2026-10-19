// SPDX-License-Identifier: GPL-3.0-or-later
// SDK-F7: index.ts skips the mutating-tool preflight for invocations that only read.
// The predicate is narrow on purpose — a skip that leaks to a dispatching call would
// run a real mutation without its preflight gate (compare REV-150).
const test = require('node:test');
const assert = require('node:assert/strict');

const { isReadOnlyMutatingCall } = require('../dist/safetyPolicy.js');

const PROGRESS_ID = '0123456789abcdef0123456789abcdef';

test('SDK-F7: a sync_cicd_run resume by progressId is a read-only call', () => {
  assert.equal(
    isReadOnlyMutatingCall('sync_cicd_run', { action: 'install', progressId: PROGRESS_ID }),
    true
  );
  assert.equal(
    isReadOnlyMutatingCall('sync_cicd_run', {
      action: 'install',
      progressId: PROGRESS_ID,
      confirmDestructive: false,
    }),
    true
  );
});

test('SDK-F7: a dispatching sync_cicd_run keeps its preflight', () => {
  assert.equal(
    isReadOnlyMutatingCall('sync_cicd_run', { action: 'install', confirmDestructive: true }),
    false
  );
  assert.equal(isReadOnlyMutatingCall('sync_cicd_run', undefined), false);
});

test('the unified workflow planning call stays read-only; an apply does not', () => {
  assert.equal(isReadOnlyMutatingCall('sync_unified_change_workflow', { task: 'x' }), true);
  assert.equal(
    isReadOnlyMutatingCall('sync_unified_change_workflow', { task: 'x', apply: true }),
    false
  );
});

test('progressId on any other mutating tool never skips the preflight', () => {
  assert.equal(isReadOnlyMutatingCall('sync_push', { progressId: PROGRESS_ID }), false);
});
