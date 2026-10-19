// SPDX-License-Identifier: GPL-3.0-or-later
// sn_search_scripts put the caller's query into `scriptCONTAINS<query>` through
// escapeQueryValue, which turns every "^" into a space (a literal caret would split
// the encoded query). Searching for `a ^ b` therefore asked the instance for `a   b`,
// matched nothing, and answered `searchComplete: true, matchCount: 0` — the clean
// search verdict — for code that holds the exact text. The handler now sends the
// longest caret-free piece and keeps only the rows whose script holds the whole query.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSearchScripts } = require('../dist/handlers/insightScriptSearch.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

function mkResponse(status, payload) {
  return { status, text: async () => JSON.stringify(payload) };
}

async function withMockedInstance(fetchImpl, fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  const realFetch = global.fetch;
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    global.fetch = realFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearServiceNowSecretsCache();
  }
}

test('a query holding "^" searches the caret-free piece and filters on the whole query', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return mkResponse(200, {
      result: [
        { sys_id: 'a1', name: 'Bitwise', script: 'var mask = flags ^ 0xFF;' },
        { sys_id: 'b2', name: 'Other', script: 'var mask = flags | 0xFF;' },
      ],
    });
  };

  const res = await withMockedInstance(fetchImpl, () =>
    handleSearchScripts({ query: 'flags ^ 0xFF', tables: ['sys_script_include'] }, 1000)
  );

  assert.equal(urls.length, 1);
  const sent = new URL(urls[0]).searchParams.get('sysparm_query');
  assert.equal(sent, 'scriptCONTAINSflags ', 'the longest caret-free piece goes to the instance');

  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.searchComplete, true);
  assert.equal(payload.query, 'flags ^ 0xFF');
  assert.deepEqual(
    payload.matches.map((match) => match.sys_id),
    ['a1'],
    'only scripts holding the whole query (caret included) are matches'
  );
});

test('a query without "^" is sent unchanged and not filtered locally', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return mkResponse(200, {
      result: [{ sys_id: 'a1', name: 'Util', script: 'GlideRecord usage' }],
    });
  };

  const res = await withMockedInstance(fetchImpl, () =>
    handleSearchScripts({ query: 'gliderecord', tables: ['sys_script_include'] }, 1000)
  );

  assert.equal(new URL(urls[0]).searchParams.get('sysparm_query'), 'scriptCONTAINSgliderecord');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.matchCount, 1);
});

test('a query made only of carets is refused before any request', async () => {
  let called = false;
  const res = await withMockedInstance(
    async () => {
      called = true;
      return mkResponse(200, { result: [] });
    },
    () => handleSearchScripts({ query: ' ^ ^ ', tables: ['sys_script_include'] }, 1000)
  );

  assert.equal(res.isError, true);
  assert.equal(called, false);
});
