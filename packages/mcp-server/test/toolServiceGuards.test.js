// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-96 (GATE-2) coverage close-out for dist/toolService.js.
//
// The global 90%-line / 80%-branch gate let this module sit at 82.22% line /
// 80.30% branch while several exports had NO test file at all — including
// `enforcePreflightForTool`, the gate `src/index.ts` calls before every mutating
// tool. A safety gate at 0% coverage is the exact failure mode a global-average
// floor hides, so this suite covers behaviour rather than lines:
//
//   - enforcePreflightForTool  — which conditions block a mutation and which do not
//   - writeFileWithStableBackup — a failed backup must never swallow the write
//   - resolveScopeCode          — session-resolution fallbacks
//   - getSourceDirectory        — sync.config.js parsing fallbacks
//   - findScriptIncludeLocalPaths — malformed manifest / name mismatch
//   - parseMetadataType         — the metadata-type allowlist
//   - makeDryRunAuditResponse   — a dry run must still be audited
//   - checkSyncronaCapabilities — one failing probe must not lose the others
//
// Technique: the compiled output is CommonJS, so every cross-module call goes
// through a namespace object at CALL time (`sessionContext_1.getSessionContext(...)`).
// Overwriting the export on the already-loaded module therefore swaps the
// collaborator with no loader tricks. `runtimeConfig.PROJECT_DIR` is a plain
// writable property, so it is redirected to a mkdtemp directory: filesystem
// behaviour stays real but sandboxed. node:test runs each test FILE in its own
// child process, so these mutations cannot leak into another suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  enforcePreflightForTool,
  writeFileWithStableBackup,
  resolveScopeCode,
  getSourceDirectory,
  findScriptIncludeLocalPaths,
  parseMetadataType,
  makeDryRunAuditResponse,
  checkSyncronaCapabilities,
} = require('../dist/toolService.js');
const runtimeConfig = require('../dist/runtimeConfig.js');
const sessionContext = require('../dist/sessionContext.js');
const servicenowCore = require('../dist/servicenowCore.js');
const audit = require('../dist/audit.js');

// A tool from MUTATING_TOOLS (safetyPolicy.ts) — preflight only applies to these.
const MUTATING_TOOL = 'sync_push';
const READ_ONLY_TOOL = 'sync_get_session_context';

function tmpProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `syncrona-${prefix}-`));
}

function okContext(overrides) {
  return {
    scope: { scope: 'x_acme_app' },
    updateSet: { name: 'ACME dev', sysId: 'abc123' },
    ...(overrides || {}),
  };
}

/**
 * Runs enforcePreflightForTool against a sandboxed project directory holding
 * `guardrails` (omitted = no guardrail file at all) and a stubbed session.
 * Returns the thrown error (or null) plus how many times the session was read.
 */
async function runPreflight({ toolName, guardrails, context, sessionError }) {
  const projectDir = tmpProject('preflight');
  if (guardrails !== undefined) {
    fs.writeFileSync(
      path.join(projectDir, 'sync.mcp.guardrails.json'),
      typeof guardrails === 'string' ? guardrails : JSON.stringify(guardrails),
      'utf-8'
    );
  }

  const prevProjectDir = runtimeConfig.PROJECT_DIR;
  const prevGetSessionContext = sessionContext.getSessionContext;
  let sessionCalls = 0;
  let error = null;
  try {
    runtimeConfig.PROJECT_DIR = projectDir;
    sessionContext.getSessionContext = async () => {
      sessionCalls += 1;
      if (sessionError) {
        throw sessionError;
      }
      return context || okContext();
    };
    await enforcePreflightForTool(toolName, 5000);
  } catch (err) {
    error = err;
  } finally {
    runtimeConfig.PROJECT_DIR = prevProjectDir;
    sessionContext.getSessionContext = prevGetSessionContext;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  return { error, sessionCalls };
}

// ---------------------------------------------------------------------------
// enforcePreflightForTool — the pre-mutation safety gate (src/index.ts)
// ---------------------------------------------------------------------------

test('enforcePreflightForTool ignores non-mutating tools even when guardrails would fail', async () => {
  // Guardrails demand a scope the stubbed session does NOT report, so a tool that
  // reached the check would throw. A read-only tool must short-circuit before the
  // config is even consulted — proven by the session never being read.
  const { error, sessionCalls } = await runPreflight({
    toolName: READ_ONLY_TOOL,
    guardrails: { enforcePreflightForMutations: true, expectedScope: 'x_other_scope' },
  });
  assert.equal(error, null);
  assert.equal(sessionCalls, 0);
});

test('enforcePreflightForTool does not enforce when no guardrail file exists', async () => {
  // Absent config is a legitimate "no guardrails configured" state: permissive.
  const { error, sessionCalls } = await runPreflight({ toolName: MUTATING_TOOL });
  assert.equal(error, null);
  assert.equal(sessionCalls, 0, 'no enforcement means no session round-trip');
});

test('enforcePreflightForTool does not enforce when the flag is explicitly false', async () => {
  const { error, sessionCalls } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: { enforcePreflightForMutations: false, expectedScope: 'x_other_scope' },
  });
  assert.equal(error, null);
  assert.equal(sessionCalls, 0);
});

test('enforcePreflightForTool blocks a mutating tool on a scope mismatch', async () => {
  const { error, sessionCalls } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: { enforcePreflightForMutations: true, expectedScope: 'x_other_scope' },
  });
  assert.ok(error instanceof Error);
  // The message must name the tool and point at the two ways out.
  assert.equal(
    error.message,
    `Preflight failed for mutating tool ${MUTATING_TOOL}. Run sync_prepare_session or fix guardrails in sync.mcp.guardrails.json.`
  );
  assert.equal(sessionCalls, 1);
});

test('enforcePreflightForTool passes when scope and update set both match', async () => {
  const { error, sessionCalls } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: {
      enforcePreflightForMutations: true,
      expectedScope: 'x_acme_app',
      expectedUpdateSetName: 'ACME dev',
      expectedUpdateSetSysId: 'abc123',
    },
  });
  assert.equal(error, null);
  assert.equal(sessionCalls, 1);
});

test('enforcePreflightForTool blocks on an update-set sysId mismatch even when the scope matches', async () => {
  const { error } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: {
      enforcePreflightForMutations: true,
      expectedScope: 'x_acme_app',
      expectedUpdateSetSysId: 'not-the-active-one',
    },
  });
  assert.ok(error instanceof Error, 'a wrong update set must block the push');
  assert.match(error.message, /^Preflight failed for mutating tool/);
});

test('enforcePreflightForTool blocks on an update-set name mismatch', async () => {
  const { error } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: {
      enforcePreflightForMutations: true,
      expectedScope: 'x_acme_app',
      expectedUpdateSetName: 'Default [Global]',
    },
  });
  assert.ok(error instanceof Error);
});

test('enforcePreflightForTool enforces via a per-tool requirePreflight policy', async () => {
  // The global flag is off; only the tool-scoped policy asks for preflight.
  const guardrails = {
    enforcePreflightForMutations: false,
    expectedScope: 'x_other_scope',
    policy: {
      activeEnvironment: 'default',
      tools: { [MUTATING_TOOL]: { requirePreflight: true } },
      environments: {},
    },
  };
  const blocked = await runPreflight({ toolName: MUTATING_TOOL, guardrails });
  assert.ok(blocked.error instanceof Error, 'the tool named in the policy is gated');

  // A different mutating tool is not named, so it stays ungated — proving the
  // per-tool policy is read per tool and not treated as a global switch.
  const allowed = await runPreflight({ toolName: 'sync_set_scope', guardrails });
  assert.equal(allowed.error, null);
  assert.equal(allowed.sessionCalls, 0);
});

test('enforcePreflightForTool enforces via the active environment policy', async () => {
  const { error } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: {
      enforcePreflightForMutations: false,
      expectedScope: 'x_other_scope',
      policy: {
        activeEnvironment: 'prod',
        tools: {},
        environments: { prod: { enforcePreflightForMutations: true } },
      },
    },
  });
  assert.ok(error instanceof Error, 'an env-scoped flag must gate mutations too');
});

test('enforcePreflightForTool treats a missing scope in the session as a mismatch', async () => {
  const { error } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: { enforcePreflightForMutations: true, expectedScope: 'x_acme_app' },
    context: { scope: {}, updateSet: {} },
  });
  assert.ok(error instanceof Error, 'an unresolvable scope must not satisfy an expectation');
});

test('enforcePreflightForTool propagates a session-resolution failure instead of passing', async () => {
  // buildPreflightReport deliberately calls getSessionContext directly (not the
  // swallowing safeGetSessionContext): if the instance cannot be reached the
  // mutation must be blocked, never waved through as "checks unknown".
  const { error } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: { enforcePreflightForMutations: true, expectedScope: 'x_acme_app' },
    sessionError: new Error('instance unreachable'),
  });
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'instance unreachable');
});

test('enforcePreflightForTool does NOT enforce on an unreadable guardrail config', async () => {
  // Documents where fail-closed actually lives: an unreadable config yields the
  // invalid marker, whose preflight flag is the permissive default, so this gate
  // is a no-op. Mutations are refused one layer up in evaluateToolPolicy
  // (`guardrail config unreadable — refusing mutations`), which is the layer to
  // change if this ever needs to fail closed here too.
  const { error, sessionCalls } = await runPreflight({
    toolName: MUTATING_TOOL,
    guardrails: '{ this is not json',
  });
  assert.equal(error, null);
  assert.equal(sessionCalls, 0);
});

// ---------------------------------------------------------------------------
// writeFileWithStableBackup
// ---------------------------------------------------------------------------

test('writeFileWithStableBackup writes a new file without creating a backup', () => {
  const dir = tmpProject('backup');
  try {
    const target = path.join(dir, 'script.js');
    writeFileWithStableBackup(target, 'first');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'first');
    assert.equal(fs.existsSync(`${target}.bak`), false, 'nothing to back up yet');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileWithStableBackup preserves the previous content in the .bak file', () => {
  const dir = tmpProject('backup');
  try {
    const target = path.join(dir, 'script.js');
    fs.writeFileSync(target, 'original', 'utf-8');
    writeFileWithStableBackup(target, 'replacement');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'replacement');
    assert.equal(fs.readFileSync(`${target}.bak`, 'utf-8'), 'original');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileWithStableBackup keeps the backup one generation behind', () => {
  const dir = tmpProject('backup');
  try {
    const target = path.join(dir, 'script.js');
    fs.writeFileSync(target, 'v1', 'utf-8');
    writeFileWithStableBackup(target, 'v2');
    writeFileWithStableBackup(target, 'v3');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'v3');
    // The value the user can restore is always the state immediately before the
    // last write — not the original, and never a copy of the new content.
    assert.equal(fs.readFileSync(`${target}.bak`, 'utf-8'), 'v2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileWithStableBackup still writes when the backup cannot be created', () => {
  const dir = tmpProject('backup');
  try {
    const target = path.join(dir, 'script.js');
    fs.writeFileSync(target, 'original', 'utf-8');
    // A DIRECTORY at the backup path makes writeFileSync(backupPath) throw EISDIR.
    // Backup is best-effort: the failure must be swallowed and the real write must
    // still land, otherwise a stray path would make the tool permanently unusable.
    fs.mkdirSync(`${target}.bak`);
    writeFileWithStableBackup(target, 'replacement');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'replacement');
    assert.equal(fs.statSync(`${target}.bak`).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveScopeCode
// ---------------------------------------------------------------------------

async function withSession(impl, fn) {
  const prev = sessionContext.getSessionContext;
  try {
    sessionContext.getSessionContext = impl;
    return await fn();
  } finally {
    sessionContext.getSessionContext = prev;
  }
}

test('resolveScopeCode trims and returns the preferred scope without a session lookup', async () => {
  let called = 0;
  const resolved = await withSession(
    async () => {
      called += 1;
      return okContext();
    },
    () => resolveScopeCode('  x_explicit_scope  ', 5000)
  );
  assert.equal(resolved, 'x_explicit_scope');
  assert.equal(called, 0, 'an explicit scope must not cost a round-trip');
});

test('resolveScopeCode falls back to the session scope when no preference is given', async () => {
  const resolved = await withSession(
    async () => okContext(),
    () => resolveScopeCode('   ', 5000)
  );
  assert.equal(resolved, 'x_acme_app');
});

test('resolveScopeCode returns unknown_scope when the session lookup fails', async () => {
  const resolved = await withSession(
    async () => {
      throw new Error('offline');
    },
    () => resolveScopeCode('', 5000)
  );
  assert.equal(resolved, 'unknown_scope');
});

test('resolveScopeCode returns unknown_scope when the session carries no scope', async () => {
  const resolved = await withSession(
    async () => ({ scope: { scope: '' }, updateSet: {} }),
    () => resolveScopeCode('', 5000)
  );
  assert.equal(resolved, 'unknown_scope');
});

// ---------------------------------------------------------------------------
// getSourceDirectory — each case uses a FRESH temp dir so require() cannot
// serve a cached sync.config.js from a previous case.
// ---------------------------------------------------------------------------

function withConfig(contents, assertFn) {
  const dir = tmpProject('srcdir');
  try {
    if (contents !== undefined) {
      fs.writeFileSync(path.join(dir, 'sync.config.js'), contents, 'utf-8');
    }
    assertFn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getSourceDirectory defaults to src when sync.config.js is absent', () => {
  withConfig(undefined, (dir) => {
    assert.equal(getSourceDirectory(dir), 'src');
  });
});

test('getSourceDirectory reads sourceDirectory from a CJS config', () => {
  withConfig('module.exports = { sourceDirectory: "app-src" };', (dir) => {
    assert.equal(getSourceDirectory(dir), 'app-src');
  });
});

test('getSourceDirectory unwraps a default export', () => {
  withConfig('module.exports = { default: { sourceDirectory: "from-default" } };', (dir) => {
    assert.equal(getSourceDirectory(dir), 'from-default');
  });
});

test('getSourceDirectory falls back to src for a blank sourceDirectory', () => {
  withConfig('module.exports = { sourceDirectory: "   " };', (dir) => {
    assert.equal(getSourceDirectory(dir), 'src');
  });
});

test('getSourceDirectory falls back to src for a non-string sourceDirectory', () => {
  withConfig('module.exports = { sourceDirectory: 42 };', (dir) => {
    assert.equal(getSourceDirectory(dir), 'src');
  });
});

test('getSourceDirectory falls back to src when the config exports a non-object', () => {
  withConfig('module.exports = "src-string";', (dir) => {
    assert.equal(getSourceDirectory(dir), 'src');
  });
});

test('getSourceDirectory falls back to src when the config throws on load', () => {
  // A user config that blows up must not take the MCP server down with it.
  withConfig('throw new Error("boom");', (dir) => {
    assert.equal(getSourceDirectory(dir), 'src');
  });
});

// ---------------------------------------------------------------------------
// findScriptIncludeLocalPaths
// ---------------------------------------------------------------------------

function withManifest(manifest, assertFn, configContents) {
  const dir = tmpProject('manifest');
  try {
    if (manifest !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'sync.manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
        'utf-8'
      );
    }
    if (configContents !== undefined) {
      fs.writeFileSync(path.join(dir, 'sync.config.js'), configContents, 'utf-8');
    }
    assertFn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function manifestWith(records) {
  return { tables: { sys_script_include: { records } } };
}

test('findScriptIncludeLocalPaths returns nothing when the manifest is absent', () => {
  withManifest(undefined, (dir) => {
    assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), []);
  });
});

test('findScriptIncludeLocalPaths returns nothing for a malformed manifest', () => {
  // A truncated download must degrade to "no local path known", not crash the tool.
  withManifest('{"tables": {', (dir) => {
    assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), []);
  });
});

test('findScriptIncludeLocalPaths returns nothing when the manifest has no script includes', () => {
  withManifest({ tables: { sys_script: { records: {} } } }, (dir) => {
    assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), []);
  });
});

test('findScriptIncludeLocalPaths skips records whose name does not match', () => {
  withManifest(
    manifestWith({
      sysid1: { name: 'OtherUtils', files: [{ name: 'script', type: 'js' }] },
    }),
    (dir) => {
      assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), []);
    }
  );
});

test('findScriptIncludeLocalPaths builds one path per manifest file entry', () => {
  withManifest(
    manifestWith({
      sysid1: {
        name: 'AcmeUtils',
        files: [
          { name: 'script', type: 'js' },
          { name: 'script', type: 'ts' },
        ],
      },
      sysid2: { name: 'OtherUtils', files: [{ name: 'script', type: 'js' }] },
    }),
    (dir) => {
      assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), [
        path.join(dir, 'src', 'sys_script_include', 'AcmeUtils', 'script.js'),
        path.join(dir, 'src', 'sys_script_include', 'AcmeUtils', 'script.ts'),
      ]);
    }
  );
});

test('findScriptIncludeLocalPaths honours a custom sourceDirectory', () => {
  withManifest(
    manifestWith({ sysid1: { name: 'AcmeUtils', files: [{ name: 'script', type: 'js' }] } }),
    (dir) => {
      assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), [
        path.join(dir, 'app-src', 'sys_script_include', 'AcmeUtils', 'script.js'),
      ]);
    },
    'module.exports = { sourceDirectory: "app-src" };'
  );
});

test('findScriptIncludeLocalPaths defaults a file entry with no name or type to script.js', () => {
  withManifest(
    manifestWith({ sysid1: { name: 'AcmeUtils', files: [{}] } }),
    (dir) => {
      assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), [
        path.join(dir, 'src', 'sys_script_include', 'AcmeUtils', 'script.js'),
      ]);
    }
  );
});

test('findScriptIncludeLocalPaths tolerates a matching record with no files array', () => {
  withManifest(manifestWith({ sysid1: { name: 'AcmeUtils', files: 'not-an-array' } }), (dir) => {
    assert.deepEqual(findScriptIncludeLocalPaths('AcmeUtils', dir), []);
  });
});

// ---------------------------------------------------------------------------
// parseMetadataType — an allowlist, so unknown input must be rejected, not coerced
// ---------------------------------------------------------------------------

test('parseMetadataType accepts every allowed metadata type', () => {
  const allowed = [
    'business_rule',
    'client_script',
    'ui_script',
    'ui_action',
    'ui_formatter',
    'acl',
    'dictionary',
    'ui_policy',
    'scripted_rest',
    'scheduled_job',
  ];
  for (const value of allowed) {
    assert.equal(parseMetadataType(value), value);
  }
});

test('parseMetadataType trims surrounding whitespace before matching', () => {
  assert.equal(parseMetadataType('  business_rule\n'), 'business_rule');
});

test('parseMetadataType rejects unknown or non-string values', () => {
  for (const value of [
    'sys_user',
    'Business_Rule',
    'business rule',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    ['business_rule'],
  ]) {
    assert.equal(parseMetadataType(value), null, `must reject ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// makeDryRunAuditResponse — a simulated mutation must still leave a trail
// ---------------------------------------------------------------------------

function captureAudit(fn) {
  const prev = audit.writeAuditEvent;
  const events = [];
  try {
    audit.writeAuditEvent = (dir, file, entry) => {
      events.push({ dir, file, entry });
    };
    const result = fn();
    return { result, events };
  } finally {
    audit.writeAuditEvent = prev;
  }
}

test('makeDryRunAuditResponse records the plan in the audit log and returns it', () => {
  const { result, events } = captureAudit(() =>
    makeDryRunAuditResponse(
      MUTATING_TOOL,
      { scope: 'x_acme_app', dryRun: true },
      { files: 3 },
      'corr_abc'
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].dir, runtimeConfig.AUDIT_DIR);
  assert.equal(events[0].file, runtimeConfig.AUDIT_FILE);
  assert.equal(events[0].entry.tool, MUTATING_TOOL);
  assert.equal(events[0].entry.dryRun, true, 'the trail must mark this as a simulation');
  assert.deepEqual(events[0].entry.outcome, { dryRun: true, planned: { files: 3 } });
  assert.equal(events[0].entry.correlationId, 'corr_abc');

  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, {
    dryRun: true,
    tool: MUTATING_TOOL,
    planned: { files: 3 },
  });
});

test('makeDryRunAuditResponse derives the top-level dryRun flag from the args, not the plan', () => {
  // SEC-6 / REV-151 asymmetry, asserted so it cannot silently invert: the
  // `outcome.dryRun` field is whatever the caller planned, but the top-level
  // `entry.dryRun` is isEffectiveDryRun(tool, args) — the REQUEST plus proof the
  // tool honours it. A handler that returns a dry-run response without
  // `args.dryRun === true` is therefore logged as a real run, which is the safe
  // direction: the tamper-evident log never overstates safety.
  const { events } = captureAudit(() =>
    makeDryRunAuditResponse(MUTATING_TOOL, { scope: 'x_acme_app' }, { files: 3 })
  );
  assert.equal(events[0].entry.dryRun, false);
  assert.deepEqual(events[0].entry.outcome, { dryRun: true, planned: { files: 3 } });
});

test('makeDryRunAuditResponse omits the correlationId when none is supplied', () => {
  const { events } = captureAudit(() =>
    makeDryRunAuditResponse(MUTATING_TOOL, {}, { files: 0 })
  );
  assert.equal(events.length, 1);
  assert.equal('correlationId' in events[0].entry, false);
});

test('makeDryRunAuditResponse writes no audit entry for a non-mutating tool', () => {
  // The mutating-tool audit log stays a log of MUTATIONS; a read-only tool's dry
  // run must not pad it. The response is still produced.
  const { result, events } = captureAudit(() =>
    makeDryRunAuditResponse(READ_ONLY_TOOL, {}, { note: 'nothing to do' })
  );
  assert.equal(events.length, 0);
  assert.equal(result.structuredContent.tool, READ_ONLY_TOOL);
});

// ---------------------------------------------------------------------------
// checkSyncronaCapabilities
// ---------------------------------------------------------------------------

async function withProbes({ scopeProbe, request }, fn) {
  const prevScope = servicenowCore.getCurrentScopeWithFallback;
  const prevRequest = servicenowCore.snScopedApiRequest;
  const calls = [];
  try {
    servicenowCore.getCurrentScopeWithFallback = async (...args) => {
      calls.push({ kind: 'scope', args });
      return scopeProbe();
    };
    servicenowCore.snScopedApiRequest = async (method, route, body, timeoutMs) => {
      calls.push({ kind: 'request', method, route, body, timeoutMs });
      return request(route);
    };
    const result = await fn();
    return { result, calls };
  } finally {
    servicenowCore.getCurrentScopeWithFallback = prevScope;
    servicenowCore.snScopedApiRequest = prevRequest;
  }
}

test('checkSyncronaCapabilities uses an explicit scope and skips the scope probe', async () => {
  const { result, calls } = await withProbes(
    {
      scopeProbe: () => {
        throw new Error('must not be called');
      },
      request: () => ({ usedEndpoint: '/api/x_nuvo_sinc', status: 200 }),
    },
    () => checkSyncronaCapabilities(4321, 'x_given_scope')
  );

  assert.equal(calls.some((c) => c.kind === 'scope'), false);
  const manifestCall = calls.find((c) => c.route.startsWith('sinc/getManifest/'));
  assert.equal(manifestCall.route, 'sinc/getManifest/x_given_scope');
  assert.equal(manifestCall.timeoutMs, 4321);
  assert.deepEqual(Object.keys(result), [
    'getCurrentScope',
    'getAppList',
    'getManifestSample',
    'runBackgroundScript',
  ]);
  assert.deepEqual(result.getAppList, {
    endpoint: '/api/x_nuvo_sinc',
    status: 200,
    ok: true,
  });
});

test('checkSyncronaCapabilities resolves the current scope when none is given', async () => {
  const { calls } = await withProbes(
    {
      scopeProbe: () => ({ data: { result: { scope: 'x_resolved_scope' } } }),
      request: () => ({ usedEndpoint: '/api/_sync', status: 200 }),
    },
    () => checkSyncronaCapabilities(5000)
  );
  const manifestCall = calls.find((c) => c.kind === 'request' && c.route.includes('getManifest'));
  assert.equal(manifestCall.route, 'sinc/getManifest/x_resolved_scope');
});

test('checkSyncronaCapabilities falls back to unknown_scope when the scope probe fails', async () => {
  const { calls } = await withProbes(
    {
      scopeProbe: () => {
        throw new Error('instance unreachable');
      },
      request: () => ({ usedEndpoint: '/api/_sync', status: 200 }),
    },
    () => checkSyncronaCapabilities(5000)
  );
  const manifestCall = calls.find((c) => c.kind === 'request' && c.route.includes('getManifest'));
  assert.equal(manifestCall.route, 'sinc/getManifest/unknown_scope');
});

test('checkSyncronaCapabilities reports a failing probe without losing the others', async () => {
  const { result } = await withProbes(
    {
      scopeProbe: () => ({ data: { result: { scope: 'x_acme_app' } } }),
      request: (route) => {
        if (route === 'sinc/runBackgroundScript') {
          throw new Error('403 forbidden');
        }
        return { usedEndpoint: `/api/x_nuvo_sinc/${route}`, status: 200 };
      },
    },
    () => checkSyncronaCapabilities(5000)
  );

  // The failure is recorded per check; the endpoint falls back to the route and
  // the probe is explicitly NOT ok, so a partial outage is visible rather than
  // collapsing the whole capability report.
  assert.deepEqual(result.runBackgroundScript, {
    endpoint: 'sinc/runBackgroundScript',
    status: 0,
    ok: false,
    error: '403 forbidden',
  });
  assert.equal(result.getAppList.ok, true);
  assert.equal(result.getCurrentScope.ok, true);
  assert.equal(result.getManifestSample.ok, true);
});

test('checkSyncronaCapabilities marks a non-2xx response as not ok', async () => {
  const { result } = await withProbes(
    {
      scopeProbe: () => ({ data: { result: { scope: 'x_acme_app' } } }),
      request: () => ({ usedEndpoint: '/api/_sync', status: 404 }),
    },
    () => checkSyncronaCapabilities(5000)
  );
  assert.equal(result.getAppList.status, 404);
  assert.equal(result.getAppList.ok, false);
});

test('checkSyncronaCapabilities stringifies a non-Error probe rejection', async () => {
  const { result } = await withProbes(
    {
      scopeProbe: () => ({ data: { result: { scope: 'x_acme_app' } } }),
      request: () => {
        throw 'socket hang up';
      },
    },
    () => checkSyncronaCapabilities(5000)
  );
  assert.equal(result.getAppList.error, 'socket hang up');
});
