// SPDX-License-Identifier: GPL-3.0-or-later
// sync_ai_next_actions recommended sync_plan_minimal_footprint with graph: {} and ranked it
// ahead of sn_build_dependency_graph, so following the plan in order always ended in the
// footprint tool's "no targets" error. The graph step now comes first and the footprint
// step points at it for its graph argument.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleHealthPlanningTool } = require('../dist/handlers/healthPlanningHandlers.js');

function makeContext(declared) {
  return {
    timeoutMs: 1000,
    contractVersion: '1.0.0',
    serverInfo: { name: 'syncrona-mcp', version: '0.9.0' },
    getDeclaredToolNames: () => declared,
    getToolMetrics: () => [],
    checkSyncronaCapabilities: async () => ({}),
    toGraphFromUnknown: (value) => value,
  };
}

async function nextActions(objective, declared, maxSteps) {
  const res = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    { objective, maxSteps },
    makeContext(declared)
  );
  return JSON.parse(res.content[0].text).nextActions;
}

test('the dependency-graph step precedes the minimal-footprint step that consumes its graph', async () => {
  const actions = await nextActions(
    'plan the minimal footprint for this task',
    ['sn_build_dependency_graph', 'sync_plan_minimal_footprint', 'sync_health_check'],
    5
  );
  const ids = actions.map((action) => action.id);
  assert.deepEqual(ids.slice(0, 2), ['dependency-graph', 'minimal-footprint']);
  assert.deepEqual(actions[1].argsFrom, { graph: { step: 1 } });
  assert.equal(actions[0].argsFrom, undefined);
});

test('a single-step plan recommends the prerequisite, not the step that needs it', async () => {
  const actions = await nextActions(
    'plan the minimal footprint for this task',
    ['sn_build_dependency_graph', 'sync_plan_minimal_footprint'],
    1
  );
  assert.deepEqual(actions.map((action) => action.id), ['dependency-graph']);
});

test('the minimal-footprint step is left out when no dependency-graph tool is declared', async () => {
  const actions = await nextActions(
    'plan the minimal footprint for this task',
    ['sync_plan_minimal_footprint', 'sync_health_check'],
    5
  );
  assert.deepEqual(actions.map((action) => action.id), ['health']);
});
