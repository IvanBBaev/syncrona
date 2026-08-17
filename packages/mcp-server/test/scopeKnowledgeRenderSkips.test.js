// SPDX-License-Identifier: GPL-3.0-or-later
//
// `renderScopeKnowledgeMarkdown` skips three kinds of malformed row: an impact
// path missing either endpoint, a dictionary entry with no table name, and a
// field with no field name. Until this file existed, no test fed the renderer
// such a row, so whether those three `continue` arms counted as covered was
// decided by V8's block-range reporting rather than by a test: repeated gate
// runs over an unchanged tree measured dist/analysis/scopeKnowledge.js at
// 95.39 / 85.26 three times out of four and 94.70 / 82.31 the fourth, with the
// difference being exactly these three arms appearing as uncovered ranges.
//
// A measurement the scheduler decides is not a measurement. The arms are pinned
// here by executing them, which also documents the contract they encode:
// malformed rows are dropped from the rendered document, never rendered blank.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderScopeKnowledgeMarkdown } = require('../dist/analysis.js');

// The renderer reads a plain index object, so the fixture is built by hand
// rather than through buildScopeKnowledgeIndex: the point is to hand it rows a
// well-formed index would never contain.
function indexWith(extra) {
  return {
    scope: 'x_nuvo_sync',
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-09T00:00:00.000Z',
    entities: [],
    dependencies: [],
    dependencyNodes: [],
    hotspots: [],
    risks: [],
    suppressions: [],
    recommendedEditTargets: [],
    ...extra,
  };
}

test('impact paths missing either endpoint are dropped from the rendered document', () => {
  const md = renderScopeKnowledgeMarkdown(
    indexWith({
      tableImpactPaths: [
        { sourceTable: '', targetTable: 'incident', confidence: 0.9 },
        { sourceTable: 'task', targetTable: '', confidence: 0.9 },
        { sourceTable: 'task', targetTable: 'incident', confidence: 0.5 },
      ],
    })
  );

  assert.equal(md.includes('- task -> incident (confidence=0.50)'), true);
  assert.equal(md.includes('->  ('), false);
  assert.equal(md.includes('-  -> '), false);
  // The section header is still rendered: a dropped row is not an empty section.
  assert.equal(md.includes('## Table-to-Table Impact Paths (with confidence)'), true);
  assert.equal(md.includes('- No inferred table-to-table impact paths available.'), false);
});

test('a dictionary entry with no table name is skipped, later entries still render', () => {
  const md = renderScopeKnowledgeMarkdown(
    indexWith({
      tableFields: [
        { tableName: '', fields: [{ field: 'number', label: 'Number', type: 'string' }] },
        { tableName: 'incident', fields: [{ field: 'number', label: 'Number', type: 'string' }] },
      ],
    })
  );

  assert.equal(md.includes('### incident'), true);
  assert.equal(md.includes('### \n'), false);
  // The nameless entry contributed no field table of its own: the one heading
  // above is followed by exactly one field-table header row.
  assert.equal(md.split('| Field | Label | Type | Required | Reference |').length - 1, 1);
});

test('a field with no field name is skipped, later fields of the same table still render', () => {
  const md = renderScopeKnowledgeMarkdown(
    indexWith({
      tableFields: [
        {
          tableName: 'incident',
          fields: [
            { field: '', label: 'Nameless', type: 'string' },
            { field: 'short_description', label: 'Short description', type: 'string', maxLength: '160' },
          ],
        },
      ],
    })
  );

  assert.equal(md.includes('| short_description | Short description | string(160) | no | - |'), true);
  assert.equal(md.includes('| Nameless |'), false);
  assert.equal(md.includes('|  | '), false);
});
