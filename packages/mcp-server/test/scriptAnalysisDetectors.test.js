// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeSecurity } = require('../dist/analysis/scriptAnalysis.js');

function ids(result) {
  return result.findings.map((f) => f.id);
}

test('analyzeSecurity flags an encoded query concatenated with input', () => {
  assert.ok(ids(analyzeSecurity('gr.addEncodedQuery("active=true^" + input);')).includes('sec.encoded.query.concat'));
  assert.ok(ids(analyzeSecurity("gr.addEncodedQuery('name=' +input.name);")).includes('sec.encoded.query.concat'));
});

test('analyzeSecurity does not flag a constant encoded query', () => {
  assert.ok(!ids(analyzeSecurity('gr.addEncodedQuery("active=true");')).includes('sec.encoded.query.concat'));
});
