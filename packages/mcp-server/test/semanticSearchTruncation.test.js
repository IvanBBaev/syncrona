// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMetadataAnalysisTool } = require('../dist/handlers/metadataAnalysisHandlers.js');

function contextWith(symbols) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    parseMetadataType: () => null,
    makeDryRunAuditResponse: () => {
      throw new Error('unexpected');
    },
    auditMutatingTool: () => {},
    getLastSemanticIndex: async () => symbols,
    setLastSemanticIndex: () => {},
  };
}

const symbols = Array.from({ length: 250 }, (_, i) => ({
  name: `handler${i}`,
  kind: 'function',
  file: `src/f${i}.js`,
  line: 1,
}));

test('sync_search_semantic_index reports truncation past the match cap', async () => {
  const res = await handleMetadataAnalysisTool('sync_search_semantic_index', { query: 'handler' }, contextWith(symbols));
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.count, 200);
  assert.equal(body.total, 250);
  assert.equal(body.truncated, true);
});

test('sync_search_semantic_index reports a complete result as not truncated', async () => {
  const res = await handleMetadataAnalysisTool('sync_search_semantic_index', { query: 'handler24' }, contextWith(symbols));
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.count, 11);
  assert.equal(body.total, 11);
  assert.equal(body.truncated, false);
});
