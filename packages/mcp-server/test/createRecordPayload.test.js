// SPDX-License-Identifier: GPL-3.0-or-later
// A 2xx create whose body carries no record with a sys_id (a login or
// maintenance page, an empty body) wrote nothing anyone can find, so it must be
// an error rather than a created record.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleServiceNowCrudTool } = require('../dist/handlers/serviceNowCrudHandlers.js');
const { createAndSyncScriptInclude } = require('../dist/toolService.js');
const {
  describeNonRecordPayload,
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

async function withInstance(body, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init && init.method });
    return { status: 201, text: async () => body };
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
  }
}

function context(audits) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    createAndSyncScriptInclude: async () => ({ isFailure: false }),
    makeDryRunAuditResponse: () => {
      throw new Error('not a dry run');
    },
    auditMutatingTool: (toolName, args, outcome) => audits.push(outcome),
  };
}

test('describeNonRecordPayload accepts only a result object with a sys_id', () => {
  assert.equal(describeNonRecordPayload(201, { result: { sys_id: 'abc', name: 'x' } }), null);
  assert.match(describeNonRecordPayload(200, '<html>login</html>'), /non-JSON body/);
  assert.match(describeNonRecordPayload(201, { result: {} }), /without a record sys_id/);
  assert.match(describeNonRecordPayload(201, { result: { sys_id: '' } }), /without a record sys_id/);
  assert.match(describeNonRecordPayload(201, { result: [{ sys_id: 'a' }] }), /without a record sys_id/);
  assert.match(describeNonRecordPayload(201, null), /without a record sys_id/);
});

test('sn_create_record fails a 2xx login page instead of reporting a created record', async () => {
  await withInstance('<html><form action="login.do"></form></html>', async () => {
    const audits = [];
    const res = await handleServiceNowCrudTool(
      'sn_create_record',
      { table: 'sys_script', record: { name: 'x' }, confirmDestructive: true },
      context(audits)
    );
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.match(body.error, /No record is known to have been created: HTTP 201 with a non-JSON body/);
    assert.match(audits[0].error, /non-JSON body/);
  });
});

test('sn_create_record still succeeds on a Table API record', async () => {
  await withInstance(JSON.stringify({ result: { sys_id: 'abc123', name: 'x' } }), async () => {
    const audits = [];
    const res = await handleServiceNowCrudTool(
      'sn_create_record',
      { table: 'sys_script', record: { name: 'x' }, confirmDestructive: true },
      context(audits)
    );
    assert.equal(res.isError, false);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.error, undefined);
    assert.equal(body.result.result.sys_id, 'abc123');
    assert.equal(audits[0].error, undefined);
  });
});

test('createAndSyncScriptInclude fails a record-less 2xx and does not refresh', async () => {
  await withInstance(JSON.stringify({ result: {} }), async (requests) => {
    const flow = await createAndSyncScriptInclude(
      { name: 'MyUtil', script: 'var MyUtil = Class.create();', refreshAfterCreate: true },
      1000
    );
    assert.equal(flow.isFailure, true);
    assert.match(flow.createError, /No Script Include is known to have been created/);
    assert.equal(flow.refreshResult, null, 'no refresh after a create that wrote nothing');
    assert.equal(requests.length, 1);
  });
});
