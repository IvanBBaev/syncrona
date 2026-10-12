// SPDX-License-Identifier: GPL-3.0-or-later
// An instance that answers the Table API with an HTML page (login, maintenance)
// still returns HTTP 200. The release notes must fail instead of reporting an
// update set with no changes.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGenerateReleaseNotes } = require('../dist/handlers/insightReleaseNotes.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

async function withInstance(fetchImpl, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
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
    clearScopedApiPrefixCache();
  }
}

const serveText = (text) => async () => ({ status: 200, text: async () => text });
const LOGIN_PAGE = '<html><head><title>ServiceNow</title></head><body>Log in</body></html>';

for (const format of ['markdown', 'json']) {
  test(`sync_generate_release_notes fails on an HTML 200 page (${format})`, async () => {
    await withInstance(serveText(LOGIN_PAGE), async () => {
      const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format }, 1000);
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /HTTP 200 with a non-JSON body/);
      assert.doesNotMatch(res.content[0].text, /Total changes/);
    });
  });
}

test('sync_generate_release_notes fails on a JSON 200 payload without a result array', async () => {
  await withInstance(serveText(JSON.stringify({ status: 'maintenance' })), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format: 'json' }, 1000);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unexpected JSON payload/);
  });
});

test('sync_generate_release_notes still accepts an empty Table API result', async () => {
  await withInstance(serveText(JSON.stringify({ result: [] })), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format: 'json' }, 1000);
    assert.equal(res.isError, false);
    assert.equal(JSON.parse(res.content[0].text).changeCount, 0);
  });
});
