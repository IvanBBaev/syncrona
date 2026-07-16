// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const babel = require('@babel/core');
const preset = require('../dist/index.js').default;
const { isReservedWord } = require('../dist/sanitizerHelper.js');

async function transform(source) {
  const result = await babel.transformAsync(source, {
    presets: [() => preset()],
    configFile: false,
    babelrc: false,
  });
  return result.code;
}

test('renames __proto__ identifiers (illegal in ServiceNow)', async () => {
  assert.equal(await transform('obj.__proto__ = base;'), 'obj.__proto_sn__ = base;');
  assert.equal(await transform('var __proto__ = 1;'), 'var __proto_sn__ = 1;');
});

test('moves reserved-word member access to bracket syntax', async () => {
  assert.equal(await transform('var v = record.class;'), 'var v = record["class"];');
  assert.equal(
    await transform('item.default.float = 1;'),
    'item["default"]["float"] = 1;'
  );
});

test('leaves already-computed reserved-word access untouched', async () => {
  const source = 'var w = record["class"];';
  assert.equal(await transform(source), source);
});

test('removes the "use strict" directive', async () => {
  assert.equal(await transform('"use strict";\nvar a = 1;'), 'var a = 1;');
});

test('applies all sanitizer rules together', async () => {
  assert.equal(
    await transform('"use strict";\nresult.__proto__ = source.int;'),
    'result.__proto_sn__ = source["int"];'
  );
});

test('isReservedWord matches Rhino reserved words only', () => {
  assert.equal(isReservedWord('class'), true);
  assert.equal(isReservedWord('goto'), true);
  assert.equal(isReservedWord('name'), false);
  // Object.prototype members must not count as reserved words.
  assert.equal(isReservedWord('hasOwnProperty'), false);
  assert.equal(isReservedWord('constructor'), false);
});
