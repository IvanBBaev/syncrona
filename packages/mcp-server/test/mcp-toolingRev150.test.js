// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 follow-up (REV-150) regression pins for the "workflow" tool module.
//
// Every module entry in TOOL_HANDLER_MODULES forwards `dryRun: ctx.dryRun` to its
// handler — except the workflow module, which forwarded timeoutMs/startedAt/helpers
// but not dryRun (and not makeDryRunAuditResponse). handleWorkflowTool therefore had
// no way to honor a dry run, so sync_unified_change_workflow {apply:true, dryRun:true}
// executed the real apply. Worse than merely ignoring the flag: index.ts skips
// enforcePreflightForTool whenever dryRun is requested, so the real mutation ran with
// the preflight gate disabled, and a `requireDryRun` guardrail on this tool made
// dryRun=true the ONLY accepted shape.
//
// These tests fail against the old wiring (the handler receives dryRun === undefined
// and the apply path dispatches) and pass against the fix.
const test = require('node:test');
const assert = require('node:assert/strict');

const workflowHandlers = require('../dist/handlers/workflowHandlers.js');
const { TOOL_HANDLER_MODULES } = require('../dist/toolModules.js');
const { DEFAULT_GUARDRAIL_CONFIG } = require('../dist/policyConfig.js');

function workflowModule() {
  const module = TOOL_HANDLER_MODULES.find((entry) => entry.name === 'workflow');
  assert.ok(module, 'the workflow module must stay registered');
  return module;
}

function makeModuleContext(overrides = {}) {
  return {
    toolName: 'sync_unified_change_workflow',
    args: { task: 'apply a change', apply: true, confirmDestructive: true, dryRun: true },
    timeoutMs: 1000,
    dryRun: true,
    startedAt: Date.now(),
    guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, toolName, details }) }],
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

test('REV-150: the workflow module forwards dryRun and makeDryRunAuditResponse to its handler', async () => {
  const original = workflowHandlers.handleWorkflowTool;
  const seen = [];
  workflowHandlers.handleWorkflowTool = async (toolName, args, context) => {
    seen.push({ toolName, args, context });
    return { isError: false, content: [{ type: 'text', text: 'stub' }] };
  };

  try {
    await workflowModule().invoke(makeModuleContext());
  } finally {
    workflowHandlers.handleWorkflowTool = original;
  }

  assert.equal(seen.length, 1, 'the module must delegate to handleWorkflowTool');
  const { context } = seen[0];
  assert.equal(context.dryRun, true, 'dryRun must reach the handler (it was dropped before the fix)');
  assert.equal(
    typeof context.makeDryRunAuditResponse,
    'function',
    'the handler cannot answer a dry run without this seam'
  );
});

test('REV-150: the module still forwards dryRun=false unchanged for a real apply', async () => {
  const original = workflowHandlers.handleWorkflowTool;
  let observed = 'missing';
  workflowHandlers.handleWorkflowTool = async (_toolName, _args, context) => {
    observed = context.dryRun;
    return { isError: false, content: [{ type: 'text', text: 'stub' }] };
  };

  try {
    await workflowModule().invoke(makeModuleContext({ dryRun: false, args: { task: 'x', apply: true } }));
  } finally {
    workflowHandlers.handleWorkflowTool = original;
  }

  assert.equal(observed, false, 'a real apply must not be turned into a dry run');
});

// --- end to end: with dryRun wired through, the apply path performs no mutation ---

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
    dryRun: true,
    startedAt: Date.now(),
    parseUnifiedTaskType: (value) => (value === 'metadata' || value === 'hybrid' ? value : 'script'),
    isDeepAnalysisSatisfied: () => true,
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    asRecord,
    toGraphFromUnknown,
    safeGetSessionContext: async () => null,
    toStringField,
    writeJsonAndMarkdown: () => {},
    runRemoteScript: async () => ({ status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' }),
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, tool: toolName, planned: details }) }],
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

test('REV-150: a dry run of a low-risk apply reports a plan instead of applying', async () => {
  const res = await workflowHandlers.handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change',
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    makeWorkflowContext()
  );

  assert.equal(res.isError, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.dryRun, true, 'a dry run must answer with the dry-run audit response');
  assert.equal(payload.mutationApplied === true, false, 'no mutation may be applied under dryRun');
});

test('REV-150: a dry run of a remote apply never dispatches the background script', async () => {
  let remoteCalled = false;
  const res = await workflowHandlers.handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply a low-risk change remotely',
      apply: true,
      confirmDestructive: true,
      executionMode: 'remote',
      allowRemoteApply: true,
      script: 'gs.info("x");',
      remoteScript: 'gs.info("x");',
      rollbackEvidence: { revertSteps: ['git revert HEAD'] },
    },
    makeWorkflowContext({
      runRemoteScript: async () => {
        remoteCalled = true;
        return { status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' };
      },
    })
  );

  assert.equal(remoteCalled, false, 'the remote apply ran for real before the fix');
  assert.equal(res.isError, false);
  assert.equal(JSON.parse(res.content[0].text).dryRun, true);
});
