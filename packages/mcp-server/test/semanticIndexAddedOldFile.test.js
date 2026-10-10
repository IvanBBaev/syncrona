// SPDX-License-Identifier: GPL-3.0-or-later
// A source file that arrives with an mtime older than the index (moved in with
// `mv`, copied with `cp -p`, unpacked from an archive) raises the file count but not
// the newest mtime. The poll must read a GROWN count as stale too, not only a
// shrunken one, or the new file's symbols stay missing until something invalidates.
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

function writeSymbol(dir, file, symbol) {
  const filePath = path.join(dir, file);
  fs.writeFileSync(filePath, `export function ${symbol}() {\n  return 1;\n}\n`, 'utf-8');
  return filePath;
}

function hasSymbol(rows, name) {
  return rows.some((row) => row.name === name);
}

test('getSemanticIndex: a source added with an older mtime than the index marks it stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-added-old-'));
  try {
    const alphaPath = writeSymbol(root, 'alpha.ts', 'alphaSymbolAddedOld');

    invalidateSemanticIndex('test:added-old-init');
    const first = getSemanticIndex(root);
    assert.equal(hasSymbol(first, 'alphaSymbolAddedOld'), true);
    assert.equal(getSemanticIndexState().dirty, false);

    // Out-of-band addition with a preserved, older timestamp; back-date the survivor
    // too so the mtime check cannot fire and only the file count changed.
    const past = new Date(getSemanticIndexState().builtAt - 60000);
    const movedPath = writeSymbol(root, 'moved.ts', 'movedSymbolAddedOld');
    fs.utimesSync(movedPath, past, past);
    fs.utimesSync(alphaPath, past, past);

    const second = getSemanticIndex(root);
    assert.equal(
      hasSymbol(second, 'movedSymbolAddedOld'),
      true,
      'symbols from a file added with an old mtime must be indexed'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
