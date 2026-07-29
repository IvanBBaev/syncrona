// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-132 / REV-139 — the boundary self-test had two blind spots that let the
// whole architecture contract be disabled with both gates green:
//
//   * it never looked at rule SEVERITY. `depcruise` exits on `summary.error`
//     only, while `summary.violations` carries every severity, so flipping the
//     rules to "warn" kept `lint:boundaries` AND the self-test passing while
//     nothing was enforced.
//   * its fixture had no node_modules, so every `@syncrona/*` import stayed an
//     unresolved specifier. In the real (installed) workspace the same import
//     resolves to `packages/<pkg>/dist/index.js`, so a rule matching only the
//     specifier form fired on the fixture and was inert in the repo.
//
// These tests pin both fixes.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const selftestPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'depcruise-selftest.mjs');

let selftest;
before(async () => {
  // The script is ESM; a CommonJS test loads it via dynamic import.
  selftest = await import(selftestPath);
});

test('findNonErrorRules reports every rule that cannot fail the build', () => {
  assert.deepEqual(
    selftest.findNonErrorRules([
      { name: 'blocking', severity: 'error' },
      { name: 'advisory', severity: 'warn' },
      { name: 'chatty', severity: 'info' },
      { name: 'defaulted' },
    ]),
    ['advisory', 'chatty', 'defaulted'],
  );
});

test('every real boundary rule is at severity "error" (a warn rule enforces nothing)', () => {
  const rules = selftest.loadForbiddenRules();
  assert.ok(rules.length >= 5, 'expected the real forbidden rule set to be loaded');
  assert.deepEqual(
    selftest.findNonErrorRules(rules),
    [],
    'a boundary rule below severity "error" is reported by depcruise and then ignored by the gate',
  );
});

test('a violated rule that is not at severity "error" counts as un-fired', async () => {
  // Clone a real rule (so it genuinely IS violated by the fixture) and only
  // downgrade its severity: the fire-check must still flag it, because a "warn"
  // violation never fails `npm run lint:boundaries`.
  const rules = selftest.loadForbiddenRules();
  const downgraded = { ...rules.find((r) => r.name === 'foundation-no-consumers'), name: 'downgraded-sentinel', severity: 'warn' };
  assert.ok(downgraded.from, 'expected foundation-no-consumers in the real rule set');
  const unfired = await selftest.findUnfiredRules([...rules, downgraded]);
  assert.deepEqual(unfired, ['downgraded-sentinel']);
});

test('the fixture resolves @syncrona imports, so resolved-path rules can fire', async () => {
  // Without node_modules in the fixture this rule can never fire: the edge is
  // recorded as the bare specifier `@syncrona/mcp-server`, which no
  // `^packages/...` pattern matches.
  const resolvedPathSentinel = {
    name: 'resolved-path-sentinel',
    severity: 'error',
    from: { path: '^packages/core/src' },
    to: { path: '^packages/mcp-server/' },
  };
  const unfired = await selftest.findUnfiredRules([resolvedPathSentinel]);
  assert.deepEqual(
    unfired,
    [],
    'the fixture must link the workspace packages under node_modules so cross-package imports resolve',
  );
});

test('the fixture uses real package names and materialises the workspace links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruise-fixture-'));
  try {
    selftest.writeViolatingFixtures(root);

    // npm links the unscoped core CLI and each scoped sibling.
    assert.ok(fs.lstatSync(path.join(root, 'node_modules', 'syncrona')).isSymbolicLink());
    assert.ok(
      fs.lstatSync(path.join(root, 'node_modules', '@syncrona', 'mcp-server')).isSymbolicLink(),
    );

    // `@syncrona/core` is a package that exists nowhere in the workspace; a
    // fixture built on it can only ever exercise the unresolved-specifier form.
    const sources = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(ts|js|json)$/.test(entry.name)) sources.push(fs.readFileSync(abs, 'utf8'));
      }
    };
    walk(path.join(root, 'packages'));
    assert.ok(sources.length > 0, 'expected fixture sources');
    assert.equal(
      sources.some((s) => s.includes('@syncrona/core')),
      false,
      'the fixture must not import the non-existent package @syncrona/core',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
