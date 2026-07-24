// SPDX-License-Identifier: GPL-3.0-or-later
// CONC-2 (REV-93): the semantic index was served stale after out-of-band edits or a
// scope bootstrap that the tool-triggered invalidation allowlist never saw. The fix
// adds a poll-on-read mtime staleness check: getSemanticIndex rebuilds when any source
// file is newer than the built index, even when the dirty flag is false. These tests
// drive the rebuild purely through mtime (dirty stays false after the first build).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-staleness-'));
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

test('getSemanticIndex: rebuilds (without a dirty flag) when a source file is newer than the built index', () => {
  const { root, src } = mkProject();
  try {
    writeSymbol(src, 'alpha.ts', 'alphaSymbol');

    // First build (forced via invalidation) establishes builtAt.
    invalidateSemanticIndex('test:staleness-init');
    const first = getSemanticIndex(root);
    assert.equal(hasSymbol(first, 'alphaSymbol'), true);

    const builtAt = getSemanticIndexState().builtAt;
    assert.equal(getSemanticIndexState().dirty, false);

    // A new file whose mtime is AFTER builtAt is the only trigger left (not dirty).
    const betaPath = writeSymbol(src, 'beta.ts', 'betaSymbol');
    const future = new Date(builtAt + 10000);
    fs.utimesSync(betaPath, future, future);

    const second = getSemanticIndex(root);
    assert.equal(hasSymbol(second, 'betaSymbol'), true, 'staleness must have forced a rebuild');
    assert.equal(hasSymbol(second, 'alphaSymbol'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndex: does NOT rebuild when every source file is older than the built index', () => {
  const { root, src } = mkProject();
  try {
    const gammaPath = writeSymbol(src, 'gamma.ts', 'gammaSymbol');

    invalidateSemanticIndex('test:staleness-negative');
    const first = getSemanticIndex(root);
    assert.equal(hasSymbol(first, 'gammaSymbol'), true);

    const builtAt = getSemanticIndexState().builtAt;

    // Add a new symbol but back-date every source file BEFORE builtAt: with no
    // dirty flag and nothing newer than the index, the cache must be reused as-is.
    const deltaPath = writeSymbol(src, 'delta.ts', 'deltaSymbol');
    const past = new Date(builtAt - 60000);
    fs.utimesSync(gammaPath, past, past);
    fs.utimesSync(deltaPath, past, past);

    const second = getSemanticIndex(root);
    assert.equal(hasSymbol(second, 'deltaSymbol'), false, 'no rebuild expected — the new file is older than the index');
    assert.equal(hasSymbol(second, 'gammaSymbol'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
