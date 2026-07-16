// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../dist/index.js');

function makeProject(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-webpack-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), source);
  }
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

// mode "none" keeps the bundle unminified and free of environment-dependent
// production optimizations.
const OPTIONS = { webpackConfig: { mode: 'none' } };

test('bundles the entry file with its local dependencies into one script', async (t) => {
  const entrySource =
    'const { double } = require("./lib.js");\n' +
    'globalThis.__syncronaWebpackPluginResult = double(21);\n';
  const dir = makeProject(t, {
    'lib.js': 'module.exports.double = function (n) { return n * 2; };\n',
    'entry.js': entrySource,
  });
  // The pipeline hands the (possibly transformed) file bytes as `content`; the
  // plugin bundles those. Here content matches disk, exercising the common path.
  const result = await run(makeContext(path.join(dir, 'entry.js')), entrySource, OPTIONS);

  assert.equal(result.success, true);
  // The dependency's source is inlined; no module loader is left behind.
  assert.ok(result.output.includes('n * 2'));
  assert.ok(!result.output.includes('require("./lib.js")'));

  // The bundle is a self-contained script: executing it runs the entry.
  t.after(() => delete globalThis.__syncronaWebpackPluginResult);
  new Function(result.output)();
  assert.equal(globalThis.__syncronaWebpackPluginResult, 42);
});

test('applies webpack configuration from a webpack.config.js next to the entry', async (t) => {
  const entrySource =
    'const { double } = require("syncronalib");\n' +
    'globalThis.__syncronaWebpackPluginAliasResult = double(4);\n';
  const dir = makeProject(t, {
    'lib.js': 'module.exports.double = function (n) { return n * 2; };\n',
    'entry.js': entrySource,
    'webpack.config.js':
      'const path = require("path");\n' +
      'module.exports = {\n' +
      '  mode: "none",\n' +
      '  resolve: { alias: { syncronalib: path.join(__dirname, "lib.js") } },\n' +
      '};\n',
  });
  // No options passed: resolving "syncronalib" only works if the config file
  // sitting next to the entry was loaded and merged.
  const result = await run(makeContext(path.join(dir, 'entry.js')), entrySource, {});

  assert.equal(result.success, true);
  t.after(() => delete globalThis.__syncronaWebpackPluginAliasResult);
  new Function(result.output)();
  assert.equal(globalThis.__syncronaWebpackPluginAliasResult, 8);
});

test('throws when the bundle cannot be created', async (t) => {
  const brokenSource = 'require("./does-not-exist.js");\n';
  const dir = makeProject(t, {
    'broken.js': brokenSource,
  });
  await assert.rejects(
    () => run(makeContext(path.join(dir, 'broken.js')), brokenSource, OPTIONS),
    /Webpack failed to create the bundle/
  );
});

// REV-1: the plugin must bundle the `content` it was handed by the plugin chain,
// not re-open the (untransformed) file from disk.
test('bundles the passed-in content, not the file re-read from disk (REV-1)', async (t) => {
  const dir = makeProject(t, {
    // On disk the entry is deliberately un-parseable. If webpack re-read the
    // file from disk (the old bug) the compile would fail; the plugin must
    // bundle the transformed `content` it was handed instead.
    'entry.js': 'this is not valid javascript @@@ <<<\n',
  });
  const transformed =
    'globalThis.__syncronaWebpackPluginContentResult = 6 * 7;\n';
  const result = await run(
    makeContext(path.join(dir, 'entry.js')),
    transformed,
    OPTIONS
  );

  assert.equal(result.success, true);
  assert.ok(result.output.includes('6 * 7'));
  assert.ok(!result.output.includes('not valid javascript'));

  t.after(() => delete globalThis.__syncronaWebpackPluginContentResult);
  new Function(result.output)();
  assert.equal(globalThis.__syncronaWebpackPluginContentResult, 42);
});

// REV-1: overlaying the entry's content must not break resolution of the
// entry's relative dependencies — those still come from disk.
test('bundles content that requires a real on-disk dependency (REV-1 keeps disk resolution)', async (t) => {
  const dir = makeProject(t, {
    'lib.js': 'module.exports.triple = function (n) { return n * 3; };\n',
    // The on-disk entry is a stale copy; the transformed content is what must be
    // bundled, and its relative require must still resolve lib.js from disk.
    'entry.js': '// stale on-disk copy\n',
  });
  const transformed =
    'const { triple } = require("./lib.js");\n' +
    'globalThis.__syncronaWebpackPluginDepResult = triple(14);\n';
  const result = await run(
    makeContext(path.join(dir, 'entry.js')),
    transformed,
    OPTIONS
  );

  assert.equal(result.success, true);
  assert.ok(result.output.includes('n * 3'));

  t.after(() => delete globalThis.__syncronaWebpackPluginDepResult);
  new Function(result.output)();
  assert.equal(globalThis.__syncronaWebpackPluginDepResult, 42);
});

// Config-error distinction: a webpack.config.js that exists but fails to load
// must surface, not be silently swallowed (which would build a wrong bundle).
test('surfaces a webpack.config.js that throws on load instead of ignoring it', async (t) => {
  const entrySource = 'globalThis.__syncronaWebpackPluginCfgThrow = 1;\n';
  const dir = makeProject(t, {
    'entry.js': entrySource,
    'webpack.config.js':
      'throw new Error("boom from config");\nmodule.exports = {};\n',
  });
  // If the loader swallowed the error (the old bug) this would resolve with a
  // default-config bundle. It must reject with the config's own error.
  await assert.rejects(
    () => run(makeContext(path.join(dir, 'entry.js')), entrySource, OPTIONS),
    /boom from config/
  );
});

test('surfaces a webpack.config.js with a syntax error instead of building with defaults', async (t) => {
  const entrySource = 'globalThis.__syncronaWebpackPluginCfgSyntax = 1;\n';
  const dir = makeProject(t, {
    'entry.js': entrySource,
    // Unterminated object literal -> SyntaxError when the file is loaded.
    'webpack.config.js': 'module.exports = {\n',
  });
  await assert.rejects(() =>
    run(makeContext(path.join(dir, 'entry.js')), entrySource, OPTIONS)
  );
});

test('surfaces a webpack.config.js whose own dependency is missing (not treated as absent)', async (t) => {
  const entrySource = 'globalThis.__syncronaWebpackPluginCfgDep = 1;\n';
  const dir = makeProject(t, {
    'entry.js': entrySource,
    // The config file itself loads, but its require targets a module that does
    // not exist — a *different* not-found than "config absent", so it must
    // surface rather than fall back to defaults.
    'webpack.config.js':
      'require("syncrona-nonexistent-dependency-xyz");\nmodule.exports = {};\n',
  });
  await assert.rejects(
    () => run(makeContext(path.join(dir, 'entry.js')), entrySource, OPTIONS),
    /syncrona-nonexistent-dependency-xyz/
  );
});
