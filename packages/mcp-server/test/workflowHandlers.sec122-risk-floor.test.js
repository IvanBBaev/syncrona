// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-7 (REV-122): the offline approval refusal in sync_unified_change_workflow was
// bypassable two ways:
//   1. `riskLevel` was caller-controlled and could only LOWER the computed risk —
//      passing riskLevel:"low" forced "low", so getApprovalRequirements said no
//      approval was needed and the offline "unverifiable" refusal never fired.
//   2. The script analysis ran on `script`, but in remote mode the ACTUALLY-EXECUTED
//      script is `remoteScript` — a malicious remoteScript hiding behind a benign
//      `script` was never analyzed, scored 0, and skipped approval entirely.
//
// The fix analyzes the effective (actually-executed) script and floors the risk level
// at the analyzer-computed score via maxRiskLevel: a caller may RAISE risk but never
// lower it. These tests pin both halves — each refusal test fails against the pre-fix
// behavior (the mutation applied) and passes against the fix — plus a sanity check
// that a benign low-risk apply still proceeds.
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

// A destructive script the analyzer scores as high risk with the default weights
// (high=5, medium=3, low=1; riskLevelFromScore: >=6 is "high"):
//   - perf.nested.gr    (high,   5): new GlideRecord( inside a while (gr.next()) loop
//   - sec.workflow.bypass (medium, 3): setWorkflow(false)
//   - sec.gliderecord.review (low, 1): GlideRecord('incident')
// Total score 9 -> "high".
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

// --- bypass 1 + 2 together: benign `script`, destructive remoteScript, riskLevel lowered ---

test('REV-122: remote apply with riskLevel:"low" hiding a destructive remoteScript is refused', async () => {
  let remoteCalled = false;
  let audited = false;
  const ctx = makeWorkflowContext({
    runRemoteScript: async () => {
      remoteCalled = true;
      return { status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' };
    },
    auditMutatingTool: () => {
      audited = true;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a change with a hidden destructive remote script',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      riskLevel: 'low',
      script: 'gs.info("benign");',
      remoteScript: DESTRUCTIVE_SCRIPT,
      approval: FORGED_APPROVAL,
      rollbackEvidence: FULL_ROLLBACK_EVIDENCE,
    },
    ctx
  );
  assert.equal(res.isError, true, 'the lowered-risk destructive remote apply must be refused');
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.risk.score >= 6, 'the executed remoteScript must be the analyzed script');
  assert.equal(payload.risk.level, 'high', 'riskLevel:"low" must not lower the computed risk');
  assert.equal(payload.gates.readyForApply, true, 'self-attested gates still pass — the seam is the backstop');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
  assert.match(payload.error, /self-attested/i);
  assert.equal(remoteCalled, false, 'the destructive remote script must never be dispatched');
  assert.equal(audited, false, 'a refused apply must not be audited as a mutation');
});

// --- bypass 1 in isolation: local script is analyzed, but the caller lowers the level ---

test('REV-122: mocked apply of a destructive script with riskLevel:"low" is refused (risk floor alone)', async () => {
  let audited = false;
  const ctx = makeWorkflowContext({
    auditMutatingTool: () => {
      audited = true;
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a destructive change while claiming low risk',
      apply: true,
      confirmDestructive: true,
      riskLevel: 'low',
      script: DESTRUCTIVE_SCRIPT,
      approval: FORGED_APPROVAL,
      rollbackEvidence: FULL_ROLLBACK_EVIDENCE,
    },
    ctx
  );
  assert.equal(res.isError, true, 'a caller-lowered risk level must not skip the approval gate');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.level, 'high');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
  assert.match(payload.error, /self-attested/i);
  assert.equal(audited, false, 'a refused apply must not be audited as a mutation');
});

// --- bypass 2 in isolation: no explicit riskLevel, the remoteScript alone must score high ---

test('REV-122: destructive remoteScript with no explicit riskLevel is refused (executed script is analyzed)', async () => {
  let remoteCalled = false;
  const ctx = makeWorkflowContext({
    runRemoteScript: async () => {
      remoteCalled = true;
      return { status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' };
    },
  });
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a change whose remote script is destructive',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("benign");',
      remoteScript: DESTRUCTIVE_SCRIPT,
      approval: FORGED_APPROVAL,
      rollbackEvidence: FULL_ROLLBACK_EVIDENCE,
    },
    ctx
  );
  assert.equal(res.isError, true, 'the analyzed script must be the one that actually runs remotely');
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.risk.score >= 6, 'the benign `script` must not mask the remoteScript from analysis');
  assert.equal(payload.risk.level, 'high');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
  assert.equal(remoteCalled, false, 'the destructive remote script must never be dispatched');
});

// --- sanity: a benign read-only low-risk apply still proceeds ---

test('REV-122: benign low-risk apply still proceeds and reports approvalVerification "not-required"', async () => {
  const ctx = makeWorkflowContext();
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change',
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    ctx
  );
  assert.equal(res.isError, false, 'a benign apply must not be blocked by the floor or the seam');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.level, 'low');
  assert.equal(payload.mutationApplied, true);
  assert.equal(payload.approvalVerification.status, 'not-required');
});
