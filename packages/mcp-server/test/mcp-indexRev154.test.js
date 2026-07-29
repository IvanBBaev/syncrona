// SPDX-License-Identifier: GPL-3.0-or-later
// REV-154 regression pins.
//
// The async semantic-index build published its result with setSemanticIndex(),
// which cleared LAST_SEMANTIC_INDEX_DIRTY unconditionally and stamped
// LAST_SEMANTIC_INDEX_BUILT_AT = Date.now() AFTER the workspace walk had already
// finished. Any invalidateSemanticIndex() raised while the build was running was
// therefore erased at publish time, and the mtime backstop could not recover it
// either: a file written mid-build carries an mtime OLDER than the post-build
// timestamp, so the index reported itself fresh while describing a workspace that
// no longer existed.
//
// These tests fail against that old code (dirty came back false; builtAt landed
// after the walk) and pass now that the publish is epoch-guarded and builtAt
// records when the walk STARTED.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  getSemanticIndexAsync,
  getSemanticIndexState,
  invalidateSemanticIndex,
} = require('../dist/semanticIndexState.js');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rev154-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  return { root, src };
}

function writeSymbol(dir, file, symbol) {
  fs.writeFileSync(
    path.join(dir, file),
    ['// SPDX-License-Identifier: GPL-3.0-or-later', `export function ${symbol}() {`, '  return 1;', '}'].join('\n'),
    'utf-8'
  );
  return path.join(dir, file);
}

function hasSymbol(rows, name) {
  return rows.some((row) => row.name === name);
}

test('getSemanticIndexAsync: an invalidation raised while the build walks the workspace is not swallowed', async () => {
  const { root, src } = mkProject();
  try {
    writeSymbol(src, 'alpha.ts', 'alphaSymbolRev154');

    // Dirty short-circuits the freshness poll, so the build starts synchronously
    // and control returns here while it is still walking.
    invalidateSemanticIndex('test:rev154-first-build');
    const pending = getSemanticIndexAsync(root);

    // A concurrent tool call lands a new file and invalidates mid-build.
    writeSymbol(src, 'beta.ts', 'betaSymbolRev154');
    invalidateSemanticIndex('test:rev154-mid-build');

    await pending;

    assert.equal(
      getSemanticIndexState().dirty,
      true,
      'the mid-build invalidation must survive the publish of the older build'
    );

    const next = await getSemanticIndexAsync(root);
    assert.equal(hasSymbol(next, 'betaSymbolRev154'), true, 'the mid-build write must become visible');
    assert.equal(hasSymbol(next, 'alphaSymbolRev154'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndexAsync: builtAt records when the walk started, not when it finished', async () => {
  const { root, src } = mkProject();
  const realReaddir = fsp.readdir;
  let stalled = false;
  try {
    writeSymbol(src, 'gamma.ts', 'gammaSymbolRev154');

    // Stall the first directory read under the project so the build measurably
    // spans time; without that, start and end fall in the same millisecond and
    // the old and new timestamps are indistinguishable.
    fsp.readdir = async function patchedReaddir(dir, ...rest) {
      if (!stalled && typeof dir === 'string' && dir.startsWith(root)) {
        stalled = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return realReaddir.call(this, dir, ...rest);
    };

    invalidateSemanticIndex('test:rev154-builtat');
    const startedBefore = Date.now();
    const pending = getSemanticIndexAsync(root);
    const startedAfter = Date.now();
    await pending;
    const finishedAt = Date.now();

    assert.equal(stalled, true, 'the stall hook must have fired');
    assert.ok(finishedAt - startedAfter >= 50, `the build must span time (took ${finishedAt - startedAfter}ms)`);

    const builtAt = getSemanticIndexState().builtAt;
    assert.ok(
      builtAt >= startedBefore && builtAt <= startedAfter,
      `builtAt (${builtAt}) must be the walk's start, not its end (${finishedAt})`
    );
  } finally {
    fsp.readdir = realReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
