// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sparse and malformed input to the scope-knowledge index builder, the table
// impact-path summary and the Markdown renderer: name fallbacks, empty table
// names (an edge to "table:"), self-edges, non-array field lists and scheduled
// jobs with no id, name or affected table.
//
// No other test fed these shapes, so each of their arms was a never-executed
// range nested inside a loop body. Node's test runner merges per-process
// coverage in directory-read order, and its merge drops such a range whenever it
// meets a process whose enclosing block range is shaped differently. The
// uncovered-lines column of dist/analysis/scopeKnowledge.js therefore took nine
// different values over an unchanged tree, depending only on file order.
// Executing every arm here makes the reading a function of the code alone, and
// the assertions document what each arm is for: sparse rows fall back to a
// sensible name, malformed rows are dropped, never rendered blank.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildScopeKnowledgeIndex,
  renderScopeKnowledgeMarkdown,
  summarizeTableImpactPaths,
} = require('../dist/analysis.js');

const edge = (from, to, relation = 'reads') => ({ from, to, relation, why: `${from} ${relation} ${to}` });

test('dictionary rows fall back to name, rows missing a table or field name are dropped', () => {
  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [
      { metadataType: 'dictionary', tableName: 'x_tbl', name: 'u_by_name', reference: 'task' },
      { metadataType: 'dictionary', tableName: '', fieldName: 'u_orphan' },
      { metadataType: 'dictionary', tableName: 'x_tbl' },
      // A table entity with only a name still marks the table as in scope.
      { metadataType: 'table', name: 'task' },
    ],
    graph: { nodes: [], edges: [] },
  });

  assert.deepEqual(
    index.tableFields.map((row) => ({ tableName: row.tableName, fields: row.fields.map((f) => f.field) })),
    [{ tableName: 'x_tbl', fields: ['u_by_name'] }]
  );
  assert.deepEqual(index.referencedTables, [
    { targetTable: 'task', sourceTables: ['x_tbl'], sourceCount: 1, fieldCount: 1, relationCount: 0, inScope: true },
  ]);
});

test('table-to-table edges with an empty endpoint or the same table at both ends add no relation', () => {
  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [],
    graph: {
      nodes: [],
      edges: [
        edge('table:x_tbl', 'table:'),
        edge('table:', 'table:task'),
        edge('table:task', 'table:task'),
        edge('table:x_tbl', 'table:sys_user'),
      ],
    },
  });

  assert.deepEqual(index.referencedTables, [
    { targetTable: 'sys_user', sourceTables: ['x_tbl'], sourceCount: 1, fieldCount: 0, relationCount: 1, inScope: false },
  ]);
  assert.deepEqual(
    index.tableImpactPaths.map((p) => `${p.sourceTable}->${p.targetTable}`),
    ['x_tbl->sys_user']
  );
});

test('impact paths ignore edges to an unnamed table and pair every table a producer touches', () => {
  const paths = summarizeTableImpactPaths({
    nodes: [],
    edges: [
      edge('script:s', 'table:'),
      edge('script:s', 'table:incident'),
      edge('script:s', 'table:task', 'writes'),
      // A second edge from the same producer to a table it already touches.
      edge('script:s', 'table:incident', 'writes'),
    ],
  });

  assert.deepEqual(
    paths.map((p) => `${p.sourceTable}->${p.targetTable}`).sort(),
    ['incident->task', 'task->incident']
  );
  for (const p of paths) {
    assert.deepEqual(p.via, ['script:s']);
  }
});

test('the renderer skips unnamed tables, falls back to ids and dashes, and zeroes a bad confidence', () => {
  const md = renderScopeKnowledgeMarkdown({
    scope: 'x_nuvo_sync',
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-09T00:00:00.000Z',
    entities: [
      { id: 'record:br1', metadataType: 'business_rule' },
      { id: 'record:job', name: 'Nightly job', metadataType: 'scheduled_job', script: 'x'.repeat(150) },
      { metadataType: 'scheduled_job' },
    ],
    dependencyNodes: [],
    dependencies: [
      edge('record:job', 'table:'),
      edge('record:job', 'table:incident', 'writes'),
    ],
    hotspots: [],
    risks: [],
    suppressions: [],
    recommendedEditTargets: [],
    tableImpactPaths: [{ sourceTable: 'task', targetTable: 'incident', confidence: 'n/a' }],
    tableFields: [
      { tableName: 'x_empty', fields: 'not-a-list' },
      { tableName: 'x_tbl', fields: [{ field: 'u_bare' }] },
    ],
  });

  // An impact object without a name is headed by its id.
  assert.equal(md.includes('### record:br1\n'), true);
  // The edge to "table:" counts toward neither the table list nor the job.
  assert.equal(md.includes('## Table Dependencies\n- incident (1)\n\n'), true);
  assert.equal(md.includes('- Affected tables: incident\n'), true);
  assert.equal(md.includes(`- Script excerpt: ${'x'.repeat(140)}...\n`), true);
  // A job with neither id nor name is headed by a placeholder id.
  assert.equal(
    md.includes(
      '### record:unknown\n- Schedule: run_type=n/a, run_period=n/a, run_time=n/a\n' +
        '- Affected tables: none detected\n- Script excerpt: n/a\n'
    ),
    true
  );
  assert.equal(md.includes('- task -> incident (confidence=0.00)'), true);
  // A non-array field list renders the table header with no rows.
  assert.equal(
    md.includes('### x_empty\n| Field | Label | Type | Required | Reference |\n| --- | --- | --- | --- | --- |\n\n### x_tbl'),
    true
  );
  assert.equal(md.includes('| u_bare | - | - | no | - |'), true);
});
