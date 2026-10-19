// SPDX-License-Identifier: GPL-3.0-or-later
// Offset paging over an unordered query can repeat or skip rows between pages,
// so sn_query_records always ends the query with a sys_id tiebreak.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleServiceNowCrudTool,
  withSysIdTiebreak,
} = require('../dist/handlers/serviceNowCrudHandlers.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

test('withSysIdTiebreak appends sys_id after the caller order and keeps an explicit one', () => {
  assert.equal(withSysIdTiebreak(''), 'ORDERBYsys_id');
  assert.equal(withSysIdTiebreak('active=true^'), 'active=true^ORDERBYsys_id');
  assert.equal(withSysIdTiebreak('a=1^ORDERBYname'), 'a=1^ORDERBYname^ORDERBYsys_id');
  assert.equal(withSysIdTiebreak('a=1^ORDERBYDESCsys_id'), 'a=1^ORDERBYDESCsys_id');
  assert.equal(withSysIdTiebreak('ORDERBYsys_id^a=1'), 'ORDERBYsys_id^a=1');
  assert.equal(withSysIdTiebreak('a=1^ORDERBYsys_idx'), 'a=1^ORDERBYsys_idx^ORDERBYsys_id');
});

test('sn_query_records sends a sys_id-ordered query on every page', async () => {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  const queries = [];
  global.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    queries.push({ query: params.get('sysparm_query'), offset: params.get('sysparm_offset') });
    return { status: 200, text: async () => JSON.stringify({ result: [] }) };
  };
  try {
    const ctx = { timeoutMs: 1000, dryRun: false, startedAt: Date.now() };
    await handleServiceNowCrudTool('sn_query_records', { table: 'sys_script', query: 'active=true' }, ctx);
    await handleServiceNowCrudTool(
      'sn_query_records',
      { table: 'sys_script', query: 'active=true', offset: 50 },
      ctx
    );
    assert.deepEqual(queries, [
      { query: 'active=true^ORDERBYsys_id', offset: null },
      { query: 'active=true^ORDERBYsys_id', offset: '50' },
    ]);
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
});
