// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSearchScripts } = require('../dist/handlers/insightScriptSearch.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

test('sn_search_scripts searches a table named twice once', async () => {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();

  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ result: [{ sys_id: 'a1', name: 'Util', script: 'var x = findMe();' }] }),
    };
  };
  try {
    const res = await handleSearchScripts(
      { query: 'findMe', tables: ['sys_script_include', 'sys_script_include'] },
      5000
    );
    const body = JSON.parse(res.content[0].text);
    assert.equal(requests.length, 1);
    assert.deepEqual(body.tablesSearched, ['sys_script_include']);
    assert.equal(body.matchCount, 1);
    assert.equal(res.isError, false);
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
});
