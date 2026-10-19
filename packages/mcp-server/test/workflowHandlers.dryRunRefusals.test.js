// SPDX-License-Identifier: GPL-3.0-or-later
//
// A dry run of sync_unified_change_workflow {apply: true} must answer what the
// real apply would answer, minus the mutation. The handler returned the dry-run
// plan before the refusal gates ran (approval verification, the remote-apply
// opt-in, a missing remote script, an absolute remoteEndpoint), so a dry run
// reported a plannable apply that the real run always refuses.
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

function makeWorkflowContext(dryRun, calls) {
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
    writeJsonAndMarkdown: () => {},
    runRemoteScript: async () => {
      calls.remote += 1;
      return { status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' };
    },
    makeDryRunAuditResponse: (toolName, _args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, tool: toolName, planned: details }) }],
    }),
    auditMutatingTool: () => {
      calls.audit += 1;
    },
  };
}

const ROLLBACK = {
  reason: 'reverting via update set',
  impactedEntities: ['sys_script_include:abc'],
  revertSteps: ['git revert HEAD'],
  validationPlan: 'run smoke tests',
};

const REFUSED_APPLIES = {
  'a high-risk apply backed only by a self-attested approval': {
    task: 'apply a high-risk change',
    apply: true,
    confirmDestructive: true,
    riskLevel: 'high',
    approval: { approvalId: 'CHG0001234', approvers: ['alice', 'bob'] },
    rollbackEvidence: ROLLBACK,
  },
  'a remote apply without allowRemoteApply': {
    task: 'apply a low-risk change remotely',
    apply: true,
    confirmDestructive: true,
    executionMode: 'remote',
    script: 'gs.info("x");',
    rollbackEvidence: ROLLBACK,
  },
  'a remote apply with an absolute remoteEndpoint': {
    task: 'apply a low-risk change remotely',
    apply: true,
    confirmDestructive: true,
    executionMode: 'remote',
    allowRemoteApply: true,
    script: 'gs.info("x");',
    remoteEndpoint: 'https://evil.example.com/api/x',
    rollbackEvidence: ROLLBACK,
  },
};

for (const [label, args] of Object.entries(REFUSED_APPLIES)) {
  test(`a dry run refuses ${label}, as the real apply does`, async () => {
    const realCalls = { remote: 0, audit: 0 };
    const real = await handleWorkflowTool('sync_unified_change_workflow', args, makeWorkflowContext(false, realCalls));
    assert.equal(real.isError, true, 'precondition: the real apply is refused');

    const dryCalls = { remote: 0, audit: 0 };
    const dry = await handleWorkflowTool('sync_unified_change_workflow', args, makeWorkflowContext(true, dryCalls));
    const payload = JSON.parse(dry.content[0].text);
    assert.equal(dry.isError, true, 'the dry run planned an apply the real run refuses');
    assert.equal(payload.dryRun === true, false, 'a refusal must not read as a dry-run plan');
    assert.equal(payload.error, JSON.parse(real.content[0].text).error);
    assert.deepEqual(dryCalls, { remote: 0, audit: 0 });
  });
}

test('a dry run of an apply that passes every gate still returns the plan without mutating', async () => {
  const calls = { remote: 0, audit: 0 };
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change remotely',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      rollbackEvidence: ROLLBACK,
    },
    makeWorkflowContext(true, calls)
  );
  assert.equal(res.isError, false);
  assert.equal(JSON.parse(res.content[0].text).dryRun, true);
  assert.deepEqual(calls, { remote: 0, audit: 0 });
});
