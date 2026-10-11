// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMetadataAnalysisTool } = require('../dist/handlers/metadataAnalysisHandlers.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

// The instance holds `total` business rules and honours sysparm_limit.
async function listRules(total, limit) {
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
      name: `Rule ${i}`,
    }));
    return { status: 200, text: async () => JSON.stringify({ result }) };
  };
  try {
    const res = await handleMetadataAnalysisTool(
      'sn_list_metadata_records',
      { recordType: 'business_rule', limit },
      {
        timeoutMs: 1000,
        dryRun: false,
        startedAt: Date.now(),
        parseMetadataType: (value) => value,
      }
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

test('sn_list_metadata_records reports truncated when more records match than the limit', async () => {
  const body = await listRules(12, 10);
  assert.equal(body.count, 10);
  assert.equal(body.rows.length, 10);
  assert.equal(body.truncated, true);
});

test('sn_list_metadata_records does not report truncated when the matches exactly fill the limit', async () => {
  const body = await listRules(10, 10);
  assert.equal(body.count, 10);
  assert.equal(body.truncated, false);
});
