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
  isDestructiveWorkspaceCommand,
  findSyncroCliSubcommand,
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

// Mutation-testing finding (stryker, safetyPolicy.ts:56-71): emptying almost any
// single entry of MUTATING_TOOLS survived the whole suite, because only three of the
// twelve names were ever asserted. A dropped entry is a silent security downgrade —
// isMutatingTool() feeds the preflight gate, the confirmation gate and the audit
// record, so an unlisted tool writes to the instance while the forensic trail calls
// it read-only. DRY_RUN_AWARE_TOOLS is already protected against exactly this drift
// by dryRunAwareTools.contract.test.js (which is why no mutant of that list survived);
// this list has no schema to derive from, so its membership is pinned literally.
test('isMutatingTool: every tool the policy declares mutating is classified as mutating', () => {
  const declaredMutatingTools = [
    'sync_set_scope',
    'sync_set_update_set',
    'sync_prepare_session',
    'sync_push',
    'sn_create_record',
    'sn_execute_background_script',
    'sync_create_script_include',
    'sync_create_script_include_and_sync',
    'sn_update_metadata_record',
    'sn_autonomous_remediation_workflow',
    'sync_unified_change_workflow',
    'sync_run_atf_tests',
  ];
  for (const toolName of declaredMutatingTools) {
    assert.equal(
      isMutatingTool(toolName),
      true,
      `${toolName} must stay on the mutating-tool list (it gates preflight, confirmation and audit)`
    );
  }
});

// run_workspace_command is not a mutating tool by name: the same tool runs
// `syncrona push` (reaches the instance) and `npm test` (does not), so the
// answer has to come from the invocation.

test('isMutatingTool: run_workspace_command is mutating when its args run a destructive CLI subcommand', () => {
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'npx', args: ['syncrona', 'push', '--ci'] }),
    true
  );
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'syncrona', args: ['deploy'] }),
    true
  );
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'pnpm', args: ['dlx', 'syncrona', 'download'] }),
    true
  );
});

test('isMutatingTool: run_workspace_command is not mutating for a local, non-destructive invocation', () => {
  assert.equal(isMutatingTool('run_workspace_command', { command: 'npm', args: ['test'] }), false);
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'npx', args: ['syncrona', 'status'] }),
    false
  );
  assert.equal(isMutatingTool('run_workspace_command', { command: 'git', args: ['push'] }), false);
});

test('isMutatingTool: omitting args keeps the name-only answer so the preflight gate stays name-keyed', () => {
  // enforcePreflightForTool passes no args on purpose: a name-only "true" here
  // would force a live ServiceNow preflight before a purely local `npm test`.
  assert.equal(isMutatingTool('run_workspace_command'), false);
  assert.equal(isMutatingTool('sync_push'), true);
});

test('isMutatingTool: args never downgrade a tool that is mutating by name', () => {
  assert.equal(isMutatingTool('sync_push', { command: 'npm', args: ['test'] }), true);
});

test('isMutatingTool: tolerates malformed run_workspace_command args', () => {
  assert.equal(isMutatingTool('run_workspace_command', {}), false);
  assert.equal(isMutatingTool('run_workspace_command', { command: '   ' }), false);
  assert.equal(isMutatingTool('run_workspace_command', { command: 'syncrona' }), false);
  assert.equal(isMutatingTool('run_workspace_command', { command: 42, args: ['push'] }), false);
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'syncrona', args: 'push' }),
    false
  );
  assert.equal(
    isMutatingTool('run_workspace_command', { command: 'syncrona', args: [null, 'push'] }),
    true
  );
});

test('isDestructiveWorkspaceCommand: is reachable from the policy module', () => {
  assert.equal(isDestructiveWorkspaceCommand('syncrona', ['push']), true);
  assert.equal(isDestructiveWorkspaceCommand('npm', ['test']), false);
});

// Mutation-testing finding (stryker, safetyPolicy.ts:50-51 and :176/:187): only `npx`
// and `pnpm dlx` were ever exercised, so emptying "npm", "yarn" or "bun" from
// PACKAGE_MANAGERS — or "exec"/"run" from PACKAGE_MANAGER_EXEC_SUBCOMMANDS — left the
// suite green while `npm exec syncrona push` stopped being recognised as destructive.
// The whole declared matrix is asserted here because each entry is one bypass.
test('isDestructiveWorkspaceCommand: every declared package-manager exec form reaches the CLI', () => {
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    for (const subcommand of ['exec', 'dlx', 'run']) {
      assert.equal(
        isDestructiveWorkspaceCommand(manager, [subcommand, 'syncrona', 'push']),
        true,
        `${manager} ${subcommand} syncrona push must be recognised as destructive`
      );
    }
  }
  // The runner form takes the package name directly.
  for (const runner of ['npx', 'pnpx', 'bunx']) {
    assert.equal(
      isDestructiveWorkspaceCommand(runner, ['syncrona', 'deploy']),
      true,
      `${runner} syncrona deploy must be recognised as destructive`
    );
  }
});

// Mutation-testing finding (stryker, safetyPolicy.ts:176 and :187): the exec-subcommand
// lookup happens at the FIRST OPERAND, and the argv is trimmed and emptied first. Both
// steps were unasserted, and both are trivially reachable by a caller: a manager flag
// before the subcommand, a stray empty argument, or an untrimmed one. Each mutation
// turned a real `syncrona push` into an unrecognised (therefore unconfirmed, and
// audited as read-only) invocation, so the padding forms are pinned.
test('isDestructiveWorkspaceCommand: argv padding cannot hide a package-manager exec form', () => {
  assert.equal(
    isDestructiveWorkspaceCommand('npm', ['--silent', 'exec', 'syncrona', 'push']),
    true,
    'a manager flag before the exec subcommand must not hide the invocation'
  );
  assert.equal(
    isDestructiveWorkspaceCommand('npm', ['', 'exec', 'syncrona', 'push']),
    true,
    'an empty argument must not hide the invocation'
  );
  assert.equal(
    isDestructiveWorkspaceCommand('npm', [' exec ', ' syncrona ', ' push ']),
    true,
    'untrimmed arguments must not hide the invocation'
  );
  // Mixed case is handled too (the reason the index is taken before lowercasing).
  assert.equal(isDestructiveWorkspaceCommand('npm', ['EXEC', 'syncrona', 'push']), true);
});

// Mutation-testing finding (stryker, safetyPolicy.ts:144-145): the launcher-suffix strip
// and the backslash normalisation in normalizeBinaryName had no test at all, so
// `npx.cmd` and `C:\...\npx.cmd` — the ordinary Windows spellings — could stop being
// recognised without the suite noticing. requiresConfirmation() still gates a
// path-qualified command by REV-141, but isMutatingTool() does not: it would classify a
// live `syncrona push` as read-only and the audit record would say so.
test('isDestructiveWorkspaceCommand: Windows launcher spellings still reach the CLI', () => {
  const windowsInvocations = [
    ['npx.cmd', ['syncrona', 'push']],
    ['npm.exe', ['exec', 'syncrona', 'push']],
    ['C:\\Program Files\\nodejs\\npx.cmd', ['syncrona', 'push']],
    ['..\\node_modules\\.bin\\syncrona.cmd', ['push']],
  ];
  for (const [command, args] of windowsInvocations) {
    assert.equal(
      isDestructiveWorkspaceCommand(command, args),
      true,
      `${command} ${args.join(' ')} must be recognised as destructive`
    );
    assert.equal(
      isMutatingTool('run_workspace_command', { command, args }),
      true,
      `${command} ${args.join(' ')} must be audited as a mutating invocation`
    );
  }
});

// Mutation-testing finding (stryker, safetyPolicy.ts:161-242): findSyncroCliSubcommand is
// exported but no test imported it, so mutants that made it return null for EVERY input,
// or return the package token instead of the subcommand, all survived. It is documented
// as best-effort and must not be used for a security decision, but it is still a public
// API whose answer ends up in operator-facing output.
test('findSyncroCliSubcommand: resolves the subcommand for the invocation forms it supports', () => {
  assert.equal(findSyncroCliSubcommand('syncrona', ['push']), 'push');
  assert.equal(findSyncroCliSubcommand('syncrona', ['status', '--json']), 'status');
  // The package token itself is not the subcommand, and flags are not operands.
  assert.equal(findSyncroCliSubcommand('npx', ['-y', 'syncrona', 'push']), 'push');
  assert.equal(findSyncroCliSubcommand('npm', ['exec', 'syncrona', 'deploy']), 'deploy');
  // Not an invocation of the CLI at all.
  assert.equal(findSyncroCliSubcommand('npm', ['test']), null);
  assert.equal(findSyncroCliSubcommand('git', ['push']), null);
  // No operand after the package token.
  assert.equal(findSyncroCliSubcommand('npx', ['syncrona']), null);
});

// The documented limitation, pinned so it stays a KNOWN one: a space-separated global
// option value occupies the first operand position, so the "subcommand" reported for
// `syncrona --logLevel debug push` is the option's value. This is why every security
// decision goes through isDestructiveWorkspaceCommand, which checks every operand.
test('findSyncroCliSubcommand: known limitation — a detached option value shadows the subcommand', () => {
  assert.equal(findSyncroCliSubcommand('syncrona', ['--logLevel', 'debug', 'push']), 'debug');
  assert.equal(isDestructiveWorkspaceCommand('syncrona', ['--logLevel', 'debug', 'push']), true);
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

// Mutation-testing finding (stryker, safetyPolicy.ts:732-733): removing the approvalId
// requirement entirely — and removing its .trim() — both survived, because every case
// that exercised a missing or blank id ALSO had zero approvers, so the approver count
// carried the assertion on its own. With enough approvers present, the two guards are
// what stop approval evidence that names no approval record from satisfying the gate.
test('isApprovalSatisfied: a missing or blank approvalId fails even with enough approvers', () => {
  assert.equal(
    isApprovalSatisfied({ approvers: ['alice'] }, 'medium'),
    false,
    'approval evidence without an approvalId must not satisfy the gate'
  );
  assert.equal(
    isApprovalSatisfied({ approvalId: '   ', approvers: ['alice'] }, 'medium'),
    false,
    'a whitespace-only approvalId must not satisfy the gate'
  );
  assert.equal(
    isApprovalSatisfied({ approvalId: '', approvers: ['alice', 'bob'] }, 'high'),
    false,
    'an empty approvalId must not satisfy the gate'
  );
  // The same evidence with a real id does satisfy it, so the assertions above are
  // failing on the id and not on the approver count.
  assert.equal(isApprovalSatisfied({ approvalId: 'appr-1', approvers: ['alice'] }, 'medium'), true);
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

// Mutation-testing finding (stryker, safetyPolicy.ts:834 and :837): flipping the line
// and object comparisons from `>` to `>=` survived — only the file comparison had a
// boundary test. The budget is a MAXIMUM, so a change that lands exactly on it is
// within budget; without this the gate would refuse the largest allowed change and the
// documented numbers (200 lines, 10 objects) would silently mean 199 and 9.
test('evaluateMinimalFootprint: metrics exactly at the budget are still within it', () => {
  // 5 files, 10 objects, 10 x 20 = 200 lines: the default budget exactly.
  const changes = Array.from({ length: 10 }, (_, i) => ({
    filePath: `file${i % 5}.js`,
    objectId: `obj${i}`,
    estimatedLines: 20,
  }));
  const result = evaluateMinimalFootprint(changes);
  assert.deepEqual(result.metrics, { changedFiles: 5, changedLines: 200, changedObjects: 10 });
  assert.deepEqual(result.violations, []);
  assert.equal(result.withinBudget, true);
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
