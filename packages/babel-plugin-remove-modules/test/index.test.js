// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const babel = require('@babel/core');
const removeModules = require('../dist/index.js').default;

// The plugin factory keeps per-instance comment-usage state and Babel caches
// plugin instances by identity, so each transform gets a fresh instance to
// stay order-independent.
async function transform(source) {
  const result = await babel.transformAsync(source, {
    plugins: [() => removeModules()],
    configFile: false,
    babelrc: false,
  });
  return result.code;
}

test('strips import declarations and unwraps named export declarations', async () => {
  const source = [
    'import { one } from "./numbers";',
    'import Helper from "./helper";',
    'export function bar() { return one() + Helper; }',
  ].join('\n');
  assert.equal(await transform(source), 'function bar() {\n  return one() + Helper;\n}');
});

test('removes export lists without a declaration', async () => {
  const source = 'const two = 2;\nexport { two };';
  assert.equal(await transform(source), 'const two = 2;');
});

test('keeps imports tagged with @keepModule', async () => {
  const source = '//@keepModule\nimport { keep } from "keep-me";\nkeep();';
  assert.equal(await transform(source), source);
});

test('keeps imports tagged with @keepModule followed by prose', async () => {
  // A directive is normally written with an explanation after it. The prose must
  // not become part of the tag name, otherwise the tag is not recognized and the
  // import is stripped despite the directive, leaving `keep` dangling.
  const source = [
    '//@keepModule needed by the scoped API',
    'import { keep } from "keep-me";',
    'keep();',
  ].join('\n');
  assert.equal(await transform(source), source);
});

test('@expandModule followed by prose still expands references', async () => {
  const source = [
    '//@expandModule shared util',
    'import { part1 } from "myModule";',
    'part1.init();',
  ].join('\n');
  assert.equal(
    await transform(source),
    '//@expandModule shared util\n\nmyModule.part1.init();'
  );
});

test('does not fuse a tag comment with the plain comment on the next line', async () => {
  // Both comments attach to the import as leading comments. Their bodies carry
  // no trailing newline, so joining them without a separator would read as the
  // single tag "@keepModuleneeded" and the import would be wrongly stripped.
  const source = [
    '//@keepModule',
    '//needed by the platform',
    'import { helper } from "./util";',
    'helper();',
  ].join('\n');
  assert.equal(await transform(source), source);
});

test('@expandModule rewrites references to <module>.<import>', async () => {
  const source = [
    '//@expandModule',
    'import { expand } from "expander";',
    'function use() { return expand(); }',
  ].join('\n');
  assert.equal(
    await transform(source),
    '//@expandModule\n\nfunction use() {\n  return expander.expand();\n}'
  );
});

test('@expandModule renames an aliased import to <module>.<original name>', async () => {
  // `import { foo as bar }` binds `bar` in scope; expansion must rename the
  // local binding `bar` (not the original export `foo`, which is not in scope)
  // to the qualified `mod.foo`, otherwise `bar` is left dangling/undefined.
  const source = [
    '//@expandModule',
    'import { foo as bar } from "mod";',
    'function use() { return bar(); }',
  ].join('\n');
  const output = await transform(source);
  assert.equal(
    output,
    '//@expandModule\n\nfunction use() {\n  return mod.foo();\n}'
  );
  assert.doesNotMatch(output, /\bbar\b/, 'aliased local binding must not dangle');
});

test('@moduleAlias overrides the expansion prefix', async () => {
  const source = [
    '//@expandModule @moduleAlias=Ali',
    'import { aliased } from "aliased-module";',
    'function use() { return aliased(); }',
  ].join('\n');
  assert.equal(
    await transform(source),
    '//@expandModule @moduleAlias=Ali\n\nfunction use() {\n  return Ali.aliased();\n}'
  );
});

test('names anonymous default-exported functions and classes', async () => {
  assert.equal(
    await transform('export default function () { return 1; }'),
    'function _temp() {\n  return 1;\n}'
  );
  assert.equal(
    await transform('export default class { m() { return 2; } }'),
    'class _temp {\n  m() {\n    return 2;\n  }\n}'
  );
});

test('drops identifier default exports but keeps the declaration', async () => {
  const source = 'const impl = 3;\nexport default impl;';
  assert.equal(await transform(source), 'const impl = 3;');
});

test('unwraps exported const declarations', async () => {
  assert.equal(await transform('export const VALUE = 4;'), 'const VALUE = 4;');
});

test('does not leak comment-usage state across files sharing one plugin instance', async () => {
  // Babel caches a plugin instance by factory identity and reuses it for every
  // file in a build. Two files whose @keepModule comment sits at the same
  // line/column produce the same loc key; without a per-file reset the second
  // file's comment is treated as "already used", its tag is dropped, and its
  // import is wrongly stripped. Reuse ONE instance to exercise that real path
  // (the other tests intentionally create a fresh instance per transform).
  const shared = removeModules();
  const transformWithShared = async (source) => {
    const result = await babel.transformAsync(source, {
      plugins: [() => shared],
      configFile: false,
      babelrc: false,
    });
    return result.code;
  };

  const fileA = '//@keepModule\nimport { keep } from "keep-me";\nkeep();';
  const fileB = '//@keepModule\nimport { alsoKeep } from "also-keep";\nalsoKeep();';
  // fileA's and fileB's comments both live at line 1, column 0 (loc key "c0l1").
  assert.equal(await transformWithShared(fileA), fileA);
  // fileB must keep its import too — its tag must not be suppressed by fileA.
  assert.equal(await transformWithShared(fileB), fileB);
});
