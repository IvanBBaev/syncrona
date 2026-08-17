// SPDX-License-Identifier: GPL-3.0-or-later
// REV-213: contracts of the semantic-index cache that nothing pinned.
//
// semanticIndexState.js was the weakest module in the package (88.17 line /
// 74.55 branch), and the gap was not decoration: the arms nothing reached were
// the ones that decide whether a READ path (sync_semantic_search,
// sync_symbol_xref) answers, rebuilds, or throws. Three of them are pinned here.
//
//  1. Provenance. setSemanticIndex publishes rows built elsewhere, which carry no
//     tree sample, so it forgets the previous file count instead of attributing it
//     to the new index (REV-155). Nothing tested that it forgets: with a stale
//     count still attached, every later read compares an unrelated tree against it
//     and the "sources disappeared" rule fires on an index that never had sources.
//  2. Best-effort traversal. Both walks (the staleness sampler and the builder)
//     have to step over skipped directories, non-source files, and entries the
//     filesystem refuses. The refusal arm is REV-213's own fix: the SYNC builder in
//     analysis/semantic.ts used bare readdirSync/statSync/readFileSync while its
//     async twin and the sampler both guarded theirs, so a dangling `.ts` symlink
//     threw ENOENT out of getSemanticIndex.
//  3. The thundering-herd collapse (PERF-5/REV-98). Concurrent readers of a dirty
//     index must share one build; if that ever regresses, nothing gets slower in a
//     way a test would notice — the workspace is simply walked N times per burst.
//
// Deliberately NOT pinned here: the `!LAST_SEMANTIC_INDEX` guards in isSampleStale
// and isSemanticIndexStaleAsync. Both are unreachable by construction — every call
// site tests the same condition first and short-circuits — and are commented as
// such at the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  getSemanticIndex,
  getSemanticIndexAsync,
  getSemanticIndexState,
  invalidateSemanticIndex,
  setSemanticIndex,
} = require('../dist/semanticIndexState.js');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rev213-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  return { root, src };
}

function writeSymbol(dir, file, symbol) {
  fs.mkdirSync(dir, { recursive: true });
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

// A tree whose every entry exercises one arm of the walk: a real source, a source
// hidden behind each of the three skip rules, a file that is not source at all, and
// an entry the filesystem refuses to stat.
function mkMixedProject() {
  const { root, src } = mkProject();
  writeSymbol(src, 'real.ts', 'realSymbolRev213');
  writeSymbol(path.join(root, 'node_modules', 'pkg'), 'shadow.ts', 'shadowSymbolRev213');
  writeSymbol(path.join(root, 'dist'), 'built.ts', 'distSymbolRev213');
  // Named "hidden", not "secret": gitleaks' generic-api-key rule reads the word
  // "secret" as a keyword and flags whatever follows it, so that spelling made
  // the repo's own secret scan fail on a fixture with no secret in it. The
  // fixture only needs to be a source file inside a dot-directory.
  writeSymbol(path.join(root, '.cache'), 'hidden.ts', 'hiddenSymbolRev213');
  // Same symbol grammar, wrong extension: the extractor would happily find it, the
  // walk must never hand it the file.
  fs.writeFileSync(path.join(src, 'notes.txt'), 'export function textSymbolRev213() {}\n', 'utf-8');
  // Dangling symlink: readdir lists it, stat follows the link and raises ENOENT.
  fs.symlinkSync(path.join(src, 'never-existed.ts'), path.join(src, 'dangling.ts'));
  return { root, src };
}

function assertOnlyRealSymbol(rows, label) {
  assert.equal(hasSymbol(rows, 'realSymbolRev213'), true, `${label}: the one real source must be indexed`);
  assert.equal(hasSymbol(rows, 'shadowSymbolRev213'), false, `${label}: node_modules must stay out`);
  assert.equal(hasSymbol(rows, 'distSymbolRev213'), false, `${label}: build output must stay out`);
  assert.equal(hasSymbol(rows, 'hiddenSymbolRev213'), false, `${label}: dot-directories must stay out`);
  assert.equal(hasSymbol(rows, 'textSymbolRev213'), false, `${label}: non-source files must stay out`);
}

test('setSemanticIndex: rows handed in forget the previous build\'s file count, so an unrelated tree is not read as a deletion', () => {
  const built = mkProject();
  const other = mkProject();
  try {
    writeSymbol(built.src, 'alpha.ts', 'alphaSymbolRev213');
    writeSymbol(built.src, 'beta.ts', 'betaSymbolRev213');

    // A real build records provenance: two sources were on disk when it ran.
    invalidateSemanticIndex('test:rev213-provenance');
    const firstRows = getSemanticIndex(built.root);
    assert.equal(hasSymbol(firstRows, 'alphaSymbolRev213'), true);

    // Rows from somewhere else (a handler that indexed a downloaded scope, say).
    // They describe no tree at all, so the count from the build above must not be
    // carried over onto them.
    const injected = [{ name: 'injectedSymbolRev213', kind: 'function', file: 'virtual.ts', line: 1 }];
    setSemanticIndex(injected);
    const state = getSemanticIndexState();
    assert.equal(state.built, true);
    assert.equal(state.dirty, false, 'handed-in rows publish a clean index');
    assert.equal(state.symbolCount, 1);
    assert.equal(state.builtAt > 0, true);

    // `other` holds no sources whatsoever: 0 files, newest mtime 0. Had the count of
    // 2 survived setSemanticIndex, 0 < 2 would read as "the sources were deleted" and
    // throw the injected rows away on the very next read.
    const served = getSemanticIndex(other.root);
    assert.equal(served, injected, 'injected rows must be served as-is, not rebuilt over');
    assert.equal(hasSymbol(served, 'alphaSymbolRev213'), false);
  } finally {
    fs.rmSync(built.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  }
});

test('getSemanticIndex: the walk skips node_modules, dist and dot-directories, ignores non-source files, and steps over a dangling symlink', () => {
  const { root } = mkMixedProject();
  try {
    invalidateSemanticIndex('test:rev213-walk-sync');
    // The assertion that matters most is that this call returns at all: before
    // REV-213 the dangling symlink threw ENOENT out of statSync, straight through
    // getSemanticIndex and into whichever read tool asked for symbols.
    assertOnlyRealSymbol(getSemanticIndex(root), 'sync');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndexAsync: the non-blocking twin applies the same traversal rules and the same best-effort skips', async () => {
  const { root } = mkMixedProject();
  try {
    invalidateSemanticIndex('test:rev213-walk-async');
    assertOnlyRealSymbol(await getSemanticIndexAsync(root), 'async');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic index: a source file the OS refuses to read is skipped rather than failing the whole index', async () => {
  const { root, src } = mkProject();
  const sockPath = path.join(src, 'unreadable.ts');
  const server = net.createServer();
  try {
    writeSymbol(src, 'readable.ts', 'readableSymbolRev213');
    // A unix socket named like a source file: it stats fine and matches the source
    // extension, so the walk reaches the read — and open(2) refuses it (ENXIO on
    // Linux, EOPNOTSUPP on macOS). This is the deletion/permission race the read
    // guard exists for, made deterministic; no chmod, so it behaves the same when
    // the suite runs as root.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, resolve);
    });
    assert.equal(fs.existsSync(sockPath), true, 'the unreadable entry must exist for this test to mean anything');

    invalidateSemanticIndex('test:rev213-unreadable-sync');
    const sync = getSemanticIndex(root);
    assert.equal(hasSymbol(sync, 'readableSymbolRev213'), true, 'sync: the readable sibling still indexes');

    invalidateSemanticIndex('test:rev213-unreadable-async');
    const async = await getSemanticIndexAsync(root);
    assert.equal(hasSymbol(async, 'readableSymbolRev213'), true, 'async: the readable sibling still indexes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic index: a project directory that cannot be listed yields an empty index instead of throwing', async () => {
  const { root, src } = mkProject();
  const notADirectory = writeSymbol(src, 'file.ts', 'unusedSymbolRev213');
  try {
    // Pointing the walk at a file is the reproducible stand-in for the real cases
    // (the directory was renamed, or is not readable): readdir raises, and a read
    // path must degrade to "no symbols" rather than propagate an fs error.
    invalidateSemanticIndex('test:rev213-unlistable-sync');
    assert.deepEqual(getSemanticIndex(notADirectory), []);

    invalidateSemanticIndex('test:rev213-unlistable-async');
    assert.deepEqual(await getSemanticIndexAsync(notADirectory), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndexAsync: concurrent readers of a dirty index collapse onto a single build', async () => {
  const { root, src } = mkProject();
  try {
    writeSymbol(src, 'shared.ts', 'sharedSymbolRev213');

    invalidateSemanticIndex('test:rev213-in-flight');
    // No await between the two calls, so both observe the same dirty state. The
    // second must join the first build via SEMANTIC_INDEX_BUILD_IN_FLIGHT; identity
    // of the resolved arrays is the only observable proof that one walk ran and not
    // two, since two builds of the same tree are equal but not the same object.
    const first = getSemanticIndexAsync(root);
    const second = getSemanticIndexAsync(root);
    const [firstRows, secondRows] = await Promise.all([first, second]);

    assert.equal(firstRows, secondRows, 'both readers must receive the one build, not a build each');
    assert.equal(hasSymbol(firstRows, 'sharedSymbolRev213'), true);
    assert.equal(getSemanticIndexState().dirty, false);

    // The slot is released once the build settles, so the next dirty read starts a
    // fresh build rather than serving the finished promise forever.
    invalidateSemanticIndex('test:rev213-in-flight-released');
    const third = await getSemanticIndexAsync(root);
    assert.notEqual(third, firstRows, 'a later invalidation must not be answered from the retired build');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
