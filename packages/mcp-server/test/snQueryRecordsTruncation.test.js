// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleServiceNowCrudTool } = require('../dist/handlers/serviceNowCrudHandlers.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

// The instance holds `total` incidents and honours sysparm_limit.
async function queryIncidents(total, limit) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  global.fetch = async (url) => {
    const requested = Number(new URL(String(url)).searchParams.get('sysparm_limit'));
    const result = Array.from({ length: Math.min(requested, total) }, (_, i) => ({
      sys_id: `s${i}`,
      state: i % 2 === 0 ? 'active' : 'closed',
    }));
    return { status: 200, text: async () => JSON.stringify({ result }) };
  };
  try {
    const res = await handleServiceNowCrudTool(
      'sn_query_records',
      { table: 'incident', limit, analyzeField: 'state' },
      { timeoutMs: 1000, dryRun: false, startedAt: Date.now() }
    );
    assert.equal(res.isError, false);
    return JSON.parse(res.content[0].text);
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

test('sn_query_records reports truncated when more records match than the limit', async () => {
  const body = await queryIncidents(12, 10);
  assert.equal(body.rowCount, 10);
  assert.equal(body.rows.length, 10);
  assert.equal(body.truncated, true);
  // The analysis covers the returned rows only, not the probe row past the limit.
  assert.deepEqual(body.analysis.counts, { active: 5, closed: 5 });
});

test('sn_query_records does not report truncated when the matches exactly fill the limit', async () => {
  const body = await queryIncidents(10, 10);
  assert.equal(body.rowCount, 10);
  assert.equal(body.truncated, false);
});
