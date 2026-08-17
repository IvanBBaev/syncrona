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

// A `SYNCRONA_ENV` inherited from the developer's shell selects an environment and can
// change a policy decision, so every assertion in this file would depend on the shell it
// ran from. `node --test` gives each test FILE its own process, so clearing it once here
// is both sufficient and total — and, unlike a save/restore wrapper, it carries no
// set-vs-delete arm that no test ever takes (this package's branch coverage counts test
// files too, so an unreachable arm in a helper is a real branch lost).
delete process.env.SYNCRONA_ENV;

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

// SEC-3 follow-up (REV-197): `requireDryRun` on a tool whose handler ignores dryRun is
// an UNENFORCEABLE lock, and policyConfig refuses it outright rather than letting the
// caller's requested flag stand in for a real simulation. That refusal had no test of
// its own: the branch was reached only incidentally, from whichever suite happened to
// evaluate a policy against a non-dry-run-aware tool, so `dist/policyConfig.js` measured
// 100% on most runs and 97.60 / 99.00 on others — enough to flip the exact-match
// coverage-annotation gate red at random. The declared-second-reading hatch that gate
// now offers does NOT cover this case, and the difference is the whole point of the
// diagnostic: here the uncovered-LINE column moved, which marks a branch nothing
// exercises on purpose, not the V8 range-granularity artefact the hatch exists for.
// A guard this consequential should not depend on an accident for its coverage;
// these two pins drive it directly.
test('evaluateToolPolicy: requireDryRun on a tool that cannot honour it is refused, not enforced', () => {
  // `sn_query_table` is deliberately absent from DRY_RUN_AWARE_TOOLS (pinned by
  // safetyPolicy.tableCompleteness.test.js) — a read-only tool has nothing to simulate.
  const config = parseGuardrailConfig({
    policy: { tools: { sn_query_table: { requireDryRun: true } } },
  });

  withCapturedErrors((calls) => {
    const requested = evaluateToolPolicy(config, 'sn_query_table', {}, true);
    assert.equal(requested.allowed, false);
    assert.match(requested.reason, /does not implement dryRun/);
    assert.match(requested.reason, /fail-closed/);

    // The negative control that makes this a lock rather than a filter: asking for
    // dryRun=true must NOT buy the caller a pass. Before the guard it was the only
    // accepted shape, and it still performed the real mutation.
    const notRequested = evaluateToolPolicy(config, 'sn_query_table', {}, false);
    assert.equal(notRequested.allowed, false);
    assert.match(notRequested.reason, /does not implement dryRun/);

    // An unenforceable guardrail is an operator mistake; it has to reach the log.
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.message, /does not implement dryRun/);
      assert.deepEqual(call.fields, { tool: 'sn_query_table' });
    }
  });
});

test('evaluateToolPolicy: requireDryRun on a dry-run-aware tool still enforces normally', () => {
  // Negative control for the test above: the refusal must be scoped to tools that
  // cannot honour a dry run, not applied to every requireDryRun entry.
  const config = parseGuardrailConfig({
    policy: { tools: { sync_push: { requireDryRun: true } } },
  });
  assert.deepEqual(evaluateToolPolicy(config, 'sync_push', {}, true), { allowed: true });
  const denied = evaluateToolPolicy(config, 'sync_push', {}, false);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /requires dryRun=true/);
});

test('createInvalidGuardrailConfig: produces a deny-all config carrying the reason', () => {
  const cfg = createInvalidGuardrailConfig('boom');
  assert.equal(cfg.invalid, true);
  assert.equal(cfg.invalidReason, 'boom');
  const result = evaluateToolPolicy(cfg, 'sync_push', {}, false);
  assert.equal(result.allowed, false);
  assert.match(result.reason, DENY_REASON);
});
