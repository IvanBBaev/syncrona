// SPDX-License-Identifier: GPL-3.0-or-later
// REV-88 (SEC-7): sync_unified_change_workflow's approval gate (approvalOk, from
// isApprovalSatisfied) is computed purely from the caller-supplied `approval`
// object — a self-attestation a caller can fabricate. Before the fix, a forged
// { approvalId, approvers: [...] } satisfied the gate and the mutation applied
// with no real approval record on the instance.
//
// The offline fix adds a verifyApprovalAgainstInstance(...) seam: with no live
// transport it can never return "verified", only "not-required" (low risk) or
// "unverifiable" (approval required but not confirmable offline). The apply path
// refuses on "unverifiable" rather than trusting the self-attestation.
//
// These tests pin: (a) the seam's offline semantics, and (b) that a high-risk apply
// backed only by a self-attested approval is now REFUSED — which fails against the
// pre-fix behavior (it applied) and passes against the fix. A low-risk apply still
// proceeds, proving the guard is scoped to approval-requiring risk levels.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleWorkflowTool,
  verifyApprovalAgainstInstance,
} = require('../dist/handlers/workflowHandlers.js');

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

// --- the seam's offline semantics ---

test('REV-88: verifyApprovalAgainstInstance returns "not-required" for low risk', () => {
  assert.equal(typeof verifyApprovalAgainstInstance, 'function', 'seam must be exported');
  const v = verifyApprovalAgainstInstance({}, 'low');
  assert.equal(v.status, 'not-required');
});

for (const risk of ['medium', 'high', 'critical']) {
  test(`REV-88: verifyApprovalAgainstInstance returns "unverifiable" for ${risk} (never "verified" offline)`, () => {
    const v = verifyApprovalAgainstInstance(
      { approvalId: 'CHG0001234', approvers: ['alice', 'bob'] },
      risk
    );
    assert.equal(v.status, 'unverifiable');
    assert.notEqual(v.status, 'verified', 'a self-attested approval must not read as verified offline');
    assert.match(v.reason, /self-attested/i);
  });
}

// --- end-to-end: a high-risk apply on a forged approval is refused ---

const HIGH_RISK_APPLY_ARGS = {
  task: 'apply a high-risk change',
  apply: true,
  confirmDestructive: true,
  riskLevel: 'high',
  approval: { approvalId: 'CHG0001234', approvers: ['alice', 'bob'] },
  rollbackEvidence: {
    reason: 'reverting via update set',
    impactedEntities: ['sys_script_include:abc'],
    revertSteps: ['git revert HEAD'],
    validationPlan: 'run smoke tests',
  },
};

test('REV-88: high-risk apply backed only by a self-attested approval is refused', async () => {
  let audited = false;
  const ctx = makeWorkflowContext({
    auditMutatingTool: () => {
      audited = true;
    },
  });
  const res = await handleWorkflowTool('sync_unified_change_workflow', HIGH_RISK_APPLY_ARGS, ctx);
  assert.equal(res.isError, true, 'a forged approval must not apply (it did before the fix)');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.gates.readyForApply, true, 'the self-attested gate still passes — the seam is the backstop');
  assert.equal(payload.approvalVerification.status, 'unverifiable');
  assert.match(payload.error, /self-attested/i);
  assert.equal(payload.mutationApplied === true, false, 'no mutation may be reported as applied');
  assert.equal(audited, false, 'a refused apply must not be audited as a mutation');
});

test('REV-88: refusal happens for a remote high-risk apply too (before the remote call)', async () => {
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
      ...HIGH_RISK_APPLY_ARGS,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      remoteScript: 'gs.info("x");',
    },
    ctx
  );
  assert.equal(res.isError, true);
  assert.equal(remoteCalled, false, 'must refuse before dispatching the remote script');
});

// --- guard is scoped: a low-risk apply still proceeds ---

test('REV-88: low-risk apply still proceeds and reports approvalVerification "not-required"', async () => {
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
  assert.equal(res.isError, false, 'low-risk apply must not be blocked by the seam');
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.mutationApplied, true);
  assert.equal(payload.approvalVerification.status, 'not-required');
});
