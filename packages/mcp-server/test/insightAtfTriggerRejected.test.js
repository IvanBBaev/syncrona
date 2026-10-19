// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleRunAtfTests } = require('../dist/handlers/insightAtfTests.js');
const { scriptResultHtml, withScriptsBackgroundSession } = require('./scriptsBackgroundFetchMock.cjs');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

test('sync_run_atf_tests fails when the instance rejects the trigger script', async () => {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();

  const polled = [];
  global.fetch = withScriptsBackgroundSession(async (url) => {
    const u = String(url);
    if (u.includes('sys.scripts.do')) {
      return { status: 401, text: async () => JSON.stringify({ error: { message: 'User Not Authenticated' } }) };
    }
    polled.push(u);
    return { status: 200, text: async () => JSON.stringify({ result: [] }) };
  });

  const audits = [];
  try {
    const res = await handleRunAtfTests(
      { scope: 'x_my_scope', suiteId: 'abc', confirmDestructive: true },
      {
        timeoutMs: 300,
        dryRun: false,
        startedAt: Date.now(),
        makeDryRunAuditResponse: () => {
          throw new Error('not a dry run');
        },
        auditMutatingTool: (toolName, args, outcome) => audits.push(outcome),
      }
    );
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 401);
    assert.match(body.error, /rejected the ATF trigger/);
    assert.equal(polled.length, 0, 'no result poll after a rejected trigger');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 401);
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
});
