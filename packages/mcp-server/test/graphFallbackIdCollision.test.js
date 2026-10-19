// SPDX-License-Identifier: GPL-3.0-or-later
// A record without an id gets a generated `record:<n>` node id. That id must
// never collide with the id of another record in the same graph.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDependencyGraph } = require('../dist/analysis/graph.js');

function scriptNodeIds(graph) {
  return graph.nodes.filter((n) => n.kind === 'script').map((n) => n.id);
}

test('a generated id does not take the id of a later record', () => {
  const graph = buildDependencyGraph([
    { name: 'Anonymous', script: '' },
    { id: 'record:1', name: 'Named', script: '' },
  ]);

  const ids = scriptNodeIds(graph);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.equal(graph.nodes.find((n) => n.id === 'record:1').label, 'Named');
});

test('a generated id does not take the id of an earlier record', () => {
  const graph = buildDependencyGraph([
    { id: 'record:2', name: 'Named', script: '' },
    { name: 'Anonymous', script: '' },
  ]);

  const ids = scriptNodeIds(graph);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});
