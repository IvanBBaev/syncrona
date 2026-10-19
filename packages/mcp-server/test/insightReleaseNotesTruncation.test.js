// SPDX-License-Identifier: GPL-3.0-or-later
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

// Serves `total` sys_update_xml rows, honouring sysparm_limit like the Table API.
function serveRows(total) {
  return async (url) => {
    const limit = Number(new URL(String(url)).searchParams.get('sysparm_limit'));
    const count = Math.min(total, limit);
    const result = Array.from({ length: count }, (_, i) => ({
      type: 'sys_script',
      action: 'update',
      target_name: `Rule ${i}`,
    }));
    return { status: 200, text: async () => JSON.stringify({ result }) };
  };
}

test('sync_generate_release_notes reports truncation when the update set exceeds the cap (json)', async () => {
  await withInstance(serveRows(1500), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format: 'json' }, 1000);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.truncated, true);
    assert.equal(body.changeCount, 1000);
    assert.equal(body.changes.length, 1000);
  });
});

test('sync_generate_release_notes flags truncation in markdown', async () => {
  await withInstance(serveRows(1500), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1' }, 1000);
    assert.match(res.content[0].text, /Total changes: 1000/);
    assert.match(res.content[0].text, /Truncated/);
  });
});

test('sync_generate_release_notes does not flag a set of exactly the cap as truncated', async () => {
  await withInstance(serveRows(1000), async () => {
    const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format: 'json' }, 1000);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.truncated, false);
    assert.equal(body.changeCount, 1000);
  });
});
