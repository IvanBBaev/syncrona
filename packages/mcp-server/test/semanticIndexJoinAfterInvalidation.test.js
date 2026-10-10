// SPDX-License-Identifier: GPL-3.0-or-later
// A caller that arrives AFTER an invalidation must not be handed a build that
// started BEFORE it. Sharing the in-flight build is only correct while no
// invalidation has happened since it started; otherwise the caller (a tool call
// right after a push or a file write) gets symbols that predate the change.
//
// Technique: semanticIndexState calls the builder through dist/analysis.js, whose
// re-export getter reads dist/analysis/semantic.js's exports at call time, so
// overwriting that export controls when each build finishes and what it returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const semantic = require('../dist/analysis/semantic.js');
const {
  getSemanticIndexAsync,
  invalidateSemanticIndex,
} = require('../dist/semanticIndexState.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(predicate(), 'condition never became true');
}

test('getSemanticIndexAsync: a caller after an invalidation does not join the older in-flight build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-join-'));
  const prevBuild = semantic.buildSemanticIndexFromWorkspaceAsync;
  const builds = [];
  try {
    semantic.buildSemanticIndexFromWorkspaceAsync = () => {
      const d = deferred();
      builds.push(d);
      return d.promise;
    };

    invalidateSemanticIndex('test:join-first');
    const first = getSemanticIndexAsync(root);
    await until(() => builds.length === 1);

    // The workspace changes while the first build is still running.
    invalidateSemanticIndex('test:join-mid-build');
    const second = getSemanticIndexAsync(root);

    builds[0].resolve([{ name: 'beforeChange' }]);
    assert.deepEqual(await first, [{ name: 'beforeChange' }]);

    await until(() => builds.length === 2);
    builds[1].resolve([{ name: 'afterChange' }]);
    assert.deepEqual(await second, [{ name: 'afterChange' }]);
  } finally {
    for (const d of builds) {
      d.resolve([]);
    }
    semantic.buildSemanticIndexFromWorkspaceAsync = prevBuild;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndexAsync: concurrent callers with no invalidation in between still share one build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-join-'));
  const prevBuild = semantic.buildSemanticIndexFromWorkspaceAsync;
  const builds = [];
  try {
    semantic.buildSemanticIndexFromWorkspaceAsync = () => {
      const d = deferred();
      builds.push(d);
      return d.promise;
    };

    invalidateSemanticIndex('test:share');
    const first = getSemanticIndexAsync(root);
    const second = getSemanticIndexAsync(root);
    await until(() => builds.length === 1);
    builds[0].resolve([{ name: 'shared' }]);

    assert.deepEqual(await first, [{ name: 'shared' }]);
    assert.deepEqual(await second, [{ name: 'shared' }]);
    assert.equal(builds.length, 1);
  } finally {
    for (const d of builds) {
      d.resolve([]);
    }
    semantic.buildSemanticIndexFromWorkspaceAsync = prevBuild;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getSemanticIndexAsync: a build chained behind a failed one still runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-join-'));
  const prevBuild = semantic.buildSemanticIndexFromWorkspaceAsync;
  const builds = [];
  try {
    semantic.buildSemanticIndexFromWorkspaceAsync = () => {
      const d = deferred();
      builds.push(d);
      return d.promise;
    };

    invalidateSemanticIndex('test:chain-fail-first');
    const first = getSemanticIndexAsync(root);
    await until(() => builds.length === 1);
    invalidateSemanticIndex('test:chain-fail-mid');
    const second = getSemanticIndexAsync(root);

    builds[0].resolve(Promise.reject(new Error('walk failed')));
    await assert.rejects(first, /walk failed/);

    await until(() => builds.length === 2);
    builds[1].resolve([{ name: 'recovered' }]);
    assert.deepEqual(await second, [{ name: 'recovered' }]);
  } finally {
    for (const d of builds) {
      d.resolve([]);
    }
    semantic.buildSemanticIndexFromWorkspaceAsync = prevBuild;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
