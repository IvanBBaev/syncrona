// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleRunAtfTests, atfTriggerOutput, parseAtfTrigger } = require('../dist/handlers/insightAtfTests.js');
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

async function runWithTriggerBody(args, triggerBody) {
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
      return { status: 200, text: async () => triggerBody };
    }
    polled.push(u);
    return { status: 200, text: async () => JSON.stringify({ result: [] }) };
  };
  const audits = [];
  try {
    const res = await handleRunAtfTests(
      { scope: 'x_my_scope', confirmDestructive: true, ...args },
      {
        timeoutMs: 300,
        dryRun: false,
        startedAt: Date.now(),
        makeDryRunAuditResponse: () => {
          throw new Error('not a dry run');
        },
        auditMutatingTool: (toolName, a, outcome) => audits.push(outcome),
      }
    );
    return { res, polled, audits };
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

test('sync_run_atf_tests fails a suite run whose suite could not start', async () => {
  const body = JSON.stringify({
    result: {
      output:
        'SYNCRONA_ATF_TRIGGERED:{"suites":[],"tests":[],"errors":["suite abc: runSuite is unavailable"]}',
    },
  });
  const { res, polled, audits } = await runWithTriggerBody({ suiteId: 'abc' }, body);
  assert.equal(res.isError, true);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.mode, 'suite');
  assert.match(parsed.error, /No ATF run was started: suite abc: runSuite is unavailable/);
  assert.equal(polled.length, 0);
  assert.equal(audits[0].triggered, false);
});

test('sync_run_atf_tests fails a test run whose output carries no marker', async () => {
  const { res, polled } = await runWithTriggerBody(
    { testId: 't1' },
    '<html><form action="login.do"><input name="user_name"></form></html>'
  );
  assert.equal(res.isError, true);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.mode, 'test');
  assert.match(parsed.error, /carried no result marker/);
  assert.equal(polled.length, 0);
});

test('atfTriggerOutput reads the scoped API result.output before the raw text', () => {
  const output = 'SYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}';
  const text = JSON.stringify({ result: { output } });
  assert.equal(atfTriggerOutput({ text, data: JSON.parse(text) }), output);
  assert.deepEqual(parseAtfTrigger(atfTriggerOutput({ text, data: JSON.parse(text) })).suites, ['s1']);
  assert.equal(atfTriggerOutput({ text: '<pre>x</pre>', data: null }), '<pre>x</pre>');
  assert.equal(atfTriggerOutput({ data: { result: [] } }), '');
});
