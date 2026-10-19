const test = require('node:test');
const assert = require('node:assert/strict');

const { extractReferencesFromScript, buildDependencyGraph } = require('../dist/analysis/graph.js');

test('a scope-qualified constructor is read as an include', () => {
  const refs = extractReferencesFromScript(
    "var a = new global.ArrayUtil(); var b = new x_acme_util.Helper(); var c = new LocalThing();"
  );
  assert.deepEqual(refs.includes.sort(), ['LocalThing', 'global.ArrayUtil', 'x_acme_util.Helper'].sort());
});

test('platform namespaces are not read as scope-qualified includes', () => {
  const refs = extractReferencesFromScript(
    "var r = new sn_ws.RESTMessageV2('x', 'get'); var g = new GlideRecord('incident');"
  );
  assert.deepEqual(refs.includes, []);
});

test('a scope-qualified constructor becomes a cross-scope dependency', () => {
  const graph = buildDependencyGraph([
    {
      id: 'sys_script_include:own',
      type: 'sys_script_include',
      name: 'OwnUtil',
      scope: 'x_acme_app',
      script: 'var h = new x_acme_util.Helper(); var g = new global.ArrayUtil();',
    },
  ]);
  const targets = graph.edges.map((edge) => edge.to);
  assert.ok(targets.includes('external_scope:x_acme_util'), JSON.stringify(graph.edges));
  assert.ok(targets.includes('external_scope:global'), JSON.stringify(graph.edges));
});
