'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleValidateBeforePush } = require('../dist/handlers/insightValidateBeforePush.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

function mkResponse(status, payload) {
  return { status, text: async () => JSON.stringify(payload) };
}

test('handleValidateBeforePush: a recent change with an empty target_name is named by its update name', async () => {
  const keys = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = global.fetch;
  Object.assign(process.env, {
    SN_INSTANCE: 'dev123.service-now.com',
    SN_USER: 'admin',
    SN_PASSWORD: 'secret',
  });
  clearServiceNowSecretsCache();
  let conflictFields = '';
  try {
    global.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/sys_update_xml')) {
        conflictFields = u.searchParams.get('sysparm_fields');
        return mkResponse(200, {
          result: [
            {
              target_name: '',
              name: 'sys_script_include_0123456789abcdef0123456789abcdef',
              type: 'Script Include',
              action: 'DELETE',
              sys_created_by: 'colleague',
              sys_created_on: '2026-10-13 08:00:00',
            },
          ],
        });
      }
      return mkResponse(200, { result: [] });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.ok(conflictFields.split(',').includes('name'), 'the update name must be read');
    assert.equal(parsed.recentChanges.length, 1);
    assert.equal(
      parsed.recentChanges[0].name,
      'sys_script_include_0123456789abcdef0123456789abcdef'
    );
  } finally {
    global.fetch = realFetch;
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
});
