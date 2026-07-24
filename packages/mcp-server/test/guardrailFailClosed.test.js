// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 (REV-84): the guardrail config must FAIL CLOSED. An unreadable file, or a
// malformed field such as a present-but-non-array allowTools, previously widened
// access (permissive DEFAULT / allow-all empty allow-list). These regressions pin
// the deny-all behaviour, the frozen shared default, and the deep-clone fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadGuardrailConfig } = require('../dist/toolService.js');
const {
  parseGuardrailConfig,
  evaluateToolPolicy,
  cloneDefaultGuardrailConfig,
  createInvalidGuardrailConfig,
  DEFAULT_GUARDRAIL_CONFIG,
} = require('../dist/policyConfig.js');
const { logger } = require('../dist/logger.js');

const DENY_REASON = /guardrail config unreadable — refusing mutations/;

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-failclosed-'));
}

// Reassign logger.error on the shared module object so both toolService and
// policyConfig call the stub; always restore in finally.
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

test('loadGuardrailConfig: an unreadable config file fails closed (invalid marker + logged)', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'sync.mcp.guardrails.json'), '{ not: valid json', 'utf-8');
    withCapturedErrors((calls) => {
      const cfg = loadGuardrailConfig(dir);
      assert.equal(cfg.invalid, true);
      assert.equal(typeof cfg.invalidReason, 'string');
      // The fail-closed path must surface the failure on the logger (stderr).
      assert.equal(calls.length >= 1, true);
      assert.match(calls[0].message, /failing closed/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateToolPolicy: an invalid config denies every tool with the fail-closed reason', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'sync.mcp.guardrails.json'), 'definitely-not-json', 'utf-8');
    withCapturedErrors(() => {
      const cfg = loadGuardrailConfig(dir);
      for (const tool of ['sync_push', 'sn_create_record', 'sync_status']) {
        const result = evaluateToolPolicy(cfg, tool, {}, false);
        assert.equal(result.allowed, false);
        assert.match(result.reason, DENY_REASON);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadGuardrailConfig: a MISSING config is a permissive clone, not invalid', () => {
  const dir = mkTmpDir();
  try {
    const cfg = loadGuardrailConfig(dir);
    assert.notEqual(cfg.invalid, true);
    assert.deepEqual(evaluateToolPolicy(cfg, 'sync_push', {}, false), { allowed: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseGuardrailConfig: a present-but-non-array allowTools marks the whole config invalid (no allow-all)', () => {
  const config = parseGuardrailConfig({
    policy: {
      activeEnvironment: 'dev',
      environments: {
        // Typo: a string, not an array. Must NOT normalize to [] (= allow-all).
        dev: { allowTools: 'sync_push' },
      },
    },
  });
  assert.equal(config.invalid, true);
  assert.match(config.invalidReason, /non-array allowTools/);
  const result = evaluateToolPolicy(config, 'sync_push', {}, false);
  assert.equal(result.allowed, false);
  assert.match(result.reason, DENY_REASON);
});

test('parseGuardrailConfig: a healthy empty config is NOT invalid and still deep-equals DEFAULT', () => {
  const config = parseGuardrailConfig({});
  assert.notEqual(config.invalid, true);
  assert.equal('invalid' in config, false);
  assert.deepEqual(config, DEFAULT_GUARDRAIL_CONFIG);
});

test('DEFAULT_GUARDRAIL_CONFIG: the shared default is deeply frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_GUARDRAIL_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_GUARDRAIL_CONFIG.policy), true);
  assert.equal(Object.isFrozen(DEFAULT_GUARDRAIL_CONFIG.policy.environments), true);
  assert.equal(Object.isFrozen(DEFAULT_GUARDRAIL_CONFIG.policy.tools), true);
});

test('cloneDefaultGuardrailConfig: returns a deep, mutable copy that never aliases the frozen default', () => {
  const clone = cloneDefaultGuardrailConfig();
  assert.notEqual(clone, DEFAULT_GUARDRAIL_CONFIG);
  assert.notEqual(clone.policy, DEFAULT_GUARDRAIL_CONFIG.policy);
  assert.equal(Object.isFrozen(clone), false);
  // Mutating the clone must not throw and must not touch the shared default.
  clone.policy.environments.injected = { allowTools: [] };
  assert.deepEqual(DEFAULT_GUARDRAIL_CONFIG.policy.environments, {});
});

test('createInvalidGuardrailConfig: produces a deny-all config carrying the reason', () => {
  const cfg = createInvalidGuardrailConfig('boom');
  assert.equal(cfg.invalid, true);
  assert.equal(cfg.invalidReason, 'boom');
  const result = evaluateToolPolicy(cfg, 'sync_push', {}, false);
  assert.equal(result.allowed, false);
  assert.match(result.reason, DENY_REASON);
});
