// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-7 follow-up (REV-125): the REV-122 risk floor read the score from an analysis that
// honored the caller-supplied `args.policy`. A caller could therefore pass
// `policy.weights = { high: 0, medium: 0, low: 0 }` to zero the score, drop the risk to
// "low", and bypass BOTH the approval gate and the REV-88 self-attestation refusal —
// exactly what the floor was meant to prevent. The fix recomputes a TRUSTED analysis with
// NO caller policy (default weights 5/3/1) and gates on the higher score. These tests fail
// against the pre-REV-125 behavior (mutation applied) and pass against the fix.
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
    runRemoteScript: async () => ({ status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

// Scores 9 -> "high" with the DEFAULT weights (perf.nested.gr=5, sec.workflow.bypass=3,
// sec.gliderecord.review=1). See workflowHandlers.sec122-risk-floor.test.js for details.
const DESTRUCTIVE_SCRIPT = [
  "var gr = new GlideRecord('incident');",
  'gr.setWorkflow(false);',
  'gr.query();',
  'while (gr.next()) {',
  "  var child = new GlideRecord('task');",
  '  child.deleteRecord();',
  '}',
].join('\n');

const FORGED_APPROVAL = { approvalId: 'CHG0001234', approvers: ['alice', 'bob'] };
const FULL_ROLLBACK_EVIDENCE = {
  reason: 'reverting via update set',
  impactedEntities: ['sys_script_include:abc'],
  revertSteps: ['git revert HEAD'],
  validationPlan: 'run smoke tests',
};

test('REV-125: a caller cannot zero the risk score via policy.weights to skip the gate', async () => {
  let audited = false;
  const ctx = makeWorkflowContext({
    auditMutatingTool: () => {
      audited = true;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a destructive change while zeroing the risk weights',
      apply: true,
      confirmDestructive: true,
      // No explicit riskLevel — the ONLY lever is the tampered policy.
      policy: { weights: { high: 0, medium: 0, low: 0 } },
      script: DESTRUCTIVE_SCRIPT,
      approval: FORGED_APPROVAL,
      rollbackEvidence: FULL_ROLLBACK_EVIDENCE,
    },
    ctx
  );
  assert.equal(res.isError, true, 'a zeroed-weights policy must not lower the gating risk');
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.risk.score >= 6, 'the trusted (default-weight) score must gate, not the tampered one');
  assert.equal(payload.risk.level, 'high');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
  assert.match(payload.error, /self-attested/i);
  assert.equal(audited, false, 'a refused apply must not be audited as a mutation');
});

test('REV-125: zeroed weights + riskLevel:"low" together still cannot bypass the gate', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a destructive change with both levers pulled',
      apply: true,
      confirmDestructive: true,
      riskLevel: 'low',
      policy: { weights: { high: 0, medium: 0, low: 0 } },
      script: DESTRUCTIVE_SCRIPT,
      approval: FORGED_APPROVAL,
      rollbackEvidence: FULL_ROLLBACK_EVIDENCE,
    },
    ctx
  );
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.level, 'high');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
});

test('REV-125: a genuinely benign apply with a zeroed policy still proceeds (no false block)', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change with a custom policy',
      apply: true,
      confirmDestructive: true,
      policy: { weights: { high: 0, medium: 0, low: 0 } },
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false, 'the trusted floor of an empty script is 0 -> low -> proceeds');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.level, 'low');
  assert.equal(payload.mutationApplied, true);
  assert.equal(payload.approvalVerification.status, 'not-required');
});
