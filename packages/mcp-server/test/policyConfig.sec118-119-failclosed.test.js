// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 follow-up (REV-118): a present-but-non-array denyTools and a non-object
// top-level config (JSON array / string / number / boolean) must FAIL CLOSED via the
// `invalid` marker instead of silently normalizing to a permissive default.
// SEC-4 (REV-119): own "__proto__" / "constructor" / "prototype" keys under
// policy.environments or policy.tools must mark the config invalid — a "vanishing"
// __proto__ env previously polluted the prototype chain and let the attacker fall
// through to a permissive top-level allowFullNodeAccess.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGuardrailConfig,
  getEffectiveAllowFullNodeAccess,
  DEFAULT_GUARDRAIL_CONFIG,
} = require('../dist/policyConfig.js');

test('REV-118: a present-but-non-array denyTools marks the whole config invalid (no deny-nothing)', () => {
  const config = parseGuardrailConfig({
    policy: {
      environments: {
        // Typo: a string, not an array. Must NOT normalize to [] (= deny nothing).
        dev: { denyTools: 'sync_push' },
      },
    },
  });
  assert.equal(config.invalid, true);
  assert.match(config.invalidReason, /non-array denyTools/);
});

test('REV-118: a non-object top-level config (array/string/number) fails closed', () => {
  for (const input of [[], 'x', 42]) {
    const config = parseGuardrailConfig(input);
    assert.equal(config.invalid, true, `expected invalid for ${JSON.stringify(input)}`);
    assert.match(config.invalidReason, /root is not an object/);
  }
});

test('REV-118: undefined and {} keep their existing permissive meaning (NOT invalid)', () => {
  const fromUndefined = parseGuardrailConfig(undefined);
  assert.equal(Boolean(fromUndefined.invalid), false);

  const fromEmpty = parseGuardrailConfig({});
  assert.equal(Boolean(fromEmpty.invalid), false);
  assert.deepEqual(fromEmpty, DEFAULT_GUARDRAIL_CONFIG);
});

test('REV-119: an own "__proto__" environment key is rejected without polluting the prototype chain', () => {
  // JSON.parse creates an OWN "__proto__" key (an object literal would instead set
  // the prototype of the literal) — this mirrors the real attack: a guardrail config
  // file parsed from JSON.
  const raw = JSON.parse(
    '{"allowFullNodeAccess": true, "policy": {"environments": {"__proto__": {"allowFullNodeAccess": true}}}}'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw.policy.environments, '__proto__'),
    true
  );

  const config = parseGuardrailConfig(raw);
  assert.equal(config.invalid, true);
  assert.match(config.invalidReason, /forbidden key "__proto__"/);
  // No prototype pollution: environments stays a plain object with no leaked env.
  assert.equal(Object.getPrototypeOf(config.policy.environments), Object.prototype);
  assert.equal(
    Object.prototype.hasOwnProperty.call(config.policy.environments, '__proto__'),
    false
  );
  assert.deepEqual(Object.keys(config.policy.environments), []);
  // The exploit target: the invalid marker must block the permissive top-level flag.
  assert.equal(getEffectiveAllowFullNodeAccess(config), false);
});

test('REV-119: a forbidden tool policy key ("constructor") marks the config invalid', () => {
  const config = parseGuardrailConfig({
    policy: { tools: { constructor: { deny: true } } },
  });
  assert.equal(config.invalid, true);
  assert.match(config.invalidReason, /forbidden key "constructor"/);
});
