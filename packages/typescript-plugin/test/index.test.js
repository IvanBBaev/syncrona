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
  assert.deepEqual(result, {
    success: true,
    output: 'var greeting = "hello";\nvar n = greeting.length;\n',
  });
});

test('honors compilerOptions from sync.config.js options', async (t) => {
  const context = writeTs(t, 'valid.ts', VALID_SOURCE);
  const result = await run(context, VALID_SOURCE, {
    compilerOptions: { target: 99 /* ts.ScriptTarget.ESNext */ },
  });
  assert.deepEqual(result, {
    success: true,
    output: 'const greeting = "hello";\nconst n = greeting.length;\n',
  });
});

test('returns the content untouched when transpile is disabled', async (t) => {
  const context = writeTs(t, 'valid.ts', VALID_SOURCE);
  const result = await run(context, VALID_SOURCE, { transpile: false });
  assert.deepEqual(result, { success: true, output: VALID_SOURCE });
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
    output: 'var greeting = "hello";\nvar n = greeting.length;\n',
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
    output: 'var greeting = "hello";\nvar n = greeting.length;\n',
  });
});
