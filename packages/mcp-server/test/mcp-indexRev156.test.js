// SPDX-License-Identifier: GPL-3.0-or-later
// REV-156 regression pins.
//
// getSemanticIndexAsync is the non-blocking getter the MCP tool dispatcher uses,
// but its cache-hit fast path ran the SYNCHRONOUS staleness poll — a full
// readdirSync/statSync recursion over the whole project — before it could even
// decide the cache was fresh. Every tool call therefore stalled the event loop
// for a stat-walk of the workspace, cache hits included, so concurrent requests
// serialized behind the very check that existed to avoid blocking, and the async
// build path behind it bought nothing.
//
// These tests fail against that old code (the cache hit issued readdirSync /
// statSync under the project) and pass now that the poll uses fs/promises and is
// memoized for a short window.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rev156-'));
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

// Counts fs traffic aimed at `root` only, so unrelated runtime I/O (audit writes)
// cannot colour the result.
function installFsCounters(root) {
  const counts = { sync: 0, async: 0 };
  const real = {
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    readdir: fsp.readdir,
    stat: fsp.stat,
  };
  const under = (target) => typeof target === 'string' && target.startsWith(root);

  fs.readdirSync = function countedReaddirSync(target, ...rest) {
    if (under(target)) counts.sync += 1;
    return real.readdirSync.call(this, target, ...rest);
  };
  fs.statSync = function countedStatSync(target, ...rest) {
    if (under(target)) counts.sync += 1;
    return real.statSync.call(this, target, ...rest);
  };
  fsp.readdir = function countedReaddir(target, ...rest) {
    if (under(target)) counts.async += 1;
    return real.readdir.call(this, target, ...rest);
  };
  fsp.stat = function countedStat(target, ...rest) {
    if (under(target)) counts.async += 1;
    return real.stat.call(this, target, ...rest);
  };

  return {
    counts,
    reset() {
      counts.sync = 0;
      counts.async = 0;
    },
    restore() {
      fs.readdirSync = real.readdirSync;
      fs.statSync = real.statSync;
      fsp.readdir = real.readdir;
      fsp.stat = real.stat;
    },
  };
}

test('getSemanticIndexAsync: a cache hit polls freshness asynchronously, never with a synchronous fs walk', async () => {
  const { root, src } = mkProject();
  const counters = installFsCounters(root);
  try {
    const alphaPath = writeSymbol(src, 'alpha.ts', 'alphaSymbolRev156');

    invalidateSemanticIndex('test:rev156-init');
    await getSemanticIndexAsync(root);
    assert.equal(getSemanticIndexState().dirty, false);

    // Back-date the source so the upcoming call is unambiguously a cache hit.
    const builtAt = getSemanticIndexState().builtAt;
    const past = new Date(builtAt - 60000);
    fs.utimesSync(alphaPath, past, past);

    // Publishing a build resets the poll window, so this call performs a real
    // freshness poll rather than reusing a memoized answer.
    counters.reset();
    const rows = await getSemanticIndexAsync(root);

    assert.equal(hasSymbol(rows, 'alphaSymbolRev156'), true);
    assert.equal(getSemanticIndexState().builtAt, builtAt, 'this must be a cache hit, not a rebuild');
    assert.equal(
      counters.counts.sync,
      0,
      `a cache hit must not stall the event loop (${counters.counts.sync} sync fs calls under the project)`
    );
    assert.ok(counters.counts.async > 0, 'the freshness poll must have walked the tree');

    // The poll is memoized for a short window, so an immediately following call
    // touches the filesystem not at all.
    counters.reset();
    const again = await getSemanticIndexAsync(root);
    assert.equal(hasSymbol(again, 'alphaSymbolRev156'), true);
    assert.equal(counters.counts.sync, 0);
    assert.equal(counters.counts.async, 0, 'a burst of cache hits must share one workspace walk');
  } finally {
    counters.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
