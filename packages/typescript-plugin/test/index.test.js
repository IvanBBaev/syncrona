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
