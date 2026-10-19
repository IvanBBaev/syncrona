// SPDX-License-Identifier: GPL-3.0-or-later
// sync_generate_release_notes named a change `target_name ?? name`, which keeps an
// empty target_name, so such a change was listed without a name. It now falls back
// to the update name like sync_list_recent_changes. The query also orders by sys_id
// after type so a cut at the change cap is stable across calls.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGenerateReleaseNotes } = require('../dist/handlers/insightReleaseNotes.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

async function withInstance(fetchImpl, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const realFetch = global.fetch;
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  global.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    global.fetch = realFetch;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
}

const ROWS = [{ type: 'sys_script', action: 'delete', target_name: '', name: 'sys_script_0123abcd' }];

test('a change with an empty target_name is named by its update name', async () => {
  const urls = [];
  await withInstance(
    async (url) => {
      urls.push(String(url));
      return { status: 200, text: async () => JSON.stringify({ result: ROWS }) };
    },
    async () => {
      const json = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1', format: 'json' }, 1000);
      assert.equal(JSON.parse(json.content[0].text).changes[0].name, 'sys_script_0123abcd');

      const markdown = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1' }, 1000);
      assert.match(markdown.content[0].text, /- DELETE: sys_script_0123abcd/);
    }
  );
  assert.match(new URL(urls[0]).searchParams.get('sysparm_query'), /\^ORDERBYtype\^ORDERBYsys_id$/);
});
