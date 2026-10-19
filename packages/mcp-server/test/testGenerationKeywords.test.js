// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { suggestAtfTest } = require('../dist/analysis/testGeneration.js');

test('suggestAtfTest does not report control-flow statements as methods', () => {
  const script = [
    'var Foo = Class.create();',
    'Foo.prototype = {',
    '  initialize: function() {},',
    '  run: function(a) {',
    '    if (a) {',
    '      return 1;',
    '    }',
    '    for (var i = 0; i < 3; i++) {',
    '      a++;',
    '    }',
    '    switch (a) {',
    '    }',
    '    return a;',
    '  },',
    "  type: 'Foo'",
    '};',
  ].join('\n');

  const suggestion = suggestAtfTest({ scriptIncludeName: 'Foo', script });
  assert.deepEqual(suggestion.methods.map((m) => m.name), ['run']);
  assert.ok(!/subject\.(if|for|switch)\(/.test(suggestion.atfTestScript));
});

test('suggestAtfTest ignores the word "class" in a header comment', () => {
  const script = [
    '/* Utility class for incident routing. */',
    'var IncidentRouter = Class.create();',
    'IncidentRouter.prototype = {',
    '  route: function(record) {},',
    "  type: 'IncidentRouter'",
    '};',
  ].join('\n');

  const suggestion = suggestAtfTest({ scriptIncludeName: 'IncidentRouter', script });
  assert.equal(suggestion.className, 'IncidentRouter');
  assert.match(suggestion.atfTestScript, /var subject = new IncidentRouter\(\);/);
});

test('suggestAtfTest still detects an ES6 class with an extends clause', () => {
  const script = 'class Child extends global.Base {\n  run(a) {\n    return a;\n  }\n}';
  const suggestion = suggestAtfTest({ scriptIncludeName: 'Child', script });
  assert.equal(suggestion.className, 'Child');
  assert.equal(suggestion.isClass, true);
});
