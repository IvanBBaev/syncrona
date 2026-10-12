// SPDX-License-Identifier: GPL-3.0-or-later
// A GlideAjax call qualified with `global.` names a global script include. It
// must show up as an external dependency even when the calling record carries no
// scope code, just as an unqualified include call does.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDependencyGraph } = require('../dist/analysis/graph.js');

test('a global-qualified GlideAjax target is a global dependency when the own scope is unknown', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:ui1',
      name: 'UI Script',
      metadataType: 'ui_script',
      script: "var ga = new GlideAjax('global.MyAjaxUtil');",
    },
  ]);

  const edge = graph.edges.find(
    (e) => e.from === 'record:ui1' && e.to === 'external_scope:global' && e.relation === 'global_dependency'
  );
  assert.ok(edge, 'expected a global_dependency edge');
  assert.match(edge.why, /global\.MyAjaxUtil/);
  assert.equal(graph.nodes.some((n) => n.id === 'external_scope:global'), true);
});

test('a global-qualified GlideAjax target from a scoped record stays a cross-scope dependency', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:ui2',
      name: 'UI Script',
      metadataType: 'ui_script',
      scopeCode: 'x_acme_app',
      script: "var ga = new GlideAjax('global.MyAjaxUtil');",
    },
  ]);

  const external = graph.edges.filter((e) => e.from === 'record:ui2' && e.to === 'external_scope:global');
  assert.deepEqual(external.map((e) => e.relation), ['cross_scope_dependency']);
});

test('a global-qualified GlideAjax target from a global record is not external', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:ui3',
      name: 'UI Script',
      metadataType: 'ui_script',
      scopeCode: 'global',
      script: "var ga = new GlideAjax('global.MyAjaxUtil');",
    },
  ]);

  assert.equal(graph.edges.some((e) => e.to.startsWith('external_scope:')), false);
});
