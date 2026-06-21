const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleMetadataAnalysisTool,
} = require('../dist/handlers/metadataAnalysisHandlers.js');

// parseMetadataType is injected; stub it to accept a known type and reject the
// rest, so we can drive the validation branches without a live instance.
function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    parseMetadataType: (value) => (value === 'business_rule' ? 'business_rule' : null),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    ...overrides,
  };
}

test('sn_list_metadata_records: invalid recordType is rejected', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_list_metadata_records',
    { recordType: 'nope' },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid recordType/);
});

test('sn_get_metadata_record: missing sysId is rejected', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_get_metadata_record',
    { recordType: 'business_rule' },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /recordType\/sysId/);
});

test('sn_update_metadata_record: invalid recordType/sysId is rejected', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_update_metadata_record',
    { recordType: 'business_rule', confirmDestructive: true },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /recordType\/sysId/);
});

test('sn_update_metadata_record: without confirmDestructive it refuses', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_update_metadata_record',
    { recordType: 'business_rule', sysId: 'abc', updates: { name: 'x' } },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('sn_update_metadata_record: dry-run previews the payload without a PATCH', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleMetadataAnalysisTool(
    'sn_update_metadata_record',
    { recordType: 'business_rule', sysId: 'abc', updates: { name: 'x' }, confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.sysId, 'abc');
  assert.equal(ctx._audits.length, 0);
});

test('sn_build_dependency_graph: pure graph build over args (no network)', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_build_dependency_graph',
    { records: [{ sys_id: 'a', name: 'A' }, { sys_id: 'b', name: 'B' }] },
    makeContext()
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sn_build_dependency_graph: non-array records degrade to an empty graph', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_build_dependency_graph',
    { records: 'not-an-array' },
    makeContext()
  );
  assert.equal(res.isError, false);
});

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleMetadataAnalysisTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
