// SPDX-License-Identifier: GPL-3.0-or-later
// sessionContext must not read an HTTP failure as an answer. snRequest resolves
// with the status instead of throwing on 4xx/5xx, so every caller has to check it.
//
// Technique: the compiled output is CommonJS and sessionContext calls
// `servicenowCore_1.snRequest(...)` at call time, so overwriting the export on the
// loaded module swaps the transport. node:test runs each file in its own process.
const test = require('node:test');
const assert = require('node:assert/strict');

const servicenowCore = require('../dist/servicenowCore.js');
const sessionContext = require('../dist/sessionContext.js');

async function withTransport(handler, fn) {
  const prevRequest = servicenowCore.snRequest;
  const prevConfig = servicenowCore.getServiceNowConfig;
  const calls = [];
  try {
    servicenowCore.getServiceNowConfig = () => ({
      instance: 'example.service-now.com',
      user: 'admin',
      password: 'x',
    });
    servicenowCore.snRequest = async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      return handler(method, endpoint, body);
    };
    return { result: await fn().catch((error) => ({ error })), calls };
  } finally {
    servicenowCore.snRequest = prevRequest;
    servicenowCore.getServiceNowConfig = prevConfig;
  }
}

test('tableGet throws on an HTTP error instead of returning no rows', async () => {
  const { result } = await withTransport(
    () => ({ status: 401, data: { error: { message: 'User Not Authenticated' } }, text: '' }),
    () => sessionContext.tableGet('sys_scope', { query: 'scopeSTARTSWITHx_' }, 1000)
  );
  assert.ok(result.error instanceof Error, 'a 401 must not read as an empty table');
  assert.match(result.error.message, /401/);
  assert.match(result.error.message, /User Not Authenticated/);
});

test('listScopes surfaces a failed read rather than an empty scope list', async () => {
  const { result } = await withTransport(
    () => ({ status: 500, data: 'boom', text: 'boom' }),
    () => sessionContext.listScopes(1000)
  );
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /500/);
});

test('tableGet still returns the rows of a successful read', async () => {
  const { result } = await withTransport(
    () => ({ status: 200, data: { result: [{ sys_id: 'a' }] }, text: '' }),
    () => sessionContext.tableGet('sys_scope', {}, 1000)
  );
  assert.deepEqual(result, [{ sys_id: 'a' }]);
});
