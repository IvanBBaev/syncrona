// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWorkflowTool } = require('../dist/handlers/workflowHandlers.js');
const { handleHealthPlanningTool } = require('../dist/handlers/healthPlanningHandlers.js');

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

function asRecord(value) {
  return value && typeof value === 'object' ? value : {};
}

function toStringField(value) {
  return typeof value === 'string' ? value : '';
}

function toGraphFromUnknown(value) {
  const rec = asRecord(value);
  const nodes = Array.isArray(rec.nodes) ? rec.nodes : [];
  const edges = Array.isArray(rec.edges) ? rec.edges : [];
  return { nodes, edges };
}

function makeWorkflowContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    startedAt: Date.now(),
    parseUnifiedTaskType: (value) =>
      value === 'metadata' || value === 'hybrid' ? value : 'script',
    isDeepAnalysisSatisfied: () => true,
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    asRecord,
    toGraphFromUnknown,
    safeGetSessionContext: async () => null,
    toStringField,
    writeJsonAndMarkdown: () => {},
    runRemoteScript: async () => ({
      status: 200,
      data: {},
      text: 'ok',
      usedEndpoint: '/api/x_app/endpoint',
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

function makeHealthContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    contractVersion: '1.0.0',
    serverInfo: { name: 'syncrona-mcp', version: '0.9.0' },
    getDeclaredToolNames: () => ['sync_health_check', 'sync_plan_minimal_footprint'],
    getToolMetrics: () => [],
    checkSyncronaCapabilities: async () => ({}),
    toGraphFromUnknown,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleWorkflowTool
// ---------------------------------------------------------------------------

test('handleWorkflowTool: unknown tool returns null', async () => {
  const res = await handleWorkflowTool('not_a_real_tool', {}, makeWorkflowContext());
  assert.equal(res, null);
});

test('sn_render_analysis_markdown: renders markdown from report', async () => {
  const res = await handleWorkflowTool(
    'sn_render_analysis_markdown',
    { report: { findings: { active: [], suppressed: [] } } },
    makeWorkflowContext()
  );
  assert.equal(res.isError, false);
  assert.equal(res.content[0].type, 'text');
  assert.equal(typeof res.content[0].text, 'string');
});

test('sync_unified_change_workflow: missing task is rejected', async () => {
  const res = await handleWorkflowTool('sync_unified_change_workflow', {}, makeWorkflowContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: task/);
});

test('sync_unified_change_workflow: apply without confirmDestructive is rejected', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'do a thing', apply: true },
    makeWorkflowContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('sync_unified_change_workflow: dry run (no apply) with no script returns simulation payload', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'refactor script include' },
    makeWorkflowContext()
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.task, 'refactor script include');
  assert.equal(payload.analysisInputs.hasScript, false);
  assert.equal(payload.simulationArtifact.written, false);
  assert.ok(payload.simulationReport.simulationId.startsWith('script-'));
});

test('sync_unified_change_workflow: dry run with inline script runs deep analysis', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'update business rule',
      script: 'var gr = new GlideRecord("incident"); gr.query();',
    },
    makeWorkflowContext()
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.analysisInputs.hasScript, true);
  assert.ok(payload.analysis);
  assert.ok(payload.risk);
});

test('sync_unified_change_workflow: writeSimulationReport=true writes artifact via explicit scope', async () => {
  let writeCalls = 0;
  const ctx = makeWorkflowContext({
    writeJsonAndMarkdown: () => {
      writeCalls += 1;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'my task', writeSimulationReport: true, scope: 'x_acme_app' },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.simulationArtifact.written, true);
  assert.equal(payload.simulationArtifact.scope, 'x_acme_app');
  assert.equal(writeCalls, 1);
});

test('sync_unified_change_workflow: writeSimulationReport falls back to session scope, then unknown_scope', async () => {
  const ctxWithSession = makeWorkflowContext({
    safeGetSessionContext: async () => ({ scope: { scope: 'x_from_session' } }),
  });
  const resSession = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'session scope task', writeSimulationReport: true },
    ctxWithSession
  );
  const payloadSession = JSON.parse(resSession.content[0].text);
  assert.equal(payloadSession.simulationArtifact.scope, 'x_from_session');

  const ctxNoSession = makeWorkflowContext({ safeGetSessionContext: async () => null });
  const resNone = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'no scope task', writeSimulationReport: true },
    ctxNoSession
  );
  const payloadNone = JSON.parse(resNone.content[0].text);
  assert.equal(payloadNone.simulationArtifact.scope, 'unknown_scope');
});

test('sync_unified_change_workflow: custom simulationId is honored', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'my task', simulationId: 'custom-sim-42' },
    makeWorkflowContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.simulationReport.simulationId, 'custom-sim-42');
});

test('sync_unified_change_workflow: apply=true but gates not ready returns isError with payload', async () => {
  const ctx = makeWorkflowContext({
    isDeepAnalysisSatisfied: () => false,
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'apply this', apply: true, confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.gates.readyForApply, false);
});

test('sync_unified_change_workflow: apply=true, mocked mode, gates ready, executes mocked remediation', async () => {
  let auditedResult = null;
  const ctx = makeWorkflowContext({
    auditMutatingTool: (_name, _args, outcome) => {
      auditedResult = outcome;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply mocked change',
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.executionMode, 'mocked');
  assert.equal(payload.mutationApplied, true);
  assert.ok(payload.execution);
  assert.ok(payload.scopeKnowledgeUpdate);
  assert.ok(auditedResult, 'auditMutatingTool should have been called');
});

test('sync_unified_change_workflow: updateScopeKnowledge=false skips scope knowledge update', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply without scope update',
      apply: true,
      confirmDestructive: true,
      updateScopeKnowledge: false,
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.scopeKnowledgeUpdate.skipped, true);
});

test('sync_unified_change_workflow: apply=true, mocked mode with proposedChanges builds dependency graph from changes', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply with proposed changes',
      apply: true,
      confirmDestructive: true,
      proposedChanges: [
        { objectId: 'abc123', tableName: 'sys_script_include' },
        { objectId: 'def456', tableName: 'sys_script' },
      ],
      script: 'gs.info("hi");',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.analysisInputs.hasMetadata, true);
});

test('sync_unified_change_workflow: remote mode without allowRemoteApply is rejected', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'remote apply',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      script: 'gs.info("x");',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.match(payload.error, /allowRemoteApply=true/);
});

test('sync_unified_change_workflow: remote mode with allowRemoteApply but empty remoteScript is rejected', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'remote apply no script',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: '',
      remoteScript: '   ',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.match(payload.error, /Remote apply requires script/);
});

test('sync_unified_change_workflow: remote mode with unsafe remoteEndpoint is rejected', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'remote apply bad endpoint',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      remoteEndpoint: 'https://evil.example.com/api/x',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.match(payload.error, /remoteEndpoint must be a relative/);
});

test('sync_unified_change_workflow: remote mode success path calls runRemoteScript and audits', async () => {
  let auditedName = null;
  const ctx = makeWorkflowContext({
    runRemoteScript: async (script, timeoutMs, endpointPath) => ({
      status: 200,
      data: { result: 'done' },
      text: 'remote ok',
      usedEndpoint: endpointPath || '/api/x_app/default',
    }),
    auditMutatingTool: (name) => {
      auditedName = name;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'remote apply success',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      remoteEndpoint: '/api/x_app/run',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.mutationApplied, true);
  assert.equal(payload.remoteExecution.status, 200);
  assert.equal(payload.remoteExecution.usedEndpoint, '/api/x_app/run');
  assert.equal(auditedName, 'sync_unified_change_workflow');
});

test('sync_unified_change_workflow: remote mode failure status yields isError true', async () => {
  const ctx = makeWorkflowContext({
    runRemoteScript: async () => ({
      status: 500,
      data: {},
      text: 'server error',
      usedEndpoint: '/api/x_app/default',
    }),
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'remote apply failure',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.mutationApplied, false);
  assert.match(payload.nextAction, /inspect remote execution/);
});

test('sync_unified_change_workflow: explicit riskLevel overrides score-derived level', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'explicit risk', riskLevel: 'high' },
    makeWorkflowContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.level, 'high');
});

test('sync_unified_change_workflow: uses provided graph nodes/edges directly for hasMetadata', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'graph based task',
      graph: { nodes: [{ id: 'n1', kind: 'script', label: 'n1' }], edges: [] },
    },
    makeWorkflowContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.analysisInputs.hasMetadata, true);
});

// ---------------------------------------------------------------------------
// handleHealthPlanningTool
// ---------------------------------------------------------------------------

test('handleHealthPlanningTool: unknown tool returns null', async () => {
  const res = await handleHealthPlanningTool('not_a_real_tool', {}, makeHealthContext());
  assert.equal(res, null);
});

test('sync_health_check: reports ok status with metrics and default httpEndpoint', async () => {
  const res = await handleHealthPlanningTool('sync_health_check', {}, makeHealthContext({
    checkSyncronaCapabilities: async () => ({ network: { ok: true } }),
  }));
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.httpEndpoint.enabled, false);
  assert.equal(payload.diagnosticsTimeline[0].check, 'network');
});

test('sync_health_check: uses getHealthEndpointStatus when provided', async () => {
  const ctx = makeHealthContext({
    getHealthEndpointStatus: () => ({ enabled: true, port: 4000 }),
  });
  const res = await handleHealthPlanningTool('sync_health_check', {}, ctx);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.httpEndpoint.enabled, true);
  assert.equal(payload.httpEndpoint.port, 4000);
});

test('sync_metrics_trend: empty metrics falls back to default previous/current', async () => {
  const res = await handleHealthPlanningTool('sync_metrics_trend', {}, makeHealthContext());
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.trend);
  assert.equal(payload.previous.failureRatio, 0);
});

test('sync_metrics_trend: with metric events computes windows', async () => {
  const now = Date.now();
  const events = Array.from({ length: 25 }, (_, i) => ({
    tool: 'sync_health_check',
    success: i % 2 === 0,
    durationMs: 10 + i,
    timestamp: now - (25 - i) * 1000,
  }));
  const ctx = makeHealthContext({ getToolMetrics: () => events });
  const res = await handleHealthPlanningTool('sync_metrics_trend', {}, ctx);
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.current);
  assert.ok(payload.trend);
});

test('sync_tool_contract_info: falls back to getDeclaredToolNames when getDeclaredTools absent', async () => {
  const ctx = makeHealthContext({
    getDeclaredToolNames: () => ['tool_b', 'tool_a', 'tool_a'],
  });
  const res = await handleHealthPlanningTool('sync_tool_contract_info', {}, ctx);
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.tools.names, ['tool_a', 'tool_b']);
  assert.equal(payload.tools.count, 2);
  assert.equal(payload.tools.deprecatedCount, 0);
});

test('sync_tool_contract_info: uses getDeclaredTools metadata including deprecated tools', async () => {
  const ctx = makeHealthContext({
    getDeclaredToolNames: () => ['tool_a', 'tool_b', 'no_metadata_tool'],
    getDeclaredTools: () => [
      {
        name: 'tool_a',
        metadata: {
          version: '2.0.0',
          deprecated: true,
          replacedBy: 'tool_b',
          deprecationReason: 'superseded',
          sunsetDate: '2027-01-01',
        },
      },
      { name: 'tool_b', metadata: { version: '1.5.0' } },
      { name: '' },
      { notName: 'ignored' },
    ],
  });
  const res = await handleHealthPlanningTool('sync_tool_contract_info', {}, ctx);
  const payload = JSON.parse(res.content[0].text);
  const toolA = payload.tools.lifecycle.find((t) => t.name === 'tool_a');
  assert.equal(toolA.deprecated, true);
  assert.equal(toolA.replacedBy, 'tool_b');
  assert.equal(toolA.deprecationReason, 'superseded');
  assert.equal(toolA.sunsetDate, '2027-01-01');
  assert.deepEqual(payload.tools.deprecatedTools, ['tool_a']);
  assert.equal(payload.tools.deprecatedCount, 1);

  const noMeta = payload.tools.lifecycle.find((t) => t.name === 'no_metadata_tool');
  assert.equal(noMeta.version, '1.0.0');
  assert.equal(noMeta.deprecated, false);
  assert.equal('replacedBy' in noMeta, false);
});

test('sync_table_api_coverage_matrix: returns rows array', async () => {
  const res = await handleHealthPlanningTool('sync_table_api_coverage_matrix', {}, makeHealthContext());
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(payload.rows));
  assert.equal(payload.count, payload.rows.length);
});

test('sync_plan_minimal_footprint: missing task is rejected', async () => {
  const res = await handleHealthPlanningTool('sync_plan_minimal_footprint', {}, makeHealthContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: task/);
});

test('sync_plan_minimal_footprint: with a task and empty graph returns options (possibly empty)', async () => {
  const res = await handleHealthPlanningTool(
    'sync_plan_minimal_footprint',
    { task: 'add a field to incident table', graph: {} },
    makeHealthContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.task, 'add a field to incident table');
  assert.equal(payload.count, payload.options.length);
  assert.equal(res.isError, payload.options.length === 0);
});

test('sync_plan_minimal_footprint: limit is clamped between 1 and 20', async () => {
  const resHigh = await handleHealthPlanningTool(
    'sync_plan_minimal_footprint',
    {
      task: 'rank targets',
      graph: {
        nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: 'script', label: `n${i}` })),
        edges: [],
      },
      limit: 999,
    },
    makeHealthContext()
  );
  const payloadHigh = JSON.parse(resHigh.content[0].text);
  assert.ok(payloadHigh.options.length <= 20);

  const resLow = await handleHealthPlanningTool(
    'sync_plan_minimal_footprint',
    {
      task: 'rank targets',
      graph: {
        nodes: [{ id: 'n1', kind: 'script', label: 'n1' }],
        edges: [],
      },
      limit: -5,
    },
    makeHealthContext()
  );
  const payloadLow = JSON.parse(resLow.content[0].text);
  assert.ok(payloadLow.options.length <= 1);
});

test('sync_ai_next_actions: missing objective is rejected', async () => {
  const res = await handleHealthPlanningTool('sync_ai_next_actions', {}, makeHealthContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: objective/);
});

test('sync_ai_next_actions: ranks declared tools by keyword match and respects maxSteps', async () => {
  const ctx = makeHealthContext({
    getDeclaredToolNames: () => [
      'sync_tool_contract_info',
      'sync_prepare_session',
      'sync_check_instance_capabilities',
      'sn_build_dependency_graph',
      'sync_plan_minimal_footprint',
      'sync_preflight_check',
      'sync_health_check',
    ],
  });
  const res = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    { objective: 'push and deploy this change safely', maxSteps: 3 },
    ctx
  );
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.count, 3);
  assert.equal(payload.nextActions.length, 3);
  assert.equal(payload.nextActions[0].step, 1);
  // "push"/"deploy" boosts sync_preflight_check's baseScore, so it should rank first.
  assert.equal(payload.nextActions[0].tool, 'sync_preflight_check');
  assert.equal(payload.nextActions[0].dryRunFirst, true);
});

test('sync_ai_next_actions: no declared tools match yields empty nextActions and isError true', async () => {
  const ctx = makeHealthContext({ getDeclaredToolNames: () => ['unrelated_tool'] });
  const res = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    { objective: 'do something' },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.nextActions, []);
});

test('sync_ai_next_actions: maxSteps is clamped between 1 and 10', async () => {
  const ctx = makeHealthContext({
    getDeclaredToolNames: () => [
      'sync_tool_contract_info',
      'sync_prepare_session',
      'sync_check_instance_capabilities',
      'sn_build_dependency_graph',
      'sync_plan_minimal_footprint',
      'sync_preflight_check',
      'sync_health_check',
    ],
  });
  const res = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    { objective: 'general work', maxSteps: 999 },
    ctx
  );
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.maxSteps <= 10);
});
