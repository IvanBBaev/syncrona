// SPDX-License-Identifier: GPL-3.0-or-later
// sn_update_metadata_record must not report an update that changed nothing:
// an updates object with no updatable field, or a 2xx PATCH answered with
// something other than the record.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMetadataAnalysisTool } = require('../dist/handlers/metadataAnalysisHandlers.js');
const { metadataUpdatableFields } = require('../dist/analysis.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

function context(audits, overrides = {}) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    parseMetadataType: (value) => (value === 'business_rule' ? value : null),
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(details) }],
    }),
    auditMutatingTool: (toolName, args, outcome) => audits.push(outcome),
    getLastSemanticIndex: async () => [],
    setLastSemanticIndex: () => {},
    ...overrides,
  };
}

async function withInstance(body, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init && init.method });
    return { status: 200, text: async () => body };
  };
  try {
    await fn(requests);
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

const BASE = { recordType: 'business_rule', sysId: 'abc', confirmDestructive: true };

test('metadataUpdatableFields lists each field once and no empty name', () => {
  const fields = metadataUpdatableFields('business_rule');
  assert.ok(fields.includes('active'));
  assert.ok(fields.includes('name'));
  assert.equal(fields.includes(''), false);
  assert.equal(new Set(fields).size, fields.length);
});

test('sn_update_metadata_record refuses updates with no updatable field and sends nothing', async () => {
  await withInstance(JSON.stringify({ result: { sys_id: 'abc' } }), async (requests) => {
    const audits = [];
    const res = await handleMetadataAnalysisTool(
      'sn_update_metadata_record',
      { ...BASE, updates: { colour: 'red', sys_scope: 'x' } },
      context(audits)
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No updatable field in updates \(ignored: colour, sys_scope\)/);
    assert.match(res.content[0].text, /accepts: active, description/);
    assert.equal(requests.length, 0);
    assert.equal(audits.length, 0);

    const empty = await handleMetadataAnalysisTool(
      'sn_update_metadata_record',
      { ...BASE, updates: {} },
      context(audits)
    );
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /updates is empty/);
  });
});

test('sn_update_metadata_record lists ignored keys next to a real update', async () => {
  await withInstance(JSON.stringify({ result: { sys_id: 'abc', active: 'false' } }), async (requests) => {
    const audits = [];
    const res = await handleMetadataAnalysisTool(
      'sn_update_metadata_record',
      { ...BASE, updates: { active: false, colour: 'red' } },
      context(audits)
    );
    assert.equal(res.isError, false);
    const body = JSON.parse(res.content[0].text);
    assert.deepEqual(body.ignoredKeys, ['colour']);
    assert.equal(body.error, undefined);
    assert.equal(requests[0].method, 'PATCH');

    const preview = await handleMetadataAnalysisTool(
      'sn_update_metadata_record',
      { ...BASE, updates: { active: false, colour: 'red' } },
      context(audits, { dryRun: true })
    );
    assert.deepEqual(JSON.parse(preview.content[0].text).ignoredKeys, ['colour']);
  });
});

test('sn_update_metadata_record fails a 2xx PATCH answered with a login page', async () => {
  await withInstance('<html><form action="login.do"></form></html>', async () => {
    const audits = [];
    const res = await handleMetadataAnalysisTool(
      'sn_update_metadata_record',
      { ...BASE, updates: { active: false } },
      context(audits)
    );
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.match(body.error, /not known to have been updated: HTTP 200 with a non-JSON body/);
    assert.match(audits[0].error, /non-JSON body/);
  });
});
