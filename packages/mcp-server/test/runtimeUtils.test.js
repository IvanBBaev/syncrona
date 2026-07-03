// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeQueryValue } = require('../dist/runtimeUtils.js');

// `^` is the condition separator in a ServiceNow encoded query. A user-controlled
// value carrying a caret could otherwise smuggle extra conditions (e.g. flip a
// scoped lookup into an instance-wide one). escapeQueryValue must neutralize it.
test('escapeQueryValue: replaces caret condition separators with spaces', () => {
  assert.equal(escapeQueryValue('x_app^sys_id=ADMIN'), 'x_app sys_id=ADMIN');
});

test('escapeQueryValue: neutralizes every caret, including ^OR / ^NQ', () => {
  assert.equal(
    escapeQueryValue('a^ORb^NQc'),
    'a ORb NQc'
  );
});

test('escapeQueryValue: leaves a benign value untouched', () => {
  assert.equal(escapeQueryValue('x_my_scope'), 'x_my_scope');
});

test('escapeQueryValue: handles an empty string', () => {
  assert.equal(escapeQueryValue(''), '');
});
