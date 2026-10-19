// SPDX-License-Identifier: GPL-3.0-or-later
// A rejected sys_update_xml request (403, 500) carries no rows. The markdown release
// notes rendered it anyway — "Total changes: 0" under isError: true, with no word of
// the HTTP status — so the reason the notes were empty was lost.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGenerateReleaseNotes } = require('../dist/handlers/insightReleaseNotes.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

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

const serve = (status, payload) => async () => ({
  status,
  text: async () => JSON.stringify(payload),
});

test('markdown release notes report the HTTP status of a rejected request, not an empty release', async () => {
  await withInstance(serve(403, { error: { message: 'User Not Authorized' } }), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1' }, 1000);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /HTTP 403: User Not Authorized/);
    assert.doesNotMatch(res.content[0].text, /Total changes/);
  });
});

test('a rejected request without an error message still names the status', async () => {
  await withInstance(serve(500, {}), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1' }, 1000);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /failed with HTTP 500\./);
  });
});
