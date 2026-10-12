// SPDX-License-Identifier: GPL-3.0-or-later
// A dry run of sync_unified_change_workflow has no side effects. With
// writeSimulationReport set it must still return the report inline, say it was
// not written, and never touch the disk.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWorkflowTool } = require('../dist/handlers/workflowHandlers.js');

function asRecord(value) {
  return value && typeof value === 'object' ? value : {};
}
function toStringField(value) {
  return typeof value === 'string' ? value : '';
}
function toGraphFromUnknown(value) {
  const rec = asRecord(value);
  return {
    nodes: Array.isArray(rec.nodes) ? rec.nodes : [],
    edges: Array.isArray(rec.edges) ? rec.edges : [],
  };
}

function makeWorkflowContext(dryRun, writes) {
  return {
    timeoutMs: 1000,
    dryRun,
    startedAt: Date.now(),
    parseUnifiedTaskType: (value) => (value === 'metadata' || value === 'hybrid' ? value : 'script'),
    isDeepAnalysisSatisfied: () => true,
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    asRecord,
    toGraphFromUnknown,
    safeGetSessionContext: async () => null,
    toStringField,
    writeJsonAndMarkdown: (paths) => {
      writes.push(paths);
    },
    runRemoteScript: async () => {
      throw new Error('a dry run must not run a remote script');
    },
    makeDryRunAuditResponse: (toolName, _args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, tool: toolName, planned: details }) }],
    }),
    auditMutatingTool: () => {},
  };
}

const ROLLBACK = {
  reason: 'reverting via update set',
  impactedEntities: ['sys_script_include:abc'],
  revertSteps: ['git revert HEAD'],
  validationPlan: 'run smoke tests',
};

test('a dry-run plan returns the simulation report inline without writing it', async () => {
  const writes = [];
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'plan a change', writeSimulationReport: true, scope: 'x_acme_app', dryRun: true },
    makeWorkflowContext(true, writes)
  );

  assert.equal(res.isError, false);
  assert.deepEqual(writes, []);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.simulationReport.reportVersion, '1.0.0');
  assert.equal(payload.simulationArtifact.written, false);
  assert.match(payload.simulationArtifact.reason, /dry run/);
});

test('a dry-run apply returns the simulation report inline without writing it', async () => {
  const writes = [];
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change',
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: ROLLBACK,
      writeSimulationReport: true,
      scope: 'x_acme_app',
      dryRun: true,
    },
    makeWorkflowContext(true, writes)
  );

  assert.equal(res.isError, false);
  assert.deepEqual(writes, []);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.dryRun, true);
  assert.equal(body.planned.simulationReport.reportVersion, '1.0.0');
  assert.equal(body.planned.simulationArtifact.written, false);
});

test('a real run still writes the simulation report when asked', async () => {
  const writes = [];
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    { task: 'plan a change', writeSimulationReport: true, scope: 'x_acme_app' },
    makeWorkflowContext(false, writes)
  );

  assert.equal(res.isError, false);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(res.content[0].text).simulationArtifact.written, true);
});
