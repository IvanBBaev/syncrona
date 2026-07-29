// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../dist/index.js');

// Fixtures are created in a temp dir (outside the repo) so the package's own
// tsconfig.json is not picked up by the plugin's upward config lookup and so
// intentionally-broken fixtures never enter the package build.
function writeTs(t, fileName, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-typescript-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, source);
  return {
    filePath,
    targetField: 'script',
    ext: '.ts',
    sys_id: 'sys-id-1',
    scope: 'x_scope',
    tableName: 'sys_script_include',
  };
}

const VALID_SOURCE = 'const greeting: string = "hello";\nconst n: number = greeting.length;\n';

test('type-checks and transpiles TypeScript content', async (t) => {
  const context = writeTs(t, 'valid.ts', VALID_SOURCE);
  const result = await run(context, VALID_SOURCE, {});
  // The plugin pins target ES2021 (the ECMAScript level ServiceNow supports)
  // and suppresses the "use strict" prologue TypeScript 6 started emitting by
  // default, so `const` survives and the output starts with the code itself.
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('honors compilerOptions from sync.config.js options', async (t) => {
  const source = 'const x: number = 2 ** 3;\n';
  const context = writeTs(t, 'valid.ts', source);
  const result = await run(context, source, {
    compilerOptions: { target: 2 /* ts.ScriptTarget.ES2015 */ },
  });
  // The pinned ES2021 default would keep `**` as-is; only the ES2015 target
  // handed in through the plugin options downlevels it to Math.pow.
  assert.deepEqual(result, {
    success: true,
    output: 'const x = Math.pow(2, 3);\n',
  });
});

test('returns the content untouched when transpile is disabled', async (t) => {
  const context = writeTs(t, 'valid.ts', VALID_SOURCE);
  const result = await run(context, VALID_SOURCE, { transpile: false });
  assert.deepEqual(result, { success: true, output: VALID_SOURCE });
});

test('runs when the plugin rule declares no options at all', async (t) => {
  const context = writeTs(t, 'valid.ts', VALID_SOURCE);
  // `syncrona config add-plugin` can emit a rule with no `options` key, and
  // sync.config.js is never typechecked, so PluginManager forwards undefined
  // verbatim. Probing `transpile` on it then threw a TypeError.
  const result = await run(context, VALID_SOURCE);
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('does not contradict a tsconfig.json that sets module NodeNext', async (t) => {
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  // `module: "NodeNext"` implies `moduleResolution: NodeNext`. Forcing NodeJs on
  // top of it raises TS5109 -- an error about a combination this tsconfig never
  // contained, making a perfectly valid project unbuildable.
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'NodeNext' } })
  );
  const result = await run(context, VALID_SOURCE);
  assert.equal(result.success, true);
  assert.match(result.output, /greeting = "hello"/);
});

test('still resolves node_modules when the tsconfig implies Classic resolution', async (t) => {
  const source = 'import { greet } from "mylib";\nconst out: string = greet();\n';
  const context = writeTs(t, 'sample.ts', source);
  const dir = path.dirname(context.filePath);
  // `module: "ESNext"` with no explicit moduleResolution defaults to Classic,
  // which cannot see node_modules -- the reason the plugin overrides it at all.
  // The override must stay in place for this case.
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2017', module: 'ESNext' } })
  );
  fs.mkdirSync(path.join(dir, 'node_modules', 'mylib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'mylib', 'package.json'),
    JSON.stringify({ name: 'mylib', version: '1.0.0', types: 'index.d.ts' })
  );
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'mylib', 'index.d.ts'),
    'export declare function greet(): string;\n'
  );
  const result = await run(context, source, {});
  assert.equal(result.success, true);
});

test('throws a diagnostic summary on type errors', async (t) => {
  const source = 'const wrong: number = "nope";\n';
  const context = writeTs(t, 'invalid.ts', source);
  await assert.rejects(
    () => run(context, source, {}),
    (error) => {
      assert.match(error.message, /invalid\.ts \(1,7\)/);
      assert.match(error.message, /Type 'string' is not assignable to type 'number'/);
      return true;
    }
  );
});

test('type-checks the piped content, not the stale bytes on disk', async (t) => {
  // On disk: a type error. Down the pipeline an upstream plugin already produced
  // corrected content. Type-checking the disk copy would wrongly throw.
  const context = writeTs(t, 'sample.ts', 'const wrong: number = "nope";\n');
  const result = await run(context, VALID_SOURCE, {});
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('rejects when the piped content has a type error even if the disk is clean', async (t) => {
  // Mirror image: disk is valid, but the handed-in content is not.
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  await assert.rejects(
    () => run(context, 'const wrong: number = "nope";\n', {}),
    /Type 'string' is not assignable to type 'number'/
  );
});

test('converts raw JSON string-enum compilerOptions from tsconfig.json', async (t) => {
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  // A realistic tsconfig.json holds compilerOptions as raw JSON strings
  // (`target: "ES2017"`, `module: "ESNext"`, lib names). Passing these straight
  // into the compiler API makes TypeScript 5.5+ throw
  // ("target is a string value; tsconfig JSON must be parsed …"); they must be
  // converted to the numeric enum shape first.
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2017', module: 'ESNext', lib: ['ES2017', 'DOM'] },
    })
  );
  const result = await run(context, VALID_SOURCE, {});
  // target ES2017 keeps `const`; a successful, non-throwing transpile proves the
  // string enums were converted rather than handed raw to createProgram.
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('accepts a string target in plugin options without downgrading the emit', async (t) => {
  const source = 'export const x: number = 2 ** 3;\n';
  const context = writeTs(t, 'sample.ts', source);
  // The README documents plugin compilerOptions as "Same as compilerOptions in a
  // tsconfig.json file", where `target: "ES2021"` is the normal spelling. Merged
  // in unconverted, that string compares false against the numeric ScriptTarget
  // enum, so the implied module kind fell back to CommonJS and the emit gained
  // `exports.` references -- undefined in ServiceNow's Rhino engine.
  const result = await run(context, source, {
    compilerOptions: { target: 'ES2021' },
  });
  assert.deepEqual(result, {
    success: true,
    output: 'export const x = 2 ** 3;\n',
  });
});

test('rejects a plugin compilerOptions value TypeScript cannot parse', async (t) => {
  const source = 'const x: number = 1;\n';
  const context = writeTs(t, 'sample.ts', source);
  // A misspelled enum value must surface instead of silently sliding through as
  // an unusable raw string.
  await assert.rejects(
    () => run(context, source, { compilerOptions: { target: 'ES2099' } }),
    /--target/
  );
});

test('honors plugin compilerOptions in the type check, not only in the emit', async (t) => {
  const source = 'export function f(a) { return a; }\n';
  const context = writeTs(t, 'sample.ts', source);
  // The merge used to happen after the type check, so every documented knob that
  // configures or relaxes checking was inert and no push could be unblocked with
  // it.
  const result = await run(context, source, {
    compilerOptions: { noImplicitAny: false },
  });
  assert.equal(result.success, true);
  assert.match(result.output, /function f\(a\)/);
});

test('resolves the compilerOptions a tsconfig.json inherits through extends', async (t) => {
  const source = 'export const n: number = 1;\n';
  const context = writeTs(t, 'sample.ts', source);
  const dir = path.dirname(context.filePath);
  // `ts.readConfigFile` returns the raw JSON of the leaf config only -- a
  // `{ extends: ... }` tsconfig therefore contributed nothing and the file was
  // built with none of the project's options.
  fs.writeFileSync(
    path.join(dir, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2021', module: 'CommonJS' } })
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: './tsconfig.base.json' })
  );
  const result = await run(context, source, {});
  assert.equal(result.success, true);
  // The inherited `module: "CommonJS"` must reach the emit; without extends
  // resolution the plugin fell back to its ESM default.
  assert.match(result.output, /exports\.n/);
});

test('type-checks with the options a tsconfig.json inherits through extends', async (t) => {
  const source = 'export function f(a) { return a; }\n';
  const context = writeTs(t, 'sample.ts', source);
  const dir = path.dirname(context.filePath);
  // The same drop kept the inherited options out of the type check that hard-fails
  // the build: a project that switched `noImplicitAny` off in its shared base
  // config was still blocked by TS7006, which is on by default under TypeScript 6.
  fs.writeFileSync(
    path.join(dir, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { noImplicitAny: false } })
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: './tsconfig.base.json' })
  );
  const result = await run(context, source, {});
  assert.equal(result.success, true);
  assert.match(result.output, /function f\(a\)/);
});

test('fails loudly on a tsconfig.json it cannot parse', async (t) => {
  const source = 'const x: number = 1;\n';
  const context = writeTs(t, 'sample.ts', source);
  // The read error used to be dropped, so a broken tsconfig silently built on
  // defaults instead of stopping the push.
  fs.writeFileSync(path.join(path.dirname(context.filePath), 'tsconfig.json'), '[]\n');
  await assert.rejects(
    () => run(context, source, {}),
    /tsconfig\.json/
  );
});

test('does not crash on a tsconfig.json whose include matches no files', async (t) => {
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  // TS18003 only describes the file *set* the config selects; the plugin compiles
  // the single in-memory file it was handed, so an empty selection is not fatal.
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    JSON.stringify({ include: ['nowhere/**/*.ts'] })
  );
  const result = await run(context, VALID_SOURCE, {});
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('the README sync.config.js example loads and matches the real config schema', (t) => {
  // The documented example used to be a JavaScript SyntaxError (a bare
  // `name:"..."` inside the `plugins` array literal) wrapped in a `rules` object,
  // while packages/core requires `rules` to be an array -- so copying it into
  // sync.config.js produced a config that never loaded.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const block = readme.match(/```javascript\n([\s\S]*?)```/);
  assert.ok(block, 'README must document a sync.config.js example');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-typescript-plugin-readme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'sync.config.js');
  fs.writeFileSync(configPath, block[1]);
  const config = require(configPath);
  assert.ok(Array.isArray(config.rules), '"rules" must be an array');
  for (const rule of config.rules) {
    assert.ok(rule.match instanceof RegExp, '"match" must be a regular expression');
    assert.ok(Array.isArray(rule.plugins), '"plugins" must be an array');
    for (const plugin of rule.plugins) {
      assert.equal(typeof plugin, 'object');
      assert.equal(typeof plugin.name, 'string');
    }
  }
});

// REV-200: the README's "Order of Configurations" documented the precedence
// backwards -- it listed `sync.config.js` options first and said `tsconfig.json`
// then "override[s] any overlapping values". The implementation is the other way
// round: the tsconfig is the base and plugin options are merged on top. Nothing
// pinned either the behaviour or the prose, so the two could disagree forever.
// A user following the README would set `target` in plugin options expecting the
// project tsconfig to win, and get the opposite emit with no warning.
test('plugin compilerOptions override an overlapping tsconfig.json key', async (t) => {
  const source = 'const x: number = 2 ** 3;\n';
  const context = writeTs(t, 'sample.ts', source);
  // `**` is the probe: an ES2015 target downlevels it to Math.pow, ES2021 keeps it.
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2015' } })
  );
  const result = await run(context, source, { compilerOptions: { target: 'ES2021' } });
  assert.deepEqual(result, { success: true, output: 'const x = 2 ** 3;\n' });
});

test('plugin compilerOptions win even when they are the more conservative setting', async (t) => {
  // The mirror image, so the test cannot pass merely because ES2021 happens to be
  // the plugin's default: here the tsconfig asks for the newer target and loses.
  const source = 'const x: number = 2 ** 3;\n';
  const context = writeTs(t, 'sample.ts', source);
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2021' } })
  );
  const result = await run(context, source, { compilerOptions: { target: 'ES2015' } });
  assert.deepEqual(result, { success: true, output: 'const x = Math.pow(2, 3);\n' });
});

test('the README documents the precedence the implementation actually applies', (t) => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const section = readme.match(/### Order of Configurations\n([\s\S]*?)(?=\n## )/);
  assert.ok(section, 'README must document the order of configurations');
  const body = section[1];
  const tsconfigAt = body.indexOf('tsconfig.json');
  const pluginAt = body.indexOf('sync.config.js');
  assert.ok(tsconfigAt >= 0 && pluginAt >= 0, 'both configuration sources must be named');
  // The base is listed first and the winner last -- the order the merge really has.
  assert.ok(
    tsconfigAt < pluginAt,
    'the README must list tsconfig.json as the base and sync.config.js options as the override',
  );
});

test('a configured strict mode still emits the "use strict" prologue', async (t) => {
  // The other half of the prologue suppression: it is scoped to the case where the
  // user configured no strictness at all. Asking for `strict` must not be silently
  // dropped from the emit -- without this, "suppress the prologue" could regress
  // into "never emit a prologue" and every test above would still pass.
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  const result = await run(context, VALID_SOURCE, { compilerOptions: { strict: true } });
  assert.equal(result.success, true);
  assert.match(result.output, /^"use strict";/);
});

test('does not crash on a tsconfig.json that has no compilerOptions key', async (t) => {
  const context = writeTs(t, 'sample.ts', VALID_SOURCE);
  // A tsconfig alongside the fixture with no compilerOptions key used to throw
  // "Cannot set properties of undefined (setting 'rootDir')".
  fs.writeFileSync(
    path.join(path.dirname(context.filePath), 'tsconfig.json'),
    '{ "files": ["sample.ts"] }\n'
  );
  const result = await run(context, VALID_SOURCE, {});
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});
