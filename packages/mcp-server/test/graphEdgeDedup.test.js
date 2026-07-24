// SPDX-License-Identifier: GPL-3.0-or-later
// REV-90 regression: pushUniqueEdge is now backed by a Set of edge keys (O(E)
// dedup) rather than a per-insert linear scan (O(E^2)). These tests lock in the
// dedup *behaviour* so the Set-based rewrite stays byte-for-byte equivalent to
// the old scan: identical (from|to|relation|why) tuples collapse to one edge,
// while edges that differ in any component are all preserved.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDependencyGraph } = require('../dist/analysis/graph.js');

test('REV-90: identical records collapse to a single edge per unique tuple', () => {
  const record = {
    id: 'record:dup',
    name: 'Dup',
    table: 'incident',
    updateSet: 'US1',
    script: 'new GlideRecord("task"); new GlideRecord("task");',
  };
  // Five identical records share the same id, so every emitted edge has the same
  // `from`; without dedup this would push five copies of each edge.
  const graph = buildDependencyGraph([record, { ...record }, { ...record }, { ...record }, { ...record }]);

  const readsTask = graph.edges.filter(
    (e) => e.from === 'record:dup' && e.to === 'table:task' && e.relation === 'reads'
  );
  const belongsIncident = graph.edges.filter(
    (e) => e.from === 'record:dup' && e.to === 'table:incident' && e.relation === 'belongs_to'
  );
  const containsUpdateSet = graph.edges.filter(
    (e) => e.from === 'record:dup' && e.to === 'update_set:US1' && e.relation === 'contains'
  );

  assert.equal(readsTask.length, 1, 'GlideRecord("task") edge deduped to one');
  assert.equal(belongsIncident.length, 1, 'belongs_to table edge deduped to one');
  assert.equal(containsUpdateSet.length, 1, 'contains update_set edge deduped to one');
});

test('REV-90: dedup keys on the full tuple — distinct sources are NOT collapsed', () => {
  // 50 distinct records that each read the same table: distinct `from`, so 50
  // distinct edges must survive (guards against over-dedup by the Set).
  const records = Array.from({ length: 50 }, (_, i) => ({
    id: `record:d${i}`,
    name: `D${i}`,
    script: 'new GlideRecord("common");',
  }));
  const graph = buildDependencyGraph(records);

  const readsCommon = graph.edges.filter((e) => e.to === 'table:common' && e.relation === 'reads');
  assert.equal(readsCommon.length, 50);
  assert.equal(new Set(readsCommon.map((e) => e.from)).size, 50);
});

test('REV-90: same source + same target but different relation/why stay separate edges', () => {
  // A record that both *reads* table:widget via script and *affects* it via a
  // declared meta relation: same from/to, different relation+why -> two edges.
  const graph = buildDependencyGraph([
    {
      id: 'record:multi',
      name: 'Multi',
      script: 'new GlideRecord("widget");',
      metaRelations: ['table:widget', 'table:widget'],
    },
  ]);

  const toWidget = graph.edges.filter((e) => e.from === 'record:multi' && e.to === 'table:widget');
  const relations = toWidget.map((e) => e.relation).sort();
  assert.deepEqual(relations, ['affects', 'reads']);
  // the repeated 'table:widget' meta relation still collapses to one affects edge
  assert.equal(toWidget.filter((e) => e.relation === 'affects').length, 1);
});

test('REV-90: dedup holds at volume — many duplicate pushes yield one edge', () => {
  const shared = { id: 'record:shared', name: 'Shared', script: 'new GlideRecord("t");' };
  const graph = buildDependencyGraph(Array.from({ length: 500 }, () => ({ ...shared })));

  const readsT = graph.edges.filter(
    (e) => e.from === 'record:shared' && e.to === 'table:t' && e.relation === 'reads'
  );
  assert.equal(readsT.length, 1);
  // and the whole edge set carries no duplicate tuples
  const keys = graph.edges.map((e) => `${e.from}|${e.to}|${e.relation}|${e.why}`);
  assert.equal(keys.length, new Set(keys).size);
});
