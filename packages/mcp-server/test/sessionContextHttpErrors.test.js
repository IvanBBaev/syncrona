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

test('tableGet rejects a 200 login page instead of returning no rows', async () => {
  const html = '<html><body>Log in to ServiceNow</body></html>';
  const { result } = await withTransport(
    () => ({ status: 200, data: html, text: html }),
    () => sessionContext.listUpdateSets(1000)
  );
  assert.ok(result.error instanceof Error, 'an HTML 200 must not read as an empty table');
  assert.match(result.error.message, /Reading sys_update_set returned HTTP 200 with a non-JSON body/);
});

test('tableGet rejects a 200 JSON body without a result array', async () => {
  const { result } = await withTransport(
    () => ({ status: 200, data: { status: 'maintenance' }, text: '' }),
    () => sessionContext.tableGet('sys_scope', {}, 1000)
  );
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /an unexpected JSON payload/);
});

// Answers every read with one plausible row; `write` decides the PUT/POST reply.
function instance(write) {
  return (method, endpoint) => {
    if (method !== 'GET') {
      return write(method, endpoint);
    }
    if (endpoint.includes('/sys_user_preference')) {
      return { status: 200, data: { result: [{ sys_id: 'pref1', value: 'old' }] }, text: '' };
    }
    if (endpoint.includes('/sys_update_set')) {
      return { status: 200, data: { result: [{ sys_id: 'us1', name: 'Dev', state: 'in progress' }] }, text: '' };
    }
    return { status: 200, data: { result: [{ sys_id: 'id1', scope: 'x_acme_app', name: 'Acme' }] }, text: '' };
  };
}

const FORBIDDEN = () => ({
  status: 403,
  data: { error: { message: 'Operation Failed' } },
  text: '',
});

test('setCurrentScope fails when the instance rejects the preference write', async () => {
  const { result, calls } = await withTransport(instance(FORBIDDEN), () =>
    sessionContext.setCurrentScope('x_acme_app', 1000)
  );
  assert.ok(calls.some((c) => c.method === 'PUT'), 'the preference write was attempted');
  assert.ok(result.error instanceof Error, 'a rejected write must not report the scope as set');
  assert.match(result.error.message, /403/);
});

test('setCurrentUpdateSet fails when the instance rejects the preference write', async () => {
  const { result } = await withTransport(instance(FORBIDDEN), () =>
    sessionContext.setCurrentUpdateSet({ updateSetSysId: 'us1' }, 1000)
  );
  assert.ok(result.error instanceof Error, 'a rejected write must not report the update set as set');
  assert.match(result.error.message, /403/);
});

test('tableGet still returns the rows of a successful read', async () => {
  const { result } = await withTransport(
    () => ({ status: 200, data: { result: [{ sys_id: 'a' }] }, text: '' }),
    () => sessionContext.tableGet('sys_scope', {}, 1000)
  );
  assert.deepEqual(result, [{ sys_id: 'a' }]);
});
