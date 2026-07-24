// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-103 — the dependency-cruiser boundary self-test must do more than prove
// each rule's `from` scope is non-empty; it must prove each rule can actually be
// VIOLATED. These tests exercise the positive fire-check: every forbidden rule
// fires on the fixture that violates it, and a rule that cannot match the
// fixtures is reported as un-fired (so the gate would fail).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const selftestPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'depcruise-selftest.mjs');

let selftest;
before(async () => {
  // The script is ESM; a CommonJS test loads it via dynamic import.
  selftest = await import(selftestPath);
});

test('every forbidden rule fires on its intentionally-violating fixture', async () => {
  const rules = selftest.loadForbiddenRules();
  assert.ok(rules.length >= 5, 'expected the real forbidden rule set to be loaded');
  const unfired = await selftest.findUnfiredRules(rules);
  assert.deepEqual(
    unfired,
    [],
    `these rules never fired on a fixture that violates them: ${unfired.join(', ')}`,
  );
});

test('a rule whose `to` cannot match the fixtures is reported as un-fired', async () => {
  // Proves the fire-check would FAIL (not silently pass) for an un-fireable rule:
  // this synthetic rule has a valid, reachable `from` but a `to` specifier that
  // appears in no fixture, so it can never be violated.
  const rules = selftest.loadForbiddenRules();
  const neverFires = {
    name: 'never-fires-sentinel',
    severity: 'error',
    from: { path: '^packages/core/src' },
    to: { path: '@syncrona/this-specifier-appears-in-no-fixture' },
  };
  const unfired = await selftest.findUnfiredRules([...rules, neverFires]);
  assert.deepEqual(unfired, ['never-fires-sentinel']);
});

test('findDeadRules flags a `from` path that matches no cruised module', () => {
  // Pure reachability check — no cruise needed.
  const dead = selftest.findDeadRules(
    [
      { name: 'ghost', from: { path: '^packages/does-not-exist/src' } },
      { name: 'live', from: { path: '^packages/core/src' } },
    ],
    ['packages/core/src/index.ts', 'packages/types/index.d.ts'],
  );
  assert.deepEqual(dead, ['ghost']);
});

test('findDeadRules ignores rules without a `from.path` (e.g. no-circular)', () => {
  // no-circular has `from: {}` and is checked by the fire-check, not reachability.
  const dead = selftest.findDeadRules(
    [{ name: 'no-circular', from: {}, to: { circular: true } }],
    ['packages/core/src/index.ts'],
  );
  assert.deepEqual(dead, []);
});
