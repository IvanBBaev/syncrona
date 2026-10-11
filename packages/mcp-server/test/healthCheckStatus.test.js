// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleHealthPlanningTool } = require('../dist/handlers/healthPlanningHandlers.js');

function context(capabilities) {
  return {
    timeoutMs: 1000,
    contractVersion: '1',
    serverInfo: { name: 'test', version: '0' },
    getDeclaredToolNames: () => ['sync_health_check'],
    getToolMetrics: () => [],
    checkSyncronaCapabilities: async () => capabilities,
    toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
  };
}

async function healthStatus(capabilities) {
  const res = await handleHealthPlanningTool('sync_health_check', {}, context(capabilities));
  assert.equal(res.isError, false);
  return JSON.parse(res.content[0].text).status;
}

test('sync_health_check reports ok when every capability probe passes', async () => {
  assert.equal(await healthStatus({ a: { ok: true }, b: { ok: true } }), 'ok');
});

test('sync_health_check reports degraded when some capability probes fail', async () => {
  assert.equal(await healthStatus({ a: { ok: true }, b: { ok: false, status: 404 } }), 'degraded');
});

test('sync_health_check reports error when every capability probe fails', async () => {
  assert.equal(
    await healthStatus({ a: { ok: false, status: 0 }, b: { ok: false, status: 401 } }),
    'error'
  );
});
