// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-134 — the bin smoke used to symlink EVERY entry of the workspace's and the
// repo root's node_modules into the staged tarball. A published install only
// gets what the manifest declares, so an import of a package that merely happens
// to be hoisted (a devDependency, or a transitive dep of an unrelated package)
// resolved in the smoke and then crashed with MODULE_NOT_FOUND for the first
// real user — the exact failure this gate exists to catch. These tests pin the
// replacement: only the transitive closure of the DECLARED runtime dependencies
// is staged.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'verify-pack-contents.mjs');

let mod;
before(async () => {
  // The script is ESM; a CommonJS test loads it via dynamic import. Its main
  // guard means importing does NOT trigger `npm pack`.
  mod = await import(scriptPath);
});

/**
 * A miniature workspace:
 *   packages/app          declares dep-a + @syncrona/sib
 *   packages/app/node_modules/dep-a   (nested copy wins over the hoisted one)
 *   packages/sib          declares @scope/thing
 *   node_modules/{dep-a,shared,hoisted-only,@scope/thing}
 */
function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-'));
  const writePkg = (dir, pkg) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  };
  writePkg(path.join(root, 'packages', 'app'), {
    name: 'app',
    dependencies: { 'dep-a': '*', '@syncrona/sib': '*' },
  });
  writePkg(path.join(root, 'packages', 'sib'), {
    name: '@syncrona/sib',
    dependencies: { '@scope/thing': '*' },
  });
  writePkg(path.join(root, 'packages', 'app', 'node_modules', 'dep-a'), {
    name: 'dep-a',
    version: '2.0.0',
    dependencies: { shared: '*' },
  });
  writePkg(path.join(root, 'node_modules', 'dep-a'), { name: 'dep-a', version: '1.0.0' });
  writePkg(path.join(root, 'node_modules', 'shared'), { name: 'shared' });
  writePkg(path.join(root, 'node_modules', 'hoisted-only'), { name: 'hoisted-only' });
  writePkg(path.join(root, 'node_modules', '@scope', 'thing'), { name: '@scope/thing' });
  return root;
}

test('the closure stages declared deps only — a hoisted, undeclared package is left out', () => {
  const root = buildWorkspace();
  try {
    const { staged, missing } = mod.collectDependencyClosure(path.join(root, 'packages', 'app'), {
      root,
      workspaceDirs: new Map([['@syncrona/sib', path.join(root, 'packages', 'sib')]]),
    });
    assert.deepEqual([...staged.keys()].sort(), ['@scope/thing', 'dep-a', 'shared']);
    assert.deepEqual(missing, []);
    // The undeclared but hoisted package is what a published install would NOT have.
    assert.equal(staged.has('hoisted-only'), false);
    // `@syncrona/*` siblings come from their own packed tarballs, never staged...
    assert.equal(staged.has('@syncrona/sib'), false);
    // ...but their third-party deps are, exactly as a real install hoists them.
    assert.equal(staged.get('@scope/thing'), path.join(root, 'node_modules', '@scope', 'thing'));
    // The nested copy wins over the hoisted one, as Node resolves it.
    assert.equal(staged.get('dep-a'), path.join(root, 'packages', 'app', 'node_modules', 'dep-a'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDependencyDir walks up like Node and stops at the repo root', () => {
  const root = buildWorkspace();
  try {
    const app = path.join(root, 'packages', 'app');
    assert.equal(
      mod.resolveDependencyDir('dep-a', app, root),
      path.join(app, 'node_modules', 'dep-a'),
    );
    assert.equal(
      mod.resolveDependencyDir('shared', app, root),
      path.join(root, 'node_modules', 'shared'),
    );
    assert.equal(mod.resolveDependencyDir('not-installed', app, root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared runtime import cannot resolve from the staged node_modules', () => {
  const root = buildWorkspace();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  try {
    const { staged } = mod.collectDependencyClosure(path.join(root, 'packages', 'app'), {
      root,
      workspaceDirs: new Map([['@syncrona/sib', path.join(root, 'packages', 'sib')]]),
    });
    const nodeModules = mod.stagePrivateNodeModules(path.join(stage, 'node_modules'), staged);
    assert.ok(fs.lstatSync(path.join(nodeModules, 'dep-a')).isSymbolicLink());
    // Scoped names get their scope directory created before the link.
    assert.ok(fs.lstatSync(path.join(nodeModules, '@scope', 'thing')).isSymbolicLink());
    assert.equal(
      fs.existsSync(path.join(nodeModules, 'hoisted-only')),
      false,
      'staging the whole workspace tree is what hid undeclared runtime dependencies',
    );
    fs.writeFileSync(path.join(stage, 'index.js'), "require('hoisted-only');\n", 'utf8');
    assert.throws(
      () => require(path.join(stage, 'index.js')),
      /Cannot find module 'hoisted-only'/,
      'the smoke must fail on an undeclared dependency, as a published install would',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('the real core CLI closure keeps runtime deps and drops workspace-only tooling', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const { staged } = mod.collectDependencyClosure(path.join(repoRoot, 'packages', 'core'));
  assert.equal(
    [...staged.keys()].some((name) => name.startsWith('@syncrona/')),
    false,
    'siblings are supplied from their own packed tarballs',
  );
  assert.ok(staged.has('axios'), 'a direct runtime dependency must be staged');
  assert.ok(staged.has('yargs'), 'a direct runtime dependency must be staged');
  // Transitive runtime deps come along; devDependencies of the monorepo do not —
  // they are hoisted into the same node_modules the old code linked wholesale.
  assert.ok(staged.has('follow-redirects'), 'a transitive runtime dependency must be staged');
  assert.equal(staged.has('typescript'), false, 'a workspace devDependency must NOT be staged');
  assert.equal(staged.has('jest'), false, 'a workspace devDependency must NOT be staged');
});
