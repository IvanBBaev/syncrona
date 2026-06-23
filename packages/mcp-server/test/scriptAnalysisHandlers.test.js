// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleScriptAnalysisTool,
} = require('../dist/handlers/scriptAnalysisHandlers.js');

// Stub context: the script-analysis tools are pure (no network); only the
// dry-run / audit callbacks are side effects, which we capture here.
function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  return {
    dryRun: false,
    startedAt: Date.now(),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return {
        isError: false,
        content: [{ type: 'text', text: `dry-run:${toolName}` }],
      };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    ...overrides,
  };
}

const SAMPLE = 'var u = gs.getUser();\ncurrent.update();\nfor (var i=0;i<10;i++){ new GlideRecord("x"); }';

const ANALYSIS_TOOLS = [
  'sn_analyze_script_architecture',
  'sn_analyze_script_security',
  'sn_analyze_script_performance',
  'sn_analyze_script_full',
];

for (const tool of ANALYSIS_TOOLS) {
  test(`${tool}: returns parseable analysis for a non-empty script`, () => {
    const res = handleScriptAnalysisTool(tool, { script: SAMPLE }, makeContext());
    assert.ok(res, 'handler should return a response');
    assert.equal(res.isError, false);
    assert.equal(res.content[0].type, 'text');
    assert.doesNotThrow(() => JSON.parse(res.content[0].text));
  });

  test(`${tool}: flags an empty script as an error`, () => {
    const res = handleScriptAnalysisTool(tool, { script: '   ' }, makeContext());
    assert.equal(res.isError, true);
  });

  test(`${tool}: missing script field is treated as empty (error)`, () => {
    const res = handleScriptAnalysisTool(tool, {}, makeContext());
    assert.equal(res.isError, true);
  });
}

test('sn_analyze_script_full: honors suppressedIds and nowIso without throwing', () => {
  const res = handleScriptAnalysisTool(
    'sn_analyze_script_full',
    { script: SAMPLE, suppressedIds: ['x', 1, 'y'], nowIso: '2026-06-21T00:00:00Z' },
    makeContext()
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sn_autonomous_remediation_workflow: apply without confirmDestructive is blocked', () => {
  const res = handleScriptAnalysisTool(
    'sn_autonomous_remediation_workflow',
    { script: SAMPLE, apply: true },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('sn_autonomous_remediation_workflow: dry-run routes through the audit-preview callback', () => {
  const ctx = makeContext({ dryRun: true });
  const res = handleScriptAnalysisTool(
    'sn_autonomous_remediation_workflow',
    { script: SAMPLE, apply: true, confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].toolName, 'sn_autonomous_remediation_workflow');
  assert.equal(ctx._audits.length, 0, 'dry-run must not write an audit event');
});

test('sn_autonomous_remediation_workflow: apply=true audits the mutation', () => {
  const ctx = makeContext({ dryRun: false });
  const res = handleScriptAnalysisTool(
    'sn_autonomous_remediation_workflow',
    { script: SAMPLE, apply: true, confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._audits.length, 1);
  assert.equal(ctx._audits[0].toolName, 'sn_autonomous_remediation_workflow');
});

test('sn_autonomous_remediation_workflow: non-apply analysis does not audit', () => {
  const ctx = makeContext({ dryRun: false });
  const res = handleScriptAnalysisTool(
    'sn_autonomous_remediation_workflow',
    { script: SAMPLE },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._audits.length, 0);
});

test('unknown tool returns null so dispatch can fall through', () => {
  const res = handleScriptAnalysisTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
