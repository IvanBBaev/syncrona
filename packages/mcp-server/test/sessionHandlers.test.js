// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleSessionTool,
} = require('../dist/handlers/sessionHandlers.js');

// buildPreflightReport / checkSyncronaCapabilities are injected, so the
// preflight and validation branches are drivable without a live instance.
function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    checkSyncronaCapabilities: async () => ({ ok: true }),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    ...overrides,
  };
}

test('sync_preflight_check: allOk=true reports success', async () => {
  const res = await handleSessionTool('sync_preflight_check', {}, makeContext());
  assert.equal(res.isError, false);
});

test('sync_preflight_check: allOk=false surfaces an error', async () => {
  const ctx = makeContext({
    buildPreflightReport: async () => ({ checks: { allOk: false } }),
  });
  const res = await handleSessionTool('sync_preflight_check', {}, ctx);
  assert.equal(res.isError, true);
});

test('sync_set_scope: missing scope is a validation error', async () => {
  const res = await handleSessionTool('sync_set_scope', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: scope/);
});

test('sync_set_scope: dry-run previews the scope switch without applying it', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleSessionTool('sync_set_scope', { scope: 'x_app' }, ctx);
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.scope, 'x_app');
  assert.equal(ctx._audits.length, 0);
});

test('sync_set_update_set: neither name nor sysId is rejected', async () => {
  const res = await handleSessionTool('sync_set_update_set', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /updateSetName or updateSetSysId/);
});

test('sync_set_update_set: dry-run previews without switching', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleSessionTool(
    'sync_set_update_set',
    { updateSetName: 'My Set' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.updateSetName, 'My Set');
});

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleSessionTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
