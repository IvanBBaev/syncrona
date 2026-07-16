// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../dist/index.js');

function makeLintDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-eslint-plugin-'));
  // root: true stops ESLint from walking up into unrelated configs.
  fs.writeFileSync(
    path.join(dir, '.eslintrc.json'),
    JSON.stringify({
      root: true,
      parserOptions: { ecmaVersion: 2022 },
      rules: { 'no-unused-vars': 'error' },
    })
  );
  return dir;
}

function makeContext(filePath) {
  return {
    filePath,
    targetField: 'script',
    ext: '.js',
    sys_id: 'sys-id-1',
    scope: 'x_scope',
    tableName: 'sys_script_include',
  };
}

test('returns the content untouched when the file lints clean', async (t) => {
  const dir = makeLintDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'clean.js');
  const content = 'module.exports = function add(a, b) { return a + b; };\n';
  fs.writeFileSync(filePath, content);

  const result = await run(makeContext(filePath), content);
  assert.deepEqual(result, { success: true, output: content });
});

test('lints the handed-in content, not the stale bytes on disk', async (t) => {
  const dir = makeLintDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'transformed.js');
  // On disk: clean. Down the pipeline an upstream plugin rewrote the source
  // into code that trips no-unused-vars. The plugin must validate what it was
  // handed, so this rejects; reading the on-disk copy would wrongly pass.
  fs.writeFileSync(filePath, 'module.exports = function add(a, b) { return a + b; };\n');
  const transformed = 'var unusedValue = 1;\n';

  await assert.rejects(
    () => run(makeContext(filePath), transformed),
    (error) => {
      assert.match(error.message, /no-unused-vars/);
      assert.match(error.message, /unusedValue/);
      return true;
    }
  );
});

test('passes when the handed-in content is clean even if the disk bytes are dirty', async (t) => {
  const dir = makeLintDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'transformed.js');
  // Mirror image of the test above: on disk still dirty, but an upstream plugin
  // already fixed the content. Linting the disk copy would wrongly reject.
  fs.writeFileSync(filePath, 'var unusedValue = 1;\n');
  const transformed = 'module.exports = function add(a, b) { return a + b; };\n';

  const result = await run(makeContext(filePath), transformed);
  assert.deepEqual(result, { success: true, output: transformed });
});

test('throws with the lint report in the error instead of printing to stdout', async (t) => {
  const dir = makeLintDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'broken.js');
  const content = 'var unusedValue = 1;\n';
  fs.writeFileSync(filePath, content);

  // stdout is the MCP protocol channel in stdio mode; the plugin must never
  // write the report there (gap-analysis C2).
  const consoleLog = t.mock.method(console, 'log');
  const stdoutWrite = t.mock.method(process.stdout, 'write');

  await assert.rejects(
    () => run(makeContext(filePath), content),
    (error) => {
      assert.match(error.message, /ESLint errors in the code/);
      // The formatted report travels inside the thrown error.
      assert.match(error.message, /no-unused-vars/);
      assert.match(error.message, /unusedValue/);
      return true;
    }
  );

  assert.equal(consoleLog.mock.callCount(), 0);
  assert.equal(stdoutWrite.mock.callCount(), 0);
});
