// SPDX-License-Identifier: GPL-3.0-or-later
//
// sn_query_records groups the returned rows by `analyzeField`. When the caller
// also narrows the columns with `fields`, the Table API returns only those
// columns, so an analyzeField outside the list was never fetched and every row
// was counted as "<empty>" — a confident, wrong distribution.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleServiceNowCrudTool } = require('../dist/handlers/serviceNowCrudHandlers.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const ENV_KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];
let savedEnv = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
});

test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  clearServiceNowSecretsCache();
});

const RECORDS = [
  { sys_id: '1', number: 'INC001', state: '1' },
  { sys_id: '2', number: 'INC002', state: '2' },
  { sys_id: '3', number: 'INC003', state: '2' },
];

// Behaves like the Table API: sysparm_fields limits the columns returned.
function tableApiFetch(requested) {
  return async (url) => {
    const parsed = new URL(String(url));
    requested.push(parsed);
    const fields = (parsed.searchParams.get('sysparm_fields') || '')
      .split(',')
      .filter(Boolean);
    const result = RECORDS.map((row) =>
      fields.length === 0
        ? row
        : Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]]))
    );
    return { status: 200, text: async () => JSON.stringify({ result }) };
  };
}

function makeContext() {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    createAndSyncScriptInclude: async () => ({}),
    makeDryRunAuditResponse: () => ({ isError: false, content: [] }),
    auditMutatingTool: () => {},
  };
}

test('sn_query_records fetches analyzeField even when fields leaves it out', async () => {
  const requested = [];
  global.fetch = tableApiFetch(requested);

  const res = await handleServiceNowCrudTool(
    'sn_query_records',
    { table: 'incident', fields: ['number'], analyzeField: 'state' },
    makeContext()
  );

  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.analysis.counts, { 1: 1, 2: 2 });
  const tableCall = requested.find((url) => url.pathname === '/api/now/table/incident');
  assert.deepEqual(tableCall.searchParams.get('sysparm_fields').split(','), ['number', 'state']);
});

test('sn_query_records does not repeat an analyzeField already in fields', async () => {
  const requested = [];
  global.fetch = tableApiFetch(requested);

  const res = await handleServiceNowCrudTool(
    'sn_query_records',
    { table: 'incident', fields: ['state', 'number'], analyzeField: 'state' },
    makeContext()
  );

  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.analysis.counts, { 1: 1, 2: 2 });
  const tableCall = requested.find((url) => url.pathname === '/api/now/table/incident');
  assert.equal(tableCall.searchParams.get('sysparm_fields'), 'state,number');
});

test('sn_query_records without fields still returns every column', async () => {
  const requested = [];
  global.fetch = tableApiFetch(requested);

  await handleServiceNowCrudTool(
    'sn_query_records',
    { table: 'incident', analyzeField: 'state' },
    makeContext()
  );

  const tableCall = requested.find((url) => url.pathname === '/api/now/table/incident');
  assert.equal(tableCall.searchParams.has('sysparm_fields'), false);
});
