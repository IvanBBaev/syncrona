// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../dist/index.js');

function makeContext(t, fileName = 'sample.js') {
  // A real file path outside the repo so no project .prettierrc leaks into
  // the golden expectations; explicit options below pin the format.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-prettier-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, '');
  return {
    filePath,
    targetField: 'script',
    ext: path.extname(fileName),
    sys_id: 'sys-id-1',
    scope: 'x_scope',
    tableName: 'sys_script_include',
  };
}

const PINNED_OPTIONS = { semi: true, tabWidth: 2, singleQuote: false };

test('formats JavaScript content with Prettier', async (t) => {
  const result = await run(makeContext(t), 'const   x=  {a:1,b:2}', PINNED_OPTIONS);
  assert.deepEqual(result, {
    success: true,
    output: 'const x = { a: 1, b: 2 };\n',
  });
});

test('infers the parser from the file path extension', async (t) => {
  const result = await run(
    makeContext(t, 'sample.json'),
    '{"b":2,   "a":1}',
    PINNED_OPTIONS
  );
  assert.deepEqual(result, {
    success: true,
    output: '{ "b": 2, "a": 1 }\n',
  });
});

test('returns empty output for empty content without invoking Prettier', async (t) => {
  const result = await run(makeContext(t), '', PINNED_OPTIONS);
  assert.deepEqual(result, { success: true, output: '' });
});
