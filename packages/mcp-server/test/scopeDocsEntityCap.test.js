// SPDX-License-Identifier: GPL-3.0-or-later
//
// sync_generate_scope_docs documents at most 200 entities per type. The entities
// past the cap got no document and the payload did not say so, so a cut folder
// read as the whole scope.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleScopeKnowledgeTool } = require('../dist/handlers/scopeKnowledgeHandlers.js');

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function makeContext(entities) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    resolveScopeCode: async (scope) => scope || 'x_test_app',
    hydrateScopeKnowledgeInputs: async (_entities, graph) => ({
      entities,
      graph,
      sourceSummary: {},
      autodiscovered: false,
      serviceNowDiscovered: false,
    }),
    safeGetSessionContext: async () => null,
    asRecord,
    toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
    writeJsonAndMarkdown: () => {},
    writeTableDocs: () => [],
    writeScopeDocsBundle: (_scope, files) => files.map((file) => file.relativePath),
  };
}

const rules = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: `br-${i}`, name: `Rule ${i}`, metadataType: 'business_rule' }));

test('sync_generate_scope_docs reports the entities past the per-type cap', async () => {
  const res = await handleScopeKnowledgeTool(
    'sync_generate_scope_docs',
    { scope: 'x_test_app', includeFields: false },
    makeContext([...rules(205), { id: 'si-1', name: 'Util', metadataType: 'script_include' }])
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.files.filter((f) => f.includes('/business-rules/')).length, 200);
  assert.deepEqual(payload.entityDocsOmitted, { business_rule: 5 });
  assert.match(payload.note, /capped at 200 per type/);
});

test('sync_generate_scope_docs adds no omission report under the cap', async () => {
  const res = await handleScopeKnowledgeTool(
    'sync_generate_scope_docs',
    { scope: 'x_test_app', includeFields: false },
    makeContext(rules(200))
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.entityDocsOmitted, undefined);
  assert.equal(payload.note, undefined);
});
