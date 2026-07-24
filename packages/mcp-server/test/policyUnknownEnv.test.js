// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-4 (REV-85): when policy.environments is non-empty but the selected active
// environment (SYNCRONA_ENV or policy.activeEnvironment) is not among its keys, the
// env-scoped guardrails would silently vanish. The fix fails closed: evaluateToolPolicy
// denies, getEffectiveAllowFullNodeAccess returns false, and it does NOT fall back to
// the permissive top-level policy. A policy with NO environments still falls back.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGuardrailConfig,
  evaluateToolPolicy,
  getEffectiveAllowFullNodeAccess,
  isUnknownActiveEnvironment,
} = require('../dist/policyConfig.js');
const { logger } = require('../dist/logger.js');

const SYNCRONA_ENV_KEY = 'SYNCRONA_ENV';
const FAIL_CLOSED_REASON = /is not defined in policy\.environments/;

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[key] = prev;
    } else {
      delete process.env[key];
    }
  }
}

function withCapturedErrors(fn) {
  const original = logger.error;
  const calls = [];
  logger.error = (message, fields) => {
    calls.push({ message, fields });
  };
  try {
    return fn(calls);
  } finally {
    logger.error = original;
  }
}

test('evaluateToolPolicy: denies and logs when the active env is missing from a non-empty environments map', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'staging',
        environments: { prod: { allowTools: ['sync_push'] } },
      },
    });
    withCapturedErrors((calls) => {
      const result = evaluateToolPolicy(config, 'sync_push', {}, false);
      assert.equal(result.allowed, false);
      assert.match(result.reason, FAIL_CLOSED_REASON);
      assert.equal(result.reason.includes('staging'), true);
      assert.equal(calls.length >= 1, true);
      assert.equal(calls[0].fields.activeEnvironment, 'staging');
    });
  });
});

test('evaluateToolPolicy: SYNCRONA_ENV pointing at an undefined env also fails closed', () => {
  withEnv(SYNCRONA_ENV_KEY, 'ghost', () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowTools: ['sync_push'] } },
      },
    });
    withCapturedErrors(() => {
      const result = evaluateToolPolicy(config, 'sync_push', {}, false);
      assert.equal(result.allowed, false);
      assert.match(result.reason, FAIL_CLOSED_REASON);
      assert.equal(result.reason.includes('ghost'), true);
    });
  });
});

test('getEffectiveAllowFullNodeAccess: unknown active env returns false without the top-level fallback', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      allowFullNodeAccess: true, // top-level would have granted it — must be ignored
      policy: {
        activeEnvironment: 'staging',
        environments: { prod: { allowFullNodeAccess: true } },
      },
    });
    assert.equal(getEffectiveAllowFullNodeAccess(config), false);
  });
});

test('isUnknownActiveEnvironment: true for a defined-but-unselected env, false for a known env', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const unknown = parseGuardrailConfig({
      policy: { activeEnvironment: 'staging', environments: { prod: {} } },
    });
    assert.equal(isUnknownActiveEnvironment(unknown), true);

    const known = parseGuardrailConfig({
      policy: { activeEnvironment: 'prod', environments: { prod: {} } },
    });
    assert.equal(isUnknownActiveEnvironment(known), false);
  });
});

// Negative control: with NO environments defined there is nothing env-scoped to
// lose, so the permissive top-level fallback still applies (unchanged behaviour).
test('empty environments: top-level fallback still applies and tools are allowed', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      allowFullNodeAccess: true,
      policy: { activeEnvironment: 'anything' },
    });
    assert.equal(isUnknownActiveEnvironment(config), false);
    assert.equal(getEffectiveAllowFullNodeAccess(config), true);
    assert.deepEqual(evaluateToolPolicy(config, 'sync_push', {}, false), { allowed: true });
  });
});
