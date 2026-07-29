// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 follow-up (REV-195): DRY_RUN_AWARE_TOOLS is hand-maintained, and four tools that
// declared `dryRun` in their public input schema AND branched on it were missing from it —
// so isEffectiveDryRun said false, auditToolCall stamped `dryRun: false` on a run that
// wrote nothing, and a forensic reader saw a real write where a simulation happened.
//
// Derive the expectation from the tool contract instead of restating the list: the input
// schema is the tool's public promise, so "declares dryRun" and "honours dryRun" must be
// the same set. A tool that gains one without the other fails here.
const test = require('node:test');
const assert = require('node:assert/strict');

const { MCP_TOOLS } = require('../dist/toolSchemas.js');
const { toolImplementsDryRun } = require('../dist/safetyPolicy.js');

const tools = MCP_TOOLS;

const declaresDryRun = (tool) =>
  !!(tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.dryRun);

test('REV-195: every tool declaring a dryRun input is registered as dry-run aware', () => {
  const declaringButUnaware = tools
    .filter((tool) => declaresDryRun(tool) && !toolImplementsDryRun(tool.name))
    .map((tool) => tool.name);

  assert.deepEqual(
    declaringButUnaware,
    [],
    `these tools promise dryRun in their input schema but are absent from DRY_RUN_AWARE_TOOLS, ` +
      `so isEffectiveDryRun/auditToolCall treat their simulations as real writes: ` +
      declaringButUnaware.join(', ')
  );
});

test('REV-195: every dry-run-aware tool declares the dryRun input it honours', () => {
  const awareButUndeclared = tools
    .filter((tool) => toolImplementsDryRun(tool.name) && !declaresDryRun(tool))
    .map((tool) => tool.name);

  assert.deepEqual(
    awareButUndeclared,
    [],
    `these tools honour dryRun but never declare it, so a client reading the contract ` +
      `cannot discover it: ` + awareButUndeclared.join(', ')
  );
});

test('REV-195: the four scope-knowledge writers are dry-run aware', () => {
  for (const name of [
    'sync_generate_scope_knowledge',
    'sync_generate_scope_docs',
    'sync_scope_knowledge_auto_update',
    'sync_generate_table_dependency_report',
  ]) {
    assert.equal(toolImplementsDryRun(name), true, `${name} must be dry-run aware`);
  }
});

test('REV-195: a tool that honours no dryRun is not silently treated as aware', () => {
  assert.equal(toolImplementsDryRun('sync_get_current_context'), false);
  assert.equal(toolImplementsDryRun('no_such_tool'), false);
});
