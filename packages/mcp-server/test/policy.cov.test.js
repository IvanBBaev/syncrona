// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGuardrailConfig,
  getActiveEnvironmentName,
  getEnvironmentPolicy,
  getEffectiveAllowFullNodeAccess,
  shouldEnforcePreflight,
  evaluateToolPolicy,
  DEFAULT_GUARDRAIL_CONFIG,
} = require('../dist/policyConfig.js');

const {
  isMutatingTool,
  isUnsafeWorkspaceCommand,
  riskLevelFromScore,
  parseRiskLevel,
  getApprovalRequirements,
  isApprovalSatisfied,
  validateRollbackEvidence,
  evaluateMinimalFootprint,
} = require('../dist/safetyPolicy.js');

const { isSafeRemoteEndpoint } = require('../dist/endpointPolicy.js');

const SYNCRONA_ENV_KEY = 'SYNCRONA_ENV';

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

// ---------------------------------------------------------------------------
// policyConfig.ts
// ---------------------------------------------------------------------------

test('DEFAULT_GUARDRAIL_CONFIG: has expected shape', () => {
  assert.equal(DEFAULT_GUARDRAIL_CONFIG.enforcePreflightForMutations, false);
  assert.equal(DEFAULT_GUARDRAIL_CONFIG.expectedScope, '');
  assert.equal(DEFAULT_GUARDRAIL_CONFIG.allowFullNodeAccess, false);
  assert.deepEqual(DEFAULT_GUARDRAIL_CONFIG.policy.environments, {});
  assert.deepEqual(DEFAULT_GUARDRAIL_CONFIG.policy.tools, {});
  assert.equal(DEFAULT_GUARDRAIL_CONFIG.policy.activeEnvironment, 'default');
});

test('parseGuardrailConfig: null/undefined/primitive input yields defaults', () => {
  for (const input of [null, undefined, 42, 'str', true]) {
    const parsed = parseGuardrailConfig(input);
    assert.equal(parsed.enforcePreflightForMutations, false);
    assert.equal(parsed.expectedScope, '');
    assert.equal(parsed.expectedUpdateSetName, '');
    assert.equal(parsed.expectedUpdateSetSysId, '');
    assert.equal(parsed.allowFullNodeAccess, false);
    assert.equal(parsed.policy.activeEnvironment, 'default');
    assert.deepEqual(parsed.policy.environments, {});
    assert.deepEqual(parsed.policy.tools, {});
  }
});

test('parseGuardrailConfig: empty object yields defaults', () => {
  const parsed = parseGuardrailConfig({});
  assert.deepEqual(parsed, DEFAULT_GUARDRAIL_CONFIG);
});

test('parseGuardrailConfig: trims and reads top-level string fields', () => {
  const parsed = parseGuardrailConfig({
    enforcePreflightForMutations: true,
    expectedScope: '  x_acme_app  ',
    expectedUpdateSetName: '  My Update Set  ',
    expectedUpdateSetSysId: '  abc123  ',
    allowFullNodeAccess: true,
  });
  assert.equal(parsed.enforcePreflightForMutations, true);
  assert.equal(parsed.expectedScope, 'x_acme_app');
  assert.equal(parsed.expectedUpdateSetName, 'My Update Set');
  assert.equal(parsed.expectedUpdateSetSysId, 'abc123');
  assert.equal(parsed.allowFullNodeAccess, true);
});

test('parseGuardrailConfig: non-string top-level fields fall back to empty string / false', () => {
  const parsed = parseGuardrailConfig({
    enforcePreflightForMutations: 'true', // not === true
    expectedScope: 123,
    expectedUpdateSetName: null,
    expectedUpdateSetSysId: {},
    allowFullNodeAccess: 1,
  });
  assert.equal(parsed.enforcePreflightForMutations, false);
  assert.equal(parsed.expectedScope, '');
  assert.equal(parsed.expectedUpdateSetName, '');
  assert.equal(parsed.expectedUpdateSetSysId, '');
  assert.equal(parsed.allowFullNodeAccess, false);
});

test('parseGuardrailConfig: policy.activeEnvironment trims when a non-empty string; falls back to "default" otherwise', () => {
  assert.equal(
    parseGuardrailConfig({ policy: { activeEnvironment: '  staging  ' } }).policy.activeEnvironment,
    'staging'
  );
  assert.equal(
    parseGuardrailConfig({ policy: { activeEnvironment: '   ' } }).policy.activeEnvironment,
    'default'
  );
  assert.equal(
    parseGuardrailConfig({ policy: { activeEnvironment: 42 } }).policy.activeEnvironment,
    'default'
  );
  assert.equal(
    parseGuardrailConfig({ policy: null }).policy.activeEnvironment,
    'default'
  );
});

test('parseGuardrailConfig: parses tools map, coercing non-true values to false', () => {
  const parsed = parseGuardrailConfig({
    policy: {
      tools: {
        sync_push: {
          deny: true,
          requireDryRun: true,
          requireConfirmDestructive: true,
          requirePreflight: true,
        },
        sn_create_record: {
          deny: 'yes', // not strictly true
          requireDryRun: 0,
        },
        empty_tool: null,
      },
    },
  });
  assert.deepEqual(parsed.policy.tools.sync_push, {
    deny: true,
    requireDryRun: true,
    requireConfirmDestructive: true,
    requirePreflight: true,
  });
  assert.deepEqual(parsed.policy.tools.sn_create_record, {
    deny: false,
    requireDryRun: false,
    requireConfirmDestructive: false,
    requirePreflight: false,
  });
  assert.deepEqual(parsed.policy.tools.empty_tool, {
    deny: false,
    requireDryRun: false,
    requireConfirmDestructive: false,
    requirePreflight: false,
  });
});

test('parseGuardrailConfig: parses environments map with allow/deny tool arrays trimmed and filtered', () => {
  const parsed = parseGuardrailConfig({
    policy: {
      environments: {
        prod: {
          allowTools: ['  sync_push  ', '', 42, 'sn_create_record', '   '],
          denyTools: ['sn_execute_background_script'],
          enforcePreflightForMutations: true,
          allowFullNodeAccess: false,
        },
        dev: {
          allowTools: 'not-an-array',
          denyTools: null,
        },
      },
    },
  });
  assert.deepEqual(parsed.policy.environments.prod, {
    allowTools: ['sync_push', 'sn_create_record'],
    denyTools: ['sn_execute_background_script'],
    enforcePreflightForMutations: true,
    allowFullNodeAccess: false,
  });
  assert.deepEqual(parsed.policy.environments.dev, {
    allowTools: [],
    denyTools: [],
    enforcePreflightForMutations: false,
    allowFullNodeAccess: false,
  });
});

test('parseGuardrailConfig: environments.*.allowFullNodeAccess only true when strictly true', () => {
  const parsed = parseGuardrailConfig({
    policy: {
      environments: {
        sandbox: { allowFullNodeAccess: true },
      },
    },
  });
  assert.equal(parsed.policy.environments.sandbox.allowFullNodeAccess, true);
});

test('getActiveEnvironmentName: prefers trimmed SYNCRONA_ENV over config value', () => {
  withEnv(SYNCRONA_ENV_KEY, '  staging  ', () => {
    const config = parseGuardrailConfig({ policy: { activeEnvironment: 'prod' } });
    assert.equal(getActiveEnvironmentName(config), 'staging');
  });
});

test('getActiveEnvironmentName: falls back to config.policy.activeEnvironment when env var unset', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({ policy: { activeEnvironment: 'prod' } });
    assert.equal(getActiveEnvironmentName(config), 'prod');
  });
});

test('getActiveEnvironmentName: falls back to "default" when env var is only whitespace and config has empty string', () => {
  withEnv(SYNCRONA_ENV_KEY, '   ', () => {
    const config = { ...DEFAULT_GUARDRAIL_CONFIG, policy: { ...DEFAULT_GUARDRAIL_CONFIG.policy, activeEnvironment: '' } };
    assert.equal(getActiveEnvironmentName(config), 'default');
  });
});

test('getEnvironmentPolicy: returns empty object when active environment is unknown', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({ policy: { activeEnvironment: 'ghost' } });
    assert.deepEqual(getEnvironmentPolicy(config), {});
  });
});

test('getEnvironmentPolicy: returns the matching environment policy', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowFullNodeAccess: true } },
      },
    });
    assert.equal(getEnvironmentPolicy(config).allowFullNodeAccess, true);
  });
});

test('getEffectiveAllowFullNodeAccess: env policy boolean overrides top-level config', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const configTrueOverride = parseGuardrailConfig({
      allowFullNodeAccess: false,
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowFullNodeAccess: true } },
      },
    });
    assert.equal(getEffectiveAllowFullNodeAccess(configTrueOverride), true);

    const configFalseOverride = parseGuardrailConfig({
      allowFullNodeAccess: true,
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowFullNodeAccess: false } },
      },
    });
    assert.equal(getEffectiveAllowFullNodeAccess(configFalseOverride), false);
  });
});

test('getEffectiveAllowFullNodeAccess: falls back to top-level config when env policy unset', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({ allowFullNodeAccess: true, policy: { activeEnvironment: 'unknown' } });
    assert.equal(getEffectiveAllowFullNodeAccess(config), true);

    const configFalse = parseGuardrailConfig({ allowFullNodeAccess: false, policy: { activeEnvironment: 'unknown' } });
    assert.equal(getEffectiveAllowFullNodeAccess(configFalse), false);
  });
});

test('shouldEnforcePreflight: tool-level requirePreflight=true wins regardless of other flags', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      enforcePreflightForMutations: false,
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { enforcePreflightForMutations: false } },
        tools: { sync_push: { requirePreflight: true } },
      },
    });
    assert.equal(shouldEnforcePreflight(config, 'sync_push'), true);
  });
});

test('shouldEnforcePreflight: environment-level enforcePreflightForMutations=true wins over top-level false', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      enforcePreflightForMutations: false,
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { enforcePreflightForMutations: true } },
      },
    });
    assert.equal(shouldEnforcePreflight(config, 'sync_push'), true);
  });
});

test('shouldEnforcePreflight: falls back to top-level enforcePreflightForMutations', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const configTrue = parseGuardrailConfig({ enforcePreflightForMutations: true });
    assert.equal(shouldEnforcePreflight(configTrue, 'sync_push'), true);

    const configFalse = parseGuardrailConfig({ enforcePreflightForMutations: false });
    assert.equal(shouldEnforcePreflight(configFalse, 'sync_push'), false);
  });
});

test('shouldEnforcePreflight: unknown tool with no policy defaults to top-level flag', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({ enforcePreflightForMutations: true });
    assert.equal(shouldEnforcePreflight(config, 'totally_unknown_tool'), true);
  });
});

test('evaluateToolPolicy: allows a tool with no restrictions', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({});
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.deepEqual(result, { allowed: true });
  });
});

test('evaluateToolPolicy: denies when allowTools is non-empty and tool is not listed', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowTools: ['sync_status'] } },
      },
    });
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /is not allowed in active policy environment prod/);
  });
});

test('evaluateToolPolicy: allows when allowTools includes the tool', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowTools: ['sync_push'] } },
      },
    });
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.deepEqual(result, { allowed: true });
  });
});

test('evaluateToolPolicy: denies when denyTools includes the tool', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { denyTools: ['sync_push'] } },
      },
    });
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /is denied by active policy environment prod/);
  });
});

test('evaluateToolPolicy: denies when tool policy deny=true', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: { tools: { sync_push: { deny: true } } },
    });
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /is denied by policy\.tools\.sync_push\./);
  });
});

test('evaluateToolPolicy: requireDryRun=true denies when dryRun is false, allows when true', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: { tools: { sync_push: { requireDryRun: true } } },
    });
    const denied = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /requires dryRun=true/);

    const allowed = evaluateToolPolicy(config, 'sync_push', {}, true);
    assert.deepEqual(allowed, { allowed: true });
  });
});

test('evaluateToolPolicy: requireConfirmDestructive=true denies without confirmDestructive===true, allows with it', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: { tools: { sync_push: { requireConfirmDestructive: true } } },
    });
    const denied = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /requires confirmDestructive=true/);

    const deniedTruthyButNotBool = evaluateToolPolicy(config, 'sync_push', { confirmDestructive: 'yes' }, false);
    assert.equal(deniedTruthyButNotBool.allowed, false);

    const allowed = evaluateToolPolicy(config, 'sync_push', { confirmDestructive: true }, false);
    assert.deepEqual(allowed, { allowed: true });
  });
});

test('evaluateToolPolicy: checks precedence — allowTools rejection fires before denyTools/tool-level checks', () => {
  withEnv(SYNCRONA_ENV_KEY, undefined, () => {
    const config = parseGuardrailConfig({
      policy: {
        activeEnvironment: 'prod',
        environments: { prod: { allowTools: ['sync_status'] } },
        tools: { sync_push: { deny: true } },
      },
    });
    const result = evaluateToolPolicy(config, 'sync_push', {}, false);
    assert.match(result.reason, /is not allowed in active policy environment/);
  });
});

// ---------------------------------------------------------------------------
// safetyPolicy.ts
// ---------------------------------------------------------------------------

test('isMutatingTool: true for known mutating tools, false for read-only/unknown tools', () => {
  assert.equal(isMutatingTool('sync_push'), true);
  assert.equal(isMutatingTool('sn_create_record'), true);
  assert.equal(isMutatingTool('sync_run_atf_tests'), true);
  assert.equal(isMutatingTool('sync_status'), false);
  assert.equal(isMutatingTool('unknown_tool'), false);
});

test('isUnsafeWorkspaceCommand: blocks exact blocked command basenames', () => {
  assert.equal(isUnsafeWorkspaceCommand('rm', []), true);
  assert.equal(isUnsafeWorkspaceCommand('sudo', []), true);
  assert.equal(isUnsafeWorkspaceCommand('dd', []), true);
  assert.equal(isUnsafeWorkspaceCommand('mkfs', []), true);
  assert.equal(isUnsafeWorkspaceCommand('shutdown', []), true);
  assert.equal(isUnsafeWorkspaceCommand('reboot', []), true);
  assert.equal(isUnsafeWorkspaceCommand('killall', []), true);
  assert.equal(isUnsafeWorkspaceCommand('pkill', []), true);
});

test('isUnsafeWorkspaceCommand: blocks a qualified path to a blocked binary (unix and windows separators)', () => {
  assert.equal(isUnsafeWorkspaceCommand('/bin/rm', []), true);
  assert.equal(isUnsafeWorkspaceCommand('..\\rm', []), true);
  assert.equal(isUnsafeWorkspaceCommand('./sudo', []), true);
  assert.equal(isUnsafeWorkspaceCommand('  /usr/bin/dd  ', []), true);
});

test('isUnsafeWorkspaceCommand: allows a safe command with no unsafe args', () => {
  assert.equal(isUnsafeWorkspaceCommand('node', ['-v']), false);
  assert.equal(isUnsafeWorkspaceCommand('npm', ['run', 'build']), false);
});

test('isUnsafeWorkspaceCommand: blocks shell interpreters only when passed an unsafe -c/--command flag', () => {
  assert.equal(isUnsafeWorkspaceCommand('bash', ['-c', 'echo hi']), true);
  assert.equal(isUnsafeWorkspaceCommand('sh', ['--command', 'echo hi']), true);
  assert.equal(isUnsafeWorkspaceCommand('zsh', ['-c', 'ls']), true);
  assert.equal(isUnsafeWorkspaceCommand('fish', ['-c', 'ls']), true);
  assert.equal(isUnsafeWorkspaceCommand('bash', ['script.sh']), false);
});

test('isUnsafeWorkspaceCommand: blocks any arg containing a shell metacharacter token', () => {
  assert.equal(isUnsafeWorkspaceCommand('echo', ['a && b']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['a || b']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['a; b']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['a | b']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['`whoami`']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['$(whoami)']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['out > file']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['in < file']), true);
  assert.equal(isUnsafeWorkspaceCommand('echo', ['plain-arg']), false);
});

test('riskLevelFromScore: maps score thresholds to risk levels', () => {
  assert.equal(riskLevelFromScore(0), 'low');
  assert.equal(riskLevelFromScore(2.9), 'low');
  assert.equal(riskLevelFromScore(3), 'medium');
  assert.equal(riskLevelFromScore(5.9), 'medium');
  assert.equal(riskLevelFromScore(6), 'high');
  assert.equal(riskLevelFromScore(9.9), 'high');
  assert.equal(riskLevelFromScore(10), 'critical');
  assert.equal(riskLevelFromScore(100), 'critical');
  assert.equal(riskLevelFromScore(-5), 'low');
});

test('parseRiskLevel: accepts case-insensitive/whitespace-trimmed known values', () => {
  assert.equal(parseRiskLevel('low'), 'low');
  assert.equal(parseRiskLevel('  MEDIUM  '), 'medium');
  assert.equal(parseRiskLevel('High'), 'high');
  assert.equal(parseRiskLevel('CRITICAL'), 'critical');
});

test('parseRiskLevel: rejects unknown strings and non-strings', () => {
  assert.equal(parseRiskLevel('extreme'), null);
  assert.equal(parseRiskLevel(''), null);
  assert.equal(parseRiskLevel(42), null);
  assert.equal(parseRiskLevel(null), null);
  assert.equal(parseRiskLevel(undefined), null);
  assert.equal(parseRiskLevel({}), null);
});

test('getApprovalRequirements: returns the expected shape for each risk level', () => {
  assert.deepEqual(getApprovalRequirements('low'), {
    required: false,
    minimumApprovers: 0,
    roles: ['peer-review'],
  });
  assert.deepEqual(getApprovalRequirements('medium'), {
    required: true,
    minimumApprovers: 1,
    roles: ['reviewer'],
  });
  assert.deepEqual(getApprovalRequirements('high'), {
    required: true,
    minimumApprovers: 2,
    roles: ['reviewer', 'owner'],
  });
  assert.deepEqual(getApprovalRequirements('critical'), {
    required: true,
    minimumApprovers: 2,
    roles: ['owner', 'change-manager'],
  });
});

test('getApprovalRequirements: default branch for an unrecognized risk level value', () => {
  assert.deepEqual(getApprovalRequirements('nonsense'), {
    required: true,
    minimumApprovers: 1,
    roles: ['reviewer'],
  });
});

test('isApprovalSatisfied: low risk never requires approval', () => {
  assert.equal(isApprovalSatisfied({}, 'low'), true);
});

test('isApprovalSatisfied: medium/high/critical require an approvalId and enough approvers', () => {
  assert.equal(isApprovalSatisfied({}, 'medium'), false);
  assert.equal(isApprovalSatisfied({ approvalId: '  ' }, 'medium'), false);
  assert.equal(
    isApprovalSatisfied({ approvalId: 'appr-1', approvers: [] }, 'medium'),
    false
  );
  assert.equal(
    isApprovalSatisfied({ approvalId: 'appr-1', approvers: ['alice'] }, 'medium'),
    true
  );
});

test('isApprovalSatisfied: high risk needs at least 2 valid approvers', () => {
  assert.equal(
    isApprovalSatisfied({ approvalId: 'appr-1', approvers: ['alice'] }, 'high'),
    false
  );
  assert.equal(
    isApprovalSatisfied({ approvalId: 'appr-1', approvers: ['alice', 'bob'] }, 'high'),
    true
  );
});

test('isApprovalSatisfied: filters out non-string / blank approvers before counting', () => {
  assert.equal(
    isApprovalSatisfied(
      { approvalId: 'appr-1', approvers: ['alice', '', 42, '   ', null] },
      'high'
    ),
    false
  );
  assert.equal(
    isApprovalSatisfied(
      { approvalId: 'appr-1', approvers: ['alice', 'bob', '', 42] },
      'high'
    ),
    true
  );
});

test('isApprovalSatisfied: approvers not an array counts as zero approvers', () => {
  assert.equal(
    isApprovalSatisfied({ approvalId: 'appr-1', approvers: 'alice' }, 'medium'),
    false
  );
});

test('validateRollbackEvidence: low/medium risk only requires non-empty revertSteps', () => {
  const missing = validateRollbackEvidence({}, 'low');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['revertSteps']);

  const ok = validateRollbackEvidence({ revertSteps: ['step1'] }, 'medium');
  assert.deepEqual(ok, { ok: true, missing: [] });
});

test('validateRollbackEvidence: high/critical risk requires reason, impactedEntities, revertSteps, validationPlan', () => {
  const result = validateRollbackEvidence({}, 'high');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['reason', 'impactedEntities', 'revertSteps', 'validationPlan']);

  const result2 = validateRollbackEvidence(
    {
      reason: 'fixing a bug',
      impactedEntities: ['table_a'],
      revertSteps: 'revert via update set',
      validationPlan: 'run ATF suite',
    },
    'critical'
  );
  assert.deepEqual(result2, { ok: true, missing: [] });
});

test('validateRollbackEvidence: string fields must be non-blank, array fields must be non-empty, other falsy values are missing', () => {
  const result = validateRollbackEvidence(
    {
      reason: '   ',
      impactedEntities: [],
      revertSteps: 0,
      validationPlan: undefined,
    },
    'critical'
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ['impactedEntities', 'reason', 'revertSteps', 'validationPlan'].sort());
});

test('validateRollbackEvidence: truthy non-string non-array value counts as present', () => {
  const result = validateRollbackEvidence({ revertSteps: { plan: 'x' } }, 'low');
  assert.deepEqual(result, { ok: true, missing: [] });
});

test('evaluateMinimalFootprint: empty changes list is within default budget', () => {
  const result = evaluateMinimalFootprint([]);
  assert.deepEqual(result.metrics, { changedFiles: 0, changedLines: 0, changedObjects: 0 });
  assert.deepEqual(result.budget, { maxFiles: 5, maxLines: 200, maxObjects: 10 });
  assert.equal(result.withinBudget, true);
  assert.deepEqual(result.violations, []);
});

test('evaluateMinimalFootprint: dedupes files/objects by trimmed value and sums estimatedLines', () => {
  const result = evaluateMinimalFootprint([
    { filePath: '  a.js  ', objectId: 'obj1', estimatedLines: 10 },
    { filePath: 'a.js', objectId: 'obj1', estimatedLines: 5.9 },
    { filePath: 'b.js', objectId: 'obj2', estimatedLines: -3 },
  ]);
  assert.equal(result.metrics.changedFiles, 2);
  assert.equal(result.metrics.changedObjects, 2);
  // 10 + floor(5.9)=5 + max(floor(-3),0)=0 => 15
  assert.equal(result.metrics.changedLines, 15);
});

test('evaluateMinimalFootprint: ignores non-string filePath/objectId and non-finite estimatedLines', () => {
  const result = evaluateMinimalFootprint([
    { filePath: 42, objectId: null, estimatedLines: Infinity },
    { filePath: '', objectId: '   ' },
  ]);
  assert.equal(result.metrics.changedFiles, 0);
  assert.equal(result.metrics.changedObjects, 0);
  assert.equal(result.metrics.changedLines, 0);
});

test('evaluateMinimalFootprint: flags violations when metrics exceed the default budget', () => {
  const changes = Array.from({ length: 6 }, (_, i) => ({
    filePath: `file${i}.js`,
    objectId: `obj${i}`,
    estimatedLines: 40,
  }));
  const result = evaluateMinimalFootprint(changes);
  assert.equal(result.metrics.changedFiles, 6);
  assert.equal(result.metrics.changedObjects, 6);
  assert.equal(result.metrics.changedLines, 240);
  assert.equal(result.withinBudget, false);
  assert.equal(result.violations.length, 2); // files and lines exceed; objects (6<=10) doesn't
  assert.ok(result.violations.some((v) => v.includes('changedFiles exceeds budget (6/5)')));
  assert.ok(result.violations.some((v) => v.includes('changedLines exceeds budget (240/200)')));
});

test('evaluateMinimalFootprint: changedObjects violation fires independently', () => {
  const changes = Array.from({ length: 11 }, (_, i) => ({ objectId: `obj${i}` }));
  const result = evaluateMinimalFootprint(changes);
  assert.equal(result.withinBudget, false);
  assert.ok(result.violations.some((v) => v.includes('changedObjects exceeds budget (11/10)')));
});

test('evaluateMinimalFootprint: budgetOverride replaces defaults for provided fields', () => {
  const result = evaluateMinimalFootprint(
    [{ filePath: 'a.js', estimatedLines: 500 }],
    { maxFiles: 1, maxLines: 1000 }
  );
  assert.equal(result.budget.maxFiles, 1);
  assert.equal(result.budget.maxLines, 1000);
  assert.equal(result.budget.maxObjects, 10); // unspecified falls back to default
  assert.equal(result.withinBudget, true);
});

test('evaluateMinimalFootprint: sanitizeBudgetValue falls back to default for invalid override values', () => {
  const result = evaluateMinimalFootprint([], {
    maxFiles: Number.NaN,
    maxLines: -5,
    maxObjects: 'ten',
  });
  assert.deepEqual(result.budget, { maxFiles: 5, maxLines: 200, maxObjects: 10 });
});

test('evaluateMinimalFootprint: sanitizeBudgetValue clamps to MAX_MINIMAL_FOOTPRINT_BUDGET and floors decimals', () => {
  const result = evaluateMinimalFootprint([], {
    maxFiles: 999999,
    maxLines: 12.9,
  });
  assert.equal(result.budget.maxFiles, 10000);
  assert.equal(result.budget.maxLines, 12);
});

// ---------------------------------------------------------------------------
// endpointPolicy.ts
// ---------------------------------------------------------------------------

test('isSafeRemoteEndpoint: accepts a well-formed rooted path', () => {
  assert.equal(isSafeRemoteEndpoint('/api/now/table/incident'), true);
  assert.equal(isSafeRemoteEndpoint('/a'), true);
  assert.equal(isSafeRemoteEndpoint('/a.b-c_d/e.f'), true);
});

test('isSafeRemoteEndpoint: rejects a non-rooted or empty string', () => {
  assert.equal(isSafeRemoteEndpoint(''), false);
  assert.equal(isSafeRemoteEndpoint('api/now/table'), false);
});

test('isSafeRemoteEndpoint: rejects paths with disallowed characters', () => {
  assert.equal(isSafeRemoteEndpoint('/api now/table'), false);
  assert.equal(isSafeRemoteEndpoint('/api?query=1'), false);
  assert.equal(isSafeRemoteEndpoint('/api#frag'), false);
  assert.equal(isSafeRemoteEndpoint('/api:8080/table'), false);
});

test('isSafeRemoteEndpoint: rejects path traversal segments even though the character class allows "."', () => {
  assert.equal(isSafeRemoteEndpoint('/../etc/passwd'), false);
  assert.equal(isSafeRemoteEndpoint('/a/../b'), false);
  assert.equal(isSafeRemoteEndpoint('/a/..'), false);
});

test('isSafeRemoteEndpoint: rejects protocol-relative "//host" paths', () => {
  assert.equal(isSafeRemoteEndpoint('//evil.example.com/path'), false);
});

test('isSafeRemoteEndpoint: allows a single dot segment (not treated as traversal)', () => {
  assert.equal(isSafeRemoteEndpoint('/a/./b'), true);
});
