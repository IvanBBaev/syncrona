// SPDX-License-Identifier: GPL-3.0-or-later
// A scope name may contain underscores (x_acme_my_app). A GlideRecord on one of
// the scope's own tables must not be reported as a cross-scope dependency just
// because the table-name pattern splits the scope at the wrong underscore.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDependencyGraph } = require('../dist/analysis/graph.js');

test('a table of the own multi-underscore scope is not a cross-scope dependency', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:br1',
      name: 'BR',
      scopeCode: 'x_acme_my_app',
      script: "var gr = new GlideRecord('x_acme_my_app_task'); gr.query();",
    },
  ]);

  assert.equal(graph.edges.some((e) => e.relation === 'cross_scope_dependency'), false);
  assert.equal(graph.nodes.some((n) => n.kind === 'external_scope'), false);
  assert.equal(
    graph.edges.some((e) => e.to === 'table:x_acme_my_app_task' && e.relation === 'reads'),
    true
  );
});

test('a table of another scope is still a cross-scope dependency', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:br1',
      name: 'BR',
      scopeCode: 'x_acme_my_app',
      script: "var gr = new GlideRecord('x_other_app_task');",
    },
  ]);

  assert.equal(
    graph.edges.some(
      (e) => e.relation === 'cross_scope_dependency' && e.to === 'external_scope:x_other_app'
    ),
    true
  );
});
