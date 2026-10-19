// SPDX-License-Identifier: GPL-3.0-or-later
// A 2xx login page means the background script never ran, so
// sn_execute_background_script must not report it as executed.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleServiceNowCrudTool } = require('../dist/handlers/serviceNowCrudHandlers.js');
const {
  describeLoginPage,
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const { scriptsBackgroundFetch, scriptResultHtml } = require('./scriptsBackgroundFetchMock.cjs');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];
const LOGIN_PAGE =
  '<!DOCTYPE html><html><body><form action="login.do" method="post">' +
  '<input name="user_name"><input type="password" name="user_password"></form></body></html>';

test('describeLoginPage matches the login form markup only', () => {
  assert.match(describeLoginPage(LOGIN_PAGE), /login page/);
  assert.match(describeLoginPage("<form id='f' action='/login.do'></form>"), /login page/);
  assert.equal(describeLoginPage('<pre>*** Script: redirect to login.do</pre>'), null);
  assert.equal(describeLoginPage('&lt;input name=&quot;user_password&quot;&gt;'), null);
  assert.equal(describeLoginPage({ result: { output: '<form action="login.do">' } }), null);
  assert.equal(describeLoginPage(undefined), null);
});

async function runTool(fetchOptions) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  global.fetch = scriptsBackgroundFetch(fetchOptions);
  const audits = [];
  try {
    const res = await handleServiceNowCrudTool(
      'sn_execute_background_script',
      { script: "gs.info('x');", confirmDestructive: true },
      {
        timeoutMs: 1000,
        dryRun: false,
        startedAt: Date.now(),
        makeDryRunAuditResponse: () => {
          throw new Error('not a dry run');
        },
        auditMutatingTool: (toolName, args, outcome) => audits.push(outcome),
      }
    );
    return { res, audits };
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
}

test('sn_execute_background_script fails a 2xx login page', async () => {
  // The form GET lands on the login page when the session was not accepted.
  const { res, audits } = await runTool({ formHtml: LOGIN_PAGE });
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.match(body.error, /The script did not run: the instance answered with its login page/);
  assert.match(audits[0].error, /login page/);
});

test('sn_execute_background_script still succeeds on script output', async () => {
  const { res, audits } = await runTool({ result: scriptResultHtml('*** Script: x') });
  assert.equal(res.isError, false);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, undefined);
  assert.equal(body.data.result.output, '*** Script: x');
  assert.equal(audits[0].error, undefined);
});

test('sn_execute_background_script fails a script the platform could not compile', async () => {
  const { res, audits } = await runTool({
    result: scriptResultHtml(['Script compilation error: Unterminated string (script; line 1)']),
  });
  assert.equal(res.isError, true);
  assert.match(audits[0].error, /^Script compilation error/);
});
