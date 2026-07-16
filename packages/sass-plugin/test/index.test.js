// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../dist/index.js');

// Create a temp dir with an entrypoint path and (optionally) seed the on-disk
// bytes at that path. The plugin must compile the `content` it is handed, so the
// disk bytes and the passed content are deliberately allowed to disagree.
function makeContext(t, { ext = '.scss', diskBytes = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-sass-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, `sample${ext}`);
  fs.writeFileSync(filePath, diskBytes);
  return {
    dir,
    context: {
      filePath,
      targetField: 'css',
      ext,
      sys_id: 'sys-id-1',
      scope: 'x_scope',
      tableName: 'sp_css',
    },
  };
}

test('compiles the handed-in SCSS content (variables and nesting) to CSS', async (t) => {
  const { context } = makeContext(t);
  const result = await run(
    context,
    '$accent: #336699;\n.card {\n  .title { color: $accent; }\n}\n',
    {}
  );
  assert.deepEqual(result, {
    output: '.card .title {\n  color: #336699;\n}',
    success: true,
  });
});

test('compiles the piped content, not the stale bytes on disk', async (t) => {
  // On disk: one rule. Down the pipeline an upstream plugin rewrote the source
  // into a different rule. The plugin must compile what it was handed.
  const { context } = makeContext(t, { diskBytes: '.disk { color: red; }\n' });
  const result = await run(context, '.content { color: green; }\n', {});
  assert.deepEqual(result, {
    output: '.content {\n  color: green;\n}',
    success: true,
  });
});

test('compiles the handed-in content even when the disk bytes are broken', async (t) => {
  // Mirror image: disk is invalid SCSS, but an upstream plugin already produced
  // valid content. Compiling the disk copy would wrongly throw.
  const { context } = makeContext(t, {
    diskBytes: '.broken { color: $undefined-variable; }\n',
  });
  const result = await run(context, '.a { b: c; }\n', {});
  assert.deepEqual(result, { output: '.a {\n  b: c;\n}', success: true });
});

test('resolves a relative @use against the entrypoint file directory', async (t) => {
  // Proves the file: URL keeps the default filesystem importer working, so
  // partials next to the entrypoint still resolve even though we compile a
  // string rather than the path.
  const { dir, context } = makeContext(t);
  fs.writeFileSync(path.join(dir, '_vars.scss'), '$c: #010203;\n');
  const result = await run(context, '@use "vars";\n.a { color: vars.$c; }\n', {});
  assert.deepEqual(result, {
    output: '.a {\n  color: #010203;\n}',
    success: true,
  });
});

test('throws on invalid SCSS in the handed-in content', async (t) => {
  const { context } = makeContext(t);
  await assert.rejects(
    () => run(context, '.broken { color: $undefined-variable; }\n', {}),
    /Undefined variable/
  );
});
