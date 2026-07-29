// SPDX-License-Identifier: GPL-3.0-or-later
// REV-155 regression pins.
//
// The poll-on-read staleness check sampled only the NEWEST source mtime and
// compared it one-sidedly against builtAt. Deleting a source file cannot raise
// that number — it can only lower it — so an out-of-band deletion (a branch
// checkout, an rm, a prune) left every survivor older than the index and the poll
// answered "fresh". Symbols from files that no longer exist kept being served by
// sync_semantic_search / sync_symbol_xref for the whole process lifetime. The
// degenerate case was worse: wiping the tree made the newest mtime 0, which the
// old code treated as "freshness unknown" and explicitly reported as fresh,
// pinning the pre-deletion index forever.
//
// These tests fail against that old code (the deleted symbols came back) and pass
// now that the walk also counts sources and a shrinking count means stale.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getSemanticIndex,
  getSemanticIndexState,
  invalidateSemanticIndex,
} = require('../dist/semanticIndexState.js');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rev155-'));
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

test('getSemanticIndex: a deleted source marks the index stale even when every survivor is older than it', () => {
  const { root, src } = mkProject();
  try {
    const alphaPath = writeSymbol(src, 'alpha.ts', 'alphaSymbolRev155');
    const doomedPath = writeSymbol(src, 'doomed.ts', 'doomedSymbolRev155');

    invalidateSemanticIndex('test:rev155-init');
    const first = getSemanticIndex(root);
    assert.equal(hasSymbol(first, 'doomedSymbolRev155'), true);
    assert.equal(getSemanticIndexState().dirty, false);

    const builtAt = getSemanticIndexState().builtAt;

    // Out-of-band deletion: no tool ran, so nothing invalidated. Back-date the
    // survivor so the mtime backstop cannot fire either — the only signal left is
    // that the tree now holds fewer sources than the index was built from.
    fs.rmSync(doomedPath);
    const past = new Date(builtAt - 60000);
    fs.utimesSync(alphaPath, past, past);

    const second = getSemanticIndex(root);
    assert.equal(
      hasSymbol(second, 'doomedSymbolRev155'),
      false,
      'symbols from a deleted file must not keep being served'
    );
    assert.equal(hasSymbol(second, 'alphaSymbolRev155'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndex: wiping every source out-of-band does not pin the pre-deletion index', () => {
  const { root, src } = mkProject();
  try {
    writeSymbol(src, 'onlyOne.ts', 'onlySymbolRev155');

    invalidateSemanticIndex('test:rev155-wipe');
    const first = getSemanticIndex(root);
    assert.equal(hasSymbol(first, 'onlySymbolRev155'), true);
    assert.equal(getSemanticIndexState().dirty, false);

    // Newest mtime collapses to 0 here, which the old code read as "cannot tell,
    // assume fresh".
    fs.rmSync(src, { recursive: true, force: true });

    const second = getSemanticIndex(root);
    assert.equal(
      hasSymbol(second, 'onlySymbolRev155'),
      false,
      'an empty source tree must invalidate the index, not preserve it'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
