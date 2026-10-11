// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleRunAtfTests } = require('../dist/handlers/insightAtfTests.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

function context(audits) {
  return {
    timeoutMs: 300,
    dryRun: false,
    startedAt: Date.now(),
    makeDryRunAuditResponse: () => {
      throw new Error('not a dry run');
    },
    auditMutatingTool: (toolName, args, outcome) => audits.push(outcome),
  };
}

async function withInstance(fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  try {
    await fn();
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();
  }
}

test('sync_run_atf_tests does not report a run-all complete when the suite results exceed one read', async () => {
  await withInstance(async () => {
    // 260 suite results exist: every one the instance returns has finished, but
    // only as many as sysparm_limit allows are ever returned.
    const TOTAL = 260;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('runBackgroundScript')) {
        return { status: 200, text: async () => 'SYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}' };
      }
      const limit = Number(new URL(u).searchParams.get('sysparm_limit'));
      const result = Array.from({ length: Math.min(limit, TOTAL) }, (_, i) => ({
        sys_id: `r${i}`,
        status: 'success',
        test_suite: `s${i}`,
      }));
      return { status: 200, text: async () => JSON.stringify({ result }) };
    };

    const audits = [];
    const res = await handleRunAtfTests(
      { scope: 'x_my_scope', runAll: true, confirmDestructive: true },
      context(audits)
    );
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.truncated, true);
    assert.equal(body.completed, false, 'results past the read limit may still be running');
    assert.equal(body.summary.total, 200);
    assert.equal(audits[0].truncated, true);
    assert.equal(audits[0].completed, false);
  });
});

test('sync_run_atf_tests reports a run-all within one read as complete and not truncated', async () => {
  await withInstance(async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('runBackgroundScript')) {
        return { status: 200, text: async () => 'SYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}' };
      }
      const result = Array.from({ length: 200 }, (_, i) => ({ sys_id: `r${i}`, status: 'success' }));
      return { status: 200, text: async () => JSON.stringify({ result }) };
    };

    const res = await handleRunAtfTests(
      { scope: 'x_my_scope', runAll: true, confirmDestructive: true },
      context([])
    );
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.truncated, false);
    assert.equal(body.completed, true);
    assert.equal(body.summary.total, 200);
  });
});
