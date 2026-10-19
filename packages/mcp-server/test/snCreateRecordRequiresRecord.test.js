// SPDX-License-Identifier: GPL-3.0-or-later
// sn_create_record fell back to {} when `record` was missing (the input validator
// treats it as optional although the tool schema requires it), so a call without one
// POSTed an empty body and created a blank record nobody described.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleServiceNowCrudTool } = require('../dist/handlers/serviceNowCrudHandlers.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

function makeContext(overrides = {}) {
  const dryRuns = [];
  const audits = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    createAndSyncScriptInclude: async () => ({ isFailure: false }),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome) => audits.push({ toolName, args, outcome }),
    _dryRuns: dryRuns,
    _audits: audits,
    ...overrides,
  };
}

async function withInstance(fetchImpl, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  global.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
}

test('a create without a record is refused before any request is sent', async () => {
  const requests = [];
  await withInstance(
    async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return { status: 201, text: async () => JSON.stringify({ result: { sys_id: 'a'.repeat(32) } }) };
    },
    async () => {
      const ctx = makeContext();
      const res = await handleServiceNowCrudTool(
        'sn_create_record',
        { table: 'sys_script', confirmDestructive: true },
        ctx
      );
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Missing required field: record/);
      assert.deepEqual(requests, []);
      assert.equal(ctx._audits.length, 0);
    }
  );
});

for (const [label, record] of [
  ['an empty object', {}],
  ['an array', [{ name: 'x' }]],
  ['a string', 'name=x'],
]) {
  test(`a record given as ${label} is refused, even as a dry run`, async () => {
    const ctx = makeContext({ dryRun: true });
    const res = await handleServiceNowCrudTool(
      'sn_create_record',
      { table: 'sys_script', record, confirmDestructive: true },
      ctx
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Missing required field: record/);
    assert.equal(ctx._dryRuns.length, 0);
  });
}
