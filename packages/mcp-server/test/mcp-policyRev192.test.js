// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 follow-up (REV-148/REV-192): every nested guardrail node used to go through
// asRecord(), which turns a string, number or array into `{}`. A malformed guardrail
// file therefore parsed as "no policy configured" — the fully permissive default — with
// `invalid` unset, so evaluateToolPolicy() allowed every tool and
// getEffectiveAllowFullNodeAccess() fell back to the top-level flag. That is the exact
// inversion the fail-closed marker exists to prevent: the sibling checks (config root,
// allowTools, denyTools) all fail CLOSED on their own malformed shape.
//   REV-148 covers `policy`, `policy.tools` and `policy.environments`.
//   REV-192 covers the ENTRY values inside `policy.tools` / `policy.environments`.
// Against the pre-fix code every MALFORMED case below parses with invalid === undefined
// and evaluateToolPolicy(sync_push) === {allowed: true}.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGuardrailConfig,
  evaluateToolPolicy,
  getEffectiveAllowFullNodeAccess,
  DEFAULT_GUARDRAIL_CONFIG,
} = require('../dist/policyConfig.js');

// getActiveEnvironmentName() prefers SYNCRONA_ENV over policy.activeEnvironment, so an
// inherited value would decide these cases instead of the config under test.
delete process.env.SYNCRONA_ENV;

const MALFORMED = [
  ['policy is a string', { policy: 'strict' }, /policy is not an object/],
  ['policy is an array', { policy: ['strict'] }, /policy is not an object/],
  ['policy is a number', { policy: 42 }, /policy is not an object/],
  [
    'policy.tools is an array',
    { policy: { tools: ['sn_execute_background_script'] } },
    /policy\.tools is not an object/,
  ],
  [
    'policy.tools is a string',
    { policy: { tools: 'deny-all' } },
    /policy\.tools is not an object/,
  ],
  [
    'policy.environments is a string',
    { policy: { activeEnvironment: 'prod', environments: 'prod' } },
    /policy\.environments is not an object/,
  ],
  [
    'policy.environments is an array',
    { policy: { environments: [{ prod: {} }] } },
    /policy\.environments is not an object/,
  ],
  // REV-192: the entry values one level deeper.
  [
    'a tool policy entry is a string',
    { policy: { tools: { sync_push: 'deny' } } },
    /tool policy "sync_push" is not an object/,
  ],
  [
    'a tool policy entry is an array',
    { policy: { tools: { sync_push: ['deny'] } } },
    /tool policy "sync_push" is not an object/,
  ],
  [
    'an environment entry is a string',
    { policy: { activeEnvironment: 'prod', environments: { prod: 'strict' } } },
    /environment "prod" is not an object/,
  ],
];

for (const [label, input, reasonPattern] of MALFORMED) {
  test(`REV-192: ${label} fails closed instead of disabling the guardrails`, () => {
    const config = parseGuardrailConfig(input);
    assert.equal(config.invalid, true);
    assert.match(config.invalidReason, reasonPattern);
    // The consequence that matters: mutations are refused and full node access is off.
    const decision = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(decision.allowed, false);
    assert.equal(getEffectiveAllowFullNodeAccess(config), false);
  });
}

test('REV-192: a well-formed config is unaffected (no spurious invalid marker)', () => {
  const config = parseGuardrailConfig({
    policy: {
      activeEnvironment: 'prod',
      environments: { prod: { denyTools: ['sn_execute_background_script'] } },
      // `null` still means "absent", not "malformed".
      tools: { sync_push: { requireDryRun: true }, sn_create_record: null },
    },
  });
  assert.equal(Boolean(config.invalid), false);
  assert.equal(evaluateToolPolicy(config, 'sync_push', {}, true).allowed, true);
  assert.equal(
    evaluateToolPolicy(config, 'sn_execute_background_script', {}, true).allowed,
    false
  );
});

test('REV-192: undefined / {} keep their permissive meaning', () => {
  assert.equal(Boolean(parseGuardrailConfig(undefined).invalid), false);
  assert.deepEqual(parseGuardrailConfig({}), DEFAULT_GUARDRAIL_CONFIG);
});
