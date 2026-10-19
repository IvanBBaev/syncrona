// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { run } = require('../dist/index.js');

// Deterministic baseline: no config files, no plugins from the environment.
const BASE_OPTIONS = { configFile: false, babelrc: false };

function makeContext() {
  return {
    filePath: '/virtual/src/script.js',
    targetField: 'script',
    ext: '.js',
    sys_id: 'sys-id-1',
    scope: 'x_scope',
    tableName: 'sys_script_include',
  };
}

test('transforms content through Babel and returns the printed code', async () => {
  const result = await run(makeContext(), 'const x=1;;', { ...BASE_OPTIONS });
  assert.deepEqual(result, {
    output: 'const x = 1;\n;',
    success: true,
  });
});

test('honors plugins passed through sync.config.js options', async () => {
  const renameFoo = {
    visitor: {
      Identifier(p) {
        if (p.node.name === 'foo') {
          p.node.name = 'bar';
        }
      },
    },
  };
  const result = await run(makeContext(), 'foo();', {
    ...BASE_OPTIONS,
    plugins: [renameFoo],
  });
  assert.deepEqual(result, { output: 'bar();', success: true });
});

test('derives the Babel filename from targetField and ext', async () => {
  let seenFilename;
  const capture = {
    visitor: {
      Program(p, state) {
        seenFilename = state.filename;
      },
    },
  };
  await run(makeContext(), 'const a = 1;', {
    ...BASE_OPTIONS,
    plugins: [capture],
  });
  assert.equal(path.basename(seenFilename), 'script.js');
});

test('reports failure with empty output when Babel produces no code', async () => {
  const result = await run(makeContext(), 'const y = 2;', {
    ...BASE_OPTIONS,
    code: false,
  });
  assert.deepEqual(result, { output: '', success: false });
});

test('treats an empty transform result as success, not a build failure', async () => {
  // A comment-only or empty source transforms to '' — a legitimate empty field,
  // not a failure. The old `if (res && res.code)` guard treated '' as falsy and
  // aborted the build.
  const result = await run(makeContext(), '// just a comment\n', {
    ...BASE_OPTIONS,
    comments: false,
  });
  assert.deepEqual(result, { output: '', success: true });
});

test('does not mutate the caller-supplied options object', async () => {
  const options = { ...BASE_OPTIONS };
  await run(makeContext(), 'const a = 1;', options);
  // `filename` must not leak back into the shared options handed to every file.
  assert.equal('filename' in options, false);
});
