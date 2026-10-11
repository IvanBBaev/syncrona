// SPDX-License-Identifier: GPL-3.0-or-later
//
// sync_generate_scope_docs writes one Markdown file per entity, named after the
// entity's normalized name. ServiceNow does not keep record names unique (two
// business rules called "Validate input" on different tables are routine), and
// normalization folds case and punctuation into "_", so distinct entities can
// map to the same file name. Each entity must still get its own document.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleScopeKnowledgeTool } = require('../dist/handlers/scopeKnowledgeHandlers.js');

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function makeContext(entities, written) {
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
    toGraphFromUnknown: (value) => ({
      nodes: Array.isArray(asRecord(value).nodes) ? value.nodes : [],
      edges: Array.isArray(asRecord(value).edges) ? value.edges : [],
    }),
    writeJsonAndMarkdown: () => {},
    writeTableDocs: () => [],
    writeScopeDocsBundle: (_scope, files) => {
      written.push(...files);
      return files.map((file) => file.relativePath);
    },
  };
}

test('sync_generate_scope_docs gives same-named entities separate documents', async () => {
  const entities = [
    { id: 'br-1', name: 'Validate input', metadataType: 'business_rule', tableName: 'incident' },
    { id: 'br-2', name: 'Validate input', metadataType: 'business_rule', tableName: 'problem' },
    { id: 'br-3', name: 'validate-input', metadataType: 'business_rule', tableName: 'task' },
  ];
  const written = [];
  const res = await handleScopeKnowledgeTool(
    'sync_generate_scope_docs',
    { scope: 'x_test_app', writeFiles: true, includeFields: false },
    makeContext(entities, written)
  );

  const ruleDocs = written.filter((file) => file.relativePath.startsWith('business-rules/'));
  assert.equal(ruleDocs.length, 3);
  const paths = new Set(ruleDocs.map((file) => file.relativePath));
  assert.equal(paths.size, 3, `entity docs overwrite each other: ${[...paths].join(', ')}`);
  for (const id of ['br-1', 'br-2', 'br-3']) {
    assert.equal(
      ruleDocs.some((file) => file.content.includes(`- id: ${id}`)),
      true,
      `no document for ${id}`
    );
  }

  const payload = JSON.parse(res.content[0].text);
  assert.equal(new Set(payload.files).size, payload.files.length, 'the reported file list repeats a path');
});
