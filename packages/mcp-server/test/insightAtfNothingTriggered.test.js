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

test('sync_run_atf_tests fails a run-all that started no suite without polling', async () => {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();

  const polled = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('runBackgroundScript')) {
      return { status: 200, text: async () => 'SYNCRONA_ATF_TRIGGERED:{"suites":[],"tests":[],"errors":[]}' };
    }
    polled.push(u);
    return { status: 200, text: async () => JSON.stringify({ result: [] }) };
  };

  const audits = [];
  try {
    const res = await handleRunAtfTests(
      { scope: 'x_empty_scope', runAll: true, confirmDestructive: true },
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
    assert.equal(body.completed, false);
    assert.match(body.error, /No ATF suite was started for scope x_empty_scope/);
    assert.equal(polled.length, 0, 'no result poll when nothing was started');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].triggered, false);
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();
  }
});
