// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleRelationOnboardingTool,
} = require('../dist/handlers/relationOnboardingHandlers.js');
const { classifyRelationVisibility } = require('../dist/analysis/scopeDiscovery.js');

const GRAPH = {
  nodes: [
    { id: 'table:x_app_task', kind: 'table', label: 'x_app_task' },
    { id: 'table:task', kind: 'table', label: 'task' },
    { id: 'table:sys_user', kind: 'table', label: 'sys_user' },
    { id: 'table:x_app_log', kind: 'table', label: 'x_app_log' },
    { id: 'file:src/a.js', kind: 'file', label: 'a.js' },
  ],
  edges: [
    { from: 'table:x_app_task', to: 'table:task', relation: 'depends_on', why: 'ServiceNow table inheritance' },
    { from: 'table:x_app_task', to: 'table:sys_user', relation: 'depends_on', why: 'Dictionary reference (owner:reference)' },
    { from: 'file:src/a.js', to: 'table:x_app_log', relation: 'writes', why: 'Referenced via Glide API in src/a.js' },
  ],
};

function makeContext(sourceSummary = {}) {
  return {
    timeoutMs: 1000,
    projectDir: '/nonexistent',
    guardrailConfigFile: '/nonexistent/guardrails.json',
    resolveScopeCode: async (scope) => scope || 'x_app',
    hydrateScopeKnowledgeInputs: async () => ({ graph: GRAPH, sourceSummary }),
    toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
    classifyRelationVisibility,
    existsSync: () => false,
    joinPath: (...parts) => parts.join('/'),
  };
}

async function analyze(args, sourceSummary) {
  const result = await handleRelationOnboardingTool(
    'sync_analyze_scope_relations',
    { scope: 'x_app', ...args },
    makeContext(sourceSummary)
  );
  return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
}

test('includeServiceNow=false drops inheritance edges as well as dictionary ones', async () => {
  const { isError, payload } = await analyze({ includeServiceNow: false });
  assert.equal(isError, false);
  assert.deepEqual(payload.relations.map((r) => r.why), ['Referenced via Glide API in src/a.js']);
  assert.deepEqual(payload.tables, ['x_app_log']);
});

test('includeWorkspace=false lists only tables of the kept instance relations', async () => {
  const { payload } = await analyze({ includeWorkspace: false });
  assert.equal(payload.relationCount, 2);
  assert.deepEqual(payload.tables, ['sys_user', 'task', 'x_app_task']);
});

test('both sources included list every table node of the graph', async () => {
  const { payload } = await analyze({});
  assert.deepEqual(payload.tables, ['sys_user', 'task', 'x_app_log', 'x_app_task']);
});

test('a failed ServiceNow read is an error even when workspace edges exist', async () => {
  const failed = await analyze({}, { serviceNowFailed: true });
  assert.equal(failed.isError, true);
  assert.equal(failed.payload.sourceSummary.serviceNowFailed, true);

  const excluded = await analyze({ includeServiceNow: false }, { serviceNowFailed: true });
  assert.equal(excluded.isError, false);
});
