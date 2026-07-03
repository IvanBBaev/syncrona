// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_HANDLER_MODULES, buildToolHandlerPipeline } = require('../dist/toolModules.js');
const { DEFAULT_GUARDRAIL_CONFIG } = require('../dist/policyConfig.js');

const EXPECTED_MODULE_NAMES = [
  'session',
  'workspace',
  'servicenow-crud',
  'insight',
  'metadata-analysis',
  'script-analysis',
  'health-planning',
  'scope-knowledge',
  'relation-onboarding',
  'workflow',
  'developer',
  'jira',
];

function makeContext(overrides = {}) {
  return {
    toolName: 'nonexistent_tool_xyz',
    args: {},
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, toolName, args, details }) }],
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

test('TOOL_HANDLER_MODULES exposes the full registry in stable order', () => {
  assert.ok(Array.isArray(TOOL_HANDLER_MODULES));
  assert.equal(TOOL_HANDLER_MODULES.length, EXPECTED_MODULE_NAMES.length);
  assert.deepEqual(
    TOOL_HANDLER_MODULES.map((m) => m.name),
    EXPECTED_MODULE_NAMES
  );
  for (const module of TOOL_HANDLER_MODULES) {
    assert.equal(typeof module.invoke, 'function');
  }
});

test('buildToolHandlerPipeline returns one invocation per registered module', () => {
  const ctx = makeContext();
  const pipeline = buildToolHandlerPipeline(ctx);
  assert.ok(Array.isArray(pipeline));
  assert.equal(pipeline.length, TOOL_HANDLER_MODULES.length);
  for (const invokeHandler of pipeline) {
    assert.equal(typeof invokeHandler, 'function');
  }
});

test('every module in the pipeline declines an unknown tool name (returns null)', async () => {
  const ctx = makeContext({ toolName: 'nonexistent_tool_xyz' });
  const pipeline = buildToolHandlerPipeline(ctx);

  for (let i = 0; i < pipeline.length; i += 1) {
    const result = await pipeline[i]();
    assert.equal(
      result,
      null,
      `module "${TOOL_HANDLER_MODULES[i].name}" should decline an unrecognized tool name`
    );
  }
});

test('individual module.invoke also declines an unknown tool name directly', async () => {
  const ctx = makeContext({ toolName: 'another_unknown_tool' });
  for (const module of TOOL_HANDLER_MODULES) {
    const result = await module.invoke(ctx);
    assert.equal(result, null, `module "${module.name}" should return null`);
  }
});

test('script-analysis module handles a real tool name end to end (pure, no network)', async () => {
  const ctx = makeContext({
    toolName: 'sn_analyze_script_architecture',
    args: { script: 'var gr = new GlideRecord("incident"); gr.query();' },
  });
  const pipeline = buildToolHandlerPipeline(ctx);
  const scriptAnalysisIndex = TOOL_HANDLER_MODULES.findIndex((m) => m.name === 'script-analysis');
  assert.ok(scriptAnalysisIndex >= 0);

  // Modules earlier in the pipeline must still decline this tool name.
  for (let i = 0; i < scriptAnalysisIndex; i += 1) {
    const result = await pipeline[i]();
    assert.equal(result, null, `module "${TOOL_HANDLER_MODULES[i].name}" should decline this tool`);
  }

  const response = await pipeline[scriptAnalysisIndex]();
  assert.ok(response, 'script-analysis module should claim sn_analyze_script_architecture');
  assert.equal(response.isError, false);
  assert.equal(response.content[0].type, 'text');
  assert.match(response.content[0].text, /architecture/i);
});

test('script-analysis module surfaces the guard-branch error for empty script', async () => {
  const ctx = makeContext({
    toolName: 'sn_analyze_script_architecture',
    args: { script: '   ' },
  });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'script-analysis');
  const response = await module.invoke(ctx);
  assert.ok(response);
  assert.equal(response.isError, true);
});

test('health-planning module handles sync_tool_contract_info using real local dependencies', async () => {
  const ctx = makeContext({ toolName: 'sync_tool_contract_info', args: {} });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'health-planning');
  const response = await module.invoke(ctx);
  assert.ok(response);
  assert.equal(response.isError, false);
  const parsed = JSON.parse(response.content[0].text);
  assert.equal(typeof parsed.contractVersion, 'string');
  assert.equal(parsed.server.name, 'syncrona-mcp-server');
  assert.ok(Array.isArray(parsed.tools.names));
  assert.ok(parsed.tools.names.length > 0);
});

test('developer module wires resolveScope/tableGet without throwing on unknown tool', async () => {
  const ctx = makeContext({ toolName: 'still_unknown', args: {} });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'developer');
  const response = await module.invoke(ctx);
  assert.equal(response, null);
});

test('developer module surfaces missing-args guard branch for sync_suggest_tests', async () => {
  const ctx = makeContext({ toolName: 'sync_suggest_tests', args: {} });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'developer');
  const response = await module.invoke(ctx);
  assert.ok(response);
  assert.equal(response.isError, true);
});

test('jira module declines unknown tool without projectDir side effects', async () => {
  const ctx = makeContext({ toolName: 'not_a_jira_tool', args: {} });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'jira');
  const response = await module.invoke(ctx);
  assert.equal(response, null);
});

test('workspace module wires allowFullNodeAccess/runCommand deps and declines unknown tool', async () => {
  const ctx = makeContext({
    toolName: 'unknown_workspace_tool',
    guardrailConfig: { ...DEFAULT_GUARDRAIL_CONFIG, allowFullNodeAccess: true },
  });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'workspace');
  const response = await module.invoke(ctx);
  assert.equal(response, null);
});

test('session module dry-run audit response wiring is reachable for sync_set_scope guard branch', async () => {
  const ctx = makeContext({ toolName: 'sync_set_scope', args: {}, dryRun: true });
  const module = TOOL_HANDLER_MODULES.find((m) => m.name === 'session');
  const response = await module.invoke(ctx);
  assert.ok(response);
  // Missing scope field is a guard error, independent of dryRun.
  assert.equal(response.isError, true);
});
