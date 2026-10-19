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

test('handleValidateBeforePush: a table named twice is validated once', async () => {
  const keys = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = global.fetch;
  Object.assign(process.env, {
    SN_INSTANCE: 'dev123.service-now.com',
    SN_USER: 'admin',
    SN_PASSWORD: 'secret',
  });
  clearServiceNowSecretsCache();
  const tableReads = [];
  try {
    global.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/sys_script_include')) {
        tableReads.push(u.pathname);
        return mkResponse(200, {
          result: [{ sys_id: 'a1', name: 'Util', script: 'var x = 1;' }],
        });
      }
      return mkResponse(200, { result: [] });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include', 'sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.equal(tableReads.length, 1);
    assert.equal(parsed.fileCount, 1);
    assert.equal(parsed.files.length, 1);
  } finally {
    global.fetch = realFetch;
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
});
