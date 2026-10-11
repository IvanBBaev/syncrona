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
