const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseReferenceTargetsFromAttributes,
  classifyRelationVisibility,
  mergeScopeKnowledgeGraph,
} = require('../dist/analysis/scopeDiscovery.js');

test('parseReferenceTargetsFromAttributes extracts and sorts unique targets', () => {
  const result = parseReferenceTargetsFromAttributes(
    'ref_table=incident,reference=sys_user, table=Incident'
  );
  // values are lowercased and de-duplicated, then sorted
  assert.deepEqual(result, ['incident', 'sys_user']);
});

test('parseReferenceTargetsFromAttributes returns empty for blank input', () => {
  assert.deepEqual(parseReferenceTargetsFromAttributes('   '), []);
  assert.deepEqual(parseReferenceTargetsFromAttributes(''), []);
});

test('classifyRelationVisibility maps why text to visibility tiers', () => {
  assert.equal(
    classifyRelationVisibility({ from: 'a', to: 'b', relation: 'reads', why: 'Dictionary reference to table' }),
    'explicit'
  );
  assert.equal(
    classifyRelationVisibility({ from: 'a', to: 'b', relation: 'belongs_to', why: 'Table inheritance chain' }),
    'explicit'
  );
  assert.equal(
    classifyRelationVisibility({ from: 'a', to: 'b', relation: 'reads', why: 'Dictionary attribute hint detected' }),
    'hidden'
  );
  assert.equal(
    classifyRelationVisibility({ from: 'a', to: 'b', relation: 'calls', why: 'Heuristic guess' }),
    'inferred'
  );
});

test('mergeScopeKnowledgeGraph dedupes nodes by id and edges by signature, sorted', () => {
  const base = {
    nodes: [
      { id: 'n2', kind: 'table', label: 'Two' },
      { id: 'n1', kind: 'script', label: 'One' },
    ],
    edges: [
      { from: 'n1', to: 'n2', relation: 'reads', why: 'base reason' },
    ],
  };
  const discovered = {
    nodes: [
      { id: 'n2', kind: 'table', label: 'Two-updated' },
      { id: 'n3', kind: 'api', label: 'Three' },
    ],
    edges: [
      { from: 'n1', to: 'n2', relation: 'reads', why: 'base reason' }, // duplicate edge signature
      { from: 'n2', to: 'n3', relation: 'calls', why: 'new reason' },
    ],
  };

  const merged = mergeScopeKnowledgeGraph(base, discovered);

  // nodes sorted by id, n2 overwritten by discovered value (last write wins)
  assert.deepEqual(merged.nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.equal(merged.nodes.find((n) => n.id === 'n2').label, 'Two-updated');

  // edges deduped to 2 unique signatures, sorted
  assert.equal(merged.edges.length, 2);
  assert.deepEqual(
    merged.edges.map((e) => `${e.from}->${e.to}`),
    ['n1->n2', 'n2->n3']
  );
});

test('mergeScopeKnowledgeGraph skips nodes without id and edges missing endpoints', () => {
  const base = { nodes: [{ id: '', kind: 'record', label: 'x' }], edges: [{ from: '', to: 'n2', relation: 'reads', why: 'r' }] };
  const discovered = { nodes: [{ id: 'n1', kind: 'record', label: 'y' }], edges: [{ from: 'n1', to: 'n2', relation: 'reads', why: 'r' }] };

  const merged = mergeScopeKnowledgeGraph(base, discovered);

  assert.deepEqual(merged.nodes.map((n) => n.id), ['n1']);
  assert.equal(merged.edges.length, 1);
  assert.equal(merged.edges[0].from, 'n1');
});
