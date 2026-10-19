// SPDX-License-Identifier: GPL-3.0-or-later
// sn_list_recent_changes named each change `target_name ?? name`. The Table API returns
// an empty string — not a missing field — for a sys_update_xml row whose record has no
// display value, so `??` kept the "" and the change came back nameless even though the
// update's own `name` (table_sysid) identifies it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleListRecentChanges } = require('../dist/handlers/insightRecentChanges.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

test('an empty target_name falls back to the update name', async () => {
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
  global.fetch = async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        result: [
          { name: 'sys_script_include_abc123', target_name: '', type: 'Script Include', action: 'INSERT_OR_UPDATE' },
          { name: 'sys_script_def456', target_name: 'Set priority', type: 'Business Rule', action: 'delete' },
        ],
      }),
  });
  try {
    const res = await handleListRecentChanges({ scope: 'x_acme_app' }, 1000);
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(
      payload.changes.map((change) => change.name),
      ['sys_script_include_abc123', 'Set priority']
    );
    assert.equal(payload.changes[1].action, 'DELETE');
  } finally {
    global.fetch = realFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearServiceNowSecretsCache();
  }
});
