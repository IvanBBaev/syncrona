// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-138 — `.changeset/config.json` pinned the release family with the single
// pattern `@syncrona/*`, which does not match the flagship package: the CLI
// publishes UNSCOPED as `syncrona`. Changesets expands each pattern with
// micromatch and only warns about patterns that match NOTHING, so the gap was
// silent — `npx changeset version` would have moved every scoped package in
// lockstep and left `syncrona` on its previous version, exactly contradicting
// docs/VERSIONING.md and shipping a CLI whose pinned `@syncrona/*` dependency
// ranges no longer match anything published.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.changeset', 'config.json'), 'utf8'));

/** Every publishable (non-private) workspace package name. */
function publishablePackageNames() {
  const packagesDir = path.join(repoRoot, 'packages');
  const names = [];
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name && !pkg.private) names.push(pkg.name);
  }
  return names;
}

// Match with the same engine changesets uses (@changesets/config -> micromatch),
// falling back to an equivalent literal/`*` matcher if it is not hoisted here.
let isMatch;
try {
  const micromatch = require('micromatch');
  isMatch = (name, patterns) => micromatch.isMatch(name, patterns);
} catch {
  isMatch = (name, patterns) =>
    patterns.some((pattern) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(name),
    );
}

test('the fixed release group covers every publishable package, including unscoped `syncrona`', () => {
  const patterns = (config.fixed || []).flat();
  assert.ok(patterns.length > 0, 'expected a fixed release group');
  const names = publishablePackageNames();
  assert.ok(names.includes('syncrona'), 'expected the unscoped core CLI in the workspace');
  const uncovered = names.filter((name) => !isMatch(name, patterns));
  assert.deepEqual(
    uncovered,
    [],
    `these publishable packages are outside the fixed group and would not be version-bumped in lockstep: ${uncovered.join(', ')}`,
  );
});

test('the private workspace root stays out of the fixed group', () => {
  // docs/VERSIONING.md: the root container's version is deliberately not "fixed".
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(rootPkg.private, true);
  assert.equal(isMatch(rootPkg.name, (config.fixed || []).flat()), false);
});
