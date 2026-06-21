const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleServiceNowCrudTool,
} = require('../dist/handlers/serviceNowCrudHandlers.js');

// These cases exercise the validation / confirmation / dry-run branches, which
// never reach the network (snRequest). Happy-path network calls are covered by
// the e2e/dispatch suites; here we lock the guard logic that protects the user.
function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  const flows = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    createAndSyncScriptInclude: async (params) => {
      flows.push(params);
      return { isFailure: false, name: params.name };
    },
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    _flows: flows,
    ...overrides,
  };
}

test('sn_query_records: missing table is a validation error', async () => {
  const res = await handleServiceNowCrudTool('sn_query_records', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: table/);
});

test('sn_create_record: missing table is a validation error', async () => {
  const res = await handleServiceNowCrudTool(
    'sn_create_record',
    { confirmDestructive: true },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: table/);
});

test('sn_create_record: without confirmDestructive it refuses to mutate', async () => {
  const res = await handleServiceNowCrudTool(
    'sn_create_record',
    { table: 'incident', record: { short_description: 'x' } },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('sn_create_record: dry-run routes through the audit-preview callback (no network)', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleServiceNowCrudTool(
    'sn_create_record',
    { table: 'incident', record: { short_description: 'x' }, confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.table, 'incident');
  assert.equal(ctx._audits.length, 0);
});

test('sn_execute_background_script: missing script is a validation error', async () => {
  const res = await handleServiceNowCrudTool(
    'sn_execute_background_script',
    { confirmDestructive: true },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: script/);
});

test('sn_execute_background_script: without confirmDestructive it refuses to run', async () => {
  const res = await handleServiceNowCrudTool(
    'sn_execute_background_script',
    { script: 'gs.info("hi")' },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('sn_execute_background_script: dry-run previews script length without running', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleServiceNowCrudTool(
    'sn_execute_background_script',
    { script: 'gs.info("hi")', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.scriptLength, 'gs.info("hi")'.length);
});

for (const tool of ['sync_create_script_include', 'sync_create_script_include_and_sync']) {
  test(`${tool}: without confirmDestructive it refuses to create`, async () => {
    const res = await handleServiceNowCrudTool(tool, { name: 'MyUtil' }, makeContext());
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /confirmDestructive=true/);
  });

  test(`${tool}: missing name is a validation error`, async () => {
    const res = await handleServiceNowCrudTool(
      tool,
      { confirmDestructive: true },
      makeContext()
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Missing required field: name/);
  });

  test(`${tool}: dry-run previews the script include without creating it`, async () => {
    const ctx = makeContext({ dryRun: true });
    const res = await handleServiceNowCrudTool(
      tool,
      { name: 'MyUtil', script: 'var x=1;', confirmDestructive: true },
      ctx
    );
    assert.equal(res.isError, false);
    assert.equal(ctx._dryRuns.length, 1);
    assert.equal(ctx._dryRuns[0].details.name, 'MyUtil');
    assert.equal(ctx._flows.length, 0, 'dry-run must not invoke the create flow');
  });

  test(`${tool}: real create delegates to createAndSyncScriptInclude and audits`, async () => {
    const ctx = makeContext({ dryRun: false });
    const res = await handleServiceNowCrudTool(
      tool,
      { name: 'MyUtil', script: 'var x=1;', confirmDestructive: true },
      ctx
    );
    assert.equal(res.isError, false);
    assert.equal(ctx._flows.length, 1);
    assert.equal(ctx._flows[0].name, 'MyUtil');
    assert.equal(ctx._audits.length, 1);
  });
}

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleServiceNowCrudTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
