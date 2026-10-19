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

test('brackets every ES3 reserved word, including delete, typeof and in', async () => {
  assert.equal(await transform('set.delete(key);'), 'set["delete"](key);');
  assert.equal(
    await transform('var t = meta.typeof + meta.in + meta.function;'),
    'var t = meta["typeof"] + meta["in"] + meta["function"];'
  );
  for (const word of ['debugger', 'delete', 'export', 'function', 'in', 'typeof', 'with']) {
    assert.equal(isReservedWord(word), true, word);
  }
});

test('quotes reserved-word object literal keys', async () => {
  assert.equal(
    await transform('var o = { default: a, class: b, name: c };'),
    'var o = {\n  "default": a,\n  "class": b,\n  name: c\n};'
  );
});

test('quotes reserved-word keys of object methods and accessors', async () => {
  assert.equal(
    await transform('var o = { get default() { return 1; }, set class(v) {}, delete() {}, name() {} };'),
    'var o = {\n  get "default"() {\n    return 1;\n  },\n  set "class"(v) {},\n  "delete"() {},\n  name() {}\n};'
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

test('moves reserved-word optional member access to bracket syntax', async () => {
  assert.equal(await transform('var v = record?.class;'), 'var v = record?.["class"];');
});

test('isReservedWord covers exactly the ES3 keywords, future reserved words and literals', () => {
  const reserved = (
    'abstract boolean break byte case catch char class const continue debugger ' +
    'default delete do double else enum export extends false final finally float ' +
    'for function goto if implements import in instanceof int interface long ' +
    'native new null package private protected public return short static super ' +
    'switch synchronized this throw throws transient true try typeof var void ' +
    'volatile while with'
  ).split(' ');
  assert.equal(reserved.length, 59);
  for (const word of reserved) {
    assert.equal(isReservedWord(word), true, word);
  }
  // Later-edition keywords that ES3 did not reserve stay as dotted access.
  for (const word of ['let', 'yield', 'await', 'undefined', 'of', '']) {
    assert.equal(isReservedWord(word), false, word);
  }
});

test('turns a shorthand reserved-word property into a quoted key', async () => {
  assert.equal(
    await transform('var o = { default: x, "x": 1 };'),
    'var o = {\n  "default": x,\n  "x": 1\n};'
  );
});

test('keeps other directives when it removes "use strict"', async () => {
  assert.equal(
    await transform('"use strict";\n"custom";\nvar a = 1;'),
    '"custom";\n\nvar a = 1;'
  );
});

test('leaves a computed optional access with a reserved word untouched', async () => {
  const source = 'var v = record?.["class"];';
  assert.equal(await transform(source), source);
});
