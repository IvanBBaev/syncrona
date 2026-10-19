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

const { analyzeArchitecture } = require('../dist/analysis/scriptAnalysis.js');

test('analyzeArchitecture flags an empty catch block', () => {
  assert.ok(ids(analyzeArchitecture('try { run(); } catch (e) {}')).includes('arch.empty.catch'));
  assert.ok(ids(analyzeArchitecture('try {\n  run();\n} catch (err) {\n}\n')).includes('arch.empty.catch'));
  assert.ok(ids(analyzeArchitecture('try { run(); } catch {}')).includes('arch.empty.catch'));
});

test('analyzeArchitecture does not flag a catch block that handles the error', () => {
  assert.ok(!ids(analyzeArchitecture('try { run(); } catch (e) { gs.error(e); }')).includes('arch.empty.catch'));
});
