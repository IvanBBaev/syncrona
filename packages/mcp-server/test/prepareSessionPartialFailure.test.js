// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSessionTool } = require('../dist/handlers/sessionHandlers.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

function mkResponse(status, payload) {
  return { status, text: async () => JSON.stringify(payload) };
}

function makeContext() {
  const audits = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    checkSyncronaCapabilities: async () => ({}),
    makeDryRunAuditResponse: () => {
      throw new Error('not a dry run');
    },
    auditMutatingTool: (toolName, args, outcome) => {
      audits.push({ toolName, outcome });
    },
    _audits: audits,
  };
}

async function withInstance(fetchImpl, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    SN_INSTANCE: 'dev1.service-now.com',
    SN_USER: 'admin',
    SN_PASSWORD: 'secret',
  });
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

// The scope switch succeeds; the requested update set does not exist.
async function routedFetch(url, init) {
  const href = String(url);
  const method = init && init.method ? init.method : 'GET';
  if (href.includes('/api/now/table/sys_user?')) {
    return mkResponse(200, { result: [{ sys_id: 'user-1', user_name: 'admin' }] });
  }
  if (href.includes('/api/now/table/sys_scope?')) {
    return mkResponse(200, {
      result: [{ sys_id: 'scope-sys-2', scope: 'x_target', name: 'Target App' }],
    });
  }
  if (href.includes('/api/now/table/sys_update_set')) {
    return mkResponse(200, { result: [] });
  }
  if (href.includes('/api/now/table/sys_user_preference?')) {
    return mkResponse(200, { result: [] });
  }
  if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
    return mkResponse(201, { result: { sys_id: 'pref-new', value: 'scope-sys-2' } });
  }
  throw new Error(`Unmatched: ${method} ${href}`);
}

test('sync_prepare_session: an update-set failure after a scope switch reports the switch', async () => {
  await withInstance(routedFetch, async () => {
    const ctx = makeContext();
    const res = await handleSessionTool(
      'sync_prepare_session',
      { expectedScope: 'x_target', expectedUpdateSetSysId: 'us-missing' },
      ctx
    );
    assert.equal(res.isError, true);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.changed, true);
    assert.match(parsed.actions[0], /scope changed: global -> x_target/);
    assert.match(parsed.error, /scope already was: Update set not found/);
    assert.equal(ctx._audits.length, 1);
    assert.equal(ctx._audits[0].outcome.changed, true);
  });
});

test('sync_prepare_session: an update-set failure with no prior change still throws', async () => {
  await withInstance(routedFetch, async () => {
    const ctx = makeContext();
    await assert.rejects(
      handleSessionTool('sync_prepare_session', { expectedUpdateSetSysId: 'us-missing' }, ctx),
      /Update set not found/
    );
    assert.equal(ctx._audits.length, 0);
  });
});
