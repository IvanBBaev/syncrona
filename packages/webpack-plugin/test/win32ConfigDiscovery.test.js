// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const url = require('node:url');

const { run } = require('../dist/index.js');

// Seventh-wave re-examination of the refuted finding at src/index.ts:88.
// Deriving the config location by splitting the entry path on path.sep and
// prepending path.sep mangles every native-Windows entry path
// (C:\proj\src\entry.js -> \C:\proj\src\webpack.config.js). Dynamic import()
// classifies that string as a bare specifier and rejects it with
// ERR_INVALID_MODULE_SPECIFIER before webpack even starts, so on win32 the
// user's webpack.config.js could never load (and a raw C:\ path would fail
// too: the drive letter parses as a URL scheme). These tests force the path
// module to win32 semantics and pin that run() derives the config location
// next to the entry correctly and actually executes the discovered config.

const SENTINEL = 'win32-config-discovery-sentinel';

// The config the plugin must discover: a data: module, so the win32-patched
// path module never touches the real (posix) filesystem. Its default export
// throws, proving run() imported AND invoked the user's config.
const SENTINEL_CONFIG_URL =
  'data:text/javascript,' +
  encodeURIComponent(
    `export default () => { throw new Error(${JSON.stringify(SENTINEL)}); };`
  );

function makeContext(filePath) {
  return {
    filePath,
    targetField: 'script',
    ext: '.js',
    sys_id: 'sys-id-win32',
    scope: 'x_scope',
    tableName: 'sys_script_include',
  };
}

// Force the path functions the config-discovery code uses onto win32
// semantics (the module object is the same singleton the compiled plugin
// holds), and intercept pathToFileURL to observe which config path the plugin
// derives while serving the sentinel config for it. path.resolve stays
// unpatched: Node's own dynamic-import referrer normalization consults the
// same singleton, and a win32 resolve would break every import() issued from
// this (posix) process. Everything is restored before returning.
async function withWin32Paths(fn) {
  const savedPath = {
    sep: path.sep,
    join: path.join,
    dirname: path.dirname,
  };
  const savedPathToFileURL = url.pathToFileURL;
  const seenConfigPaths = [];
  path.sep = path.win32.sep;
  path.join = path.win32.join;
  path.dirname = path.win32.dirname;
  url.pathToFileURL = (p) => {
    seenConfigPaths.push(p);
    return { href: SENTINEL_CONFIG_URL };
  };
  try {
    await fn();
  } finally {
    Object.assign(path, savedPath);
    url.pathToFileURL = savedPathToFileURL;
  }
  return seenConfigPaths;
}

test('discovers and honors webpack.config.js next to a native win32 entry path', async () => {
  const entry = 'C:\\proj\\src\\entry.js';
  const seen = await withWin32Paths(() =>
    // The sentinel throwing is the proof the user's config was found, loaded,
    // and executed. The unfixed code instead rejected with
    // ERR_INVALID_MODULE_SPECIFIER for the mangled \C:\... specifier.
    assert.rejects(
      () => run(makeContext(entry), 'globalThis.__w32 = 1;\n', {}),
      new RegExp(SENTINEL)
    )
  );
  assert.equal(seen.length, 1);
  // The derived location must keep the drive letter and gain no leading
  // separator: it must resolve to the directory of the entry file.
  assert.equal(
    path.win32.resolve(seen[0]),
    'C:\\proj\\src\\webpack.config.js'
  );
});

test('derives the config location for a forward-slash win32 entry path', async () => {
  // Windows accepts forward slashes, and tooling frequently emits them. The
  // unfixed split on "\\" left such a path a single chunk and derived
  // \webpack.config.js.
  const entry = 'C:/proj/src/entry.js';
  const seen = await withWin32Paths(() =>
    assert.rejects(
      () => run(makeContext(entry), 'globalThis.__w32fs = 1;\n', {}),
      new RegExp(SENTINEL)
    )
  );
  assert.equal(seen.length, 1);
  assert.equal(
    path.win32.resolve(seen[0]),
    'C:\\proj\\src\\webpack.config.js'
  );
});
