// SPDX-License-Identifier: GPL-3.0-or-later
//
// Branch-risk coverage: safety gates, the audit tripwire and path/IO fallbacks that
// no existing test drives. Every case here pins a user-visible failure — a bypassed
// confirmation gate, an undetected audit forgery, an ignored footprint budget, a lost
// correlation id, a colliding artifact path, or a crash on a workspace shape that is
// perfectly legal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  requiresConfirmation,
  isDestructiveWorkspaceCommand,
} = require('../dist/safetyPolicy.js');
const { writeAuditEvent, checkAuditLogIntegrity } = require('../dist/audit.js');
const { handleWorkflowTool } = require('../dist/handlers/workflowHandlers.js');
const { executeMcpToolIntegration } = require('../dist/toolService.js');
const {
  getScopeTableDocPath,
  getWorkflowSimulationReportPaths,
  resolveContainedPath,
} = require('../dist/scopePaths.js');
const { startHealthHttpServer } = require('../dist/healthServer.js');
const {
  discoverWorkspaceScopeKnowledge,
  discoverWorkspaceScopeKnowledgeAsync,
} = require('../dist/analysis/scopeDiscovery.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// safetyPolicy.ts — run_workspace_command confirmation gate
// ---------------------------------------------------------------------------

// Pins: a `--no-` prefix must not smuggle an option that is NOT on the read-only
// allowlist past the confirmation gate. `git ls-remote --no-upload-pack=<cmd>` hands
// <cmd> to a shell, so treating every `--no-*` token as "a negated boolean, therefore
// safe" would run arbitrary code with no confirmation prompt at all.
test('git --no-<x> is only safe when --<x> is on the read-only allowlist', () => {
  assert.equal(
    requiresConfirmation('git', ['ls-remote', '--no-upload-pack=touch /tmp/PWN', '.']),
    true,
    '--no-upload-pack executes its value and must require confirmation'
  );
  assert.equal(
    requiresConfirmation('git', ['log', '--no-such-option']),
    true,
    'an unknown --no-* option is default-deny'
  );
});

// Pins: the negation of an allowlisted option stays unconfirmed, so the gate does not
// degrade into prompting on ordinary read-only invocations (which trains users to
// confirm blindly).
test('git --no-<x> stays unconfirmed when --<x> is allowlisted', () => {
  assert.equal(requiresConfirmation('git', ['log', '--no-color']), false);
  assert.equal(requiresConfirmation('git', ['log', '--no-decorate']), false);
});

// Pins: pinning a version on the CLI package token must not hide the destructive
// subcommand behind it. `npx -y syncrona@0.9.1 push` writes to the live instance; if the
// version suffix were not stripped before the package-name lookup, the invocation would
// no longer be recognised as `syncrona push` and would execute without confirmation.
test('a version-pinned CLI package token still resolves to the destructive subcommand', () => {
  assert.equal(
    isDestructiveWorkspaceCommand('npx', ['-y', 'syncrona@0.9.1', 'push']),
    true,
    'syncrona@<version> must resolve to the same package as syncrona'
  );
  assert.equal(requiresConfirmation('npx', ['-y', 'syncrona@0.9.1', 'push']), true);
});

// ---------------------------------------------------------------------------
// audit.ts — high-water tripwire
// ---------------------------------------------------------------------------

// Pins: the NEWEST audit line can be rewritten without breaking anything the chain walk
// checks — its seq is still contiguous and no later line carries its hash — so only the
// out-of-band high-water hash can catch it. Losing that compare means the last recorded
// tool call (the one an attacker most wants to rewrite) is silently forgeable.
test('an in-place edit of the LAST audit line is reported as tampered', () => {
  const dir = mkTmpDir('syncrona-audit-lastline-');
  try {
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 3; i += 1) {
      assert.equal(writeAuditEvent(dir, file, { event: 'evt', idx: i, marker: 'orig' }).ok, true);
    }
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 3);

    // Rewrite the final line but keep its own seq and prevHash intact: the chain walk
    // alone cannot tell the difference.
    const parsed = JSON.parse(lines[2]);
    parsed.marker = 'forged';
    lines[2] = JSON.stringify(parsed);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'tampered');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'last line altered in place');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workflowHandlers.ts — caller-supplied minimal-footprint budget
// ---------------------------------------------------------------------------

function asRecord(value) {
  return value && typeof value === 'object' ? value : {};
}
function toStringField(value) {
  return typeof value === 'string' ? value : '';
}
function toGraphFromUnknown(value) {
  const rec = asRecord(value);
  return {
    nodes: Array.isArray(rec.nodes) ? rec.nodes : [],
    edges: Array.isArray(rec.edges) ? rec.edges : [],
  };
}
function makeWorkflowContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    startedAt: Date.now(),
    parseUnifiedTaskType: (value) =>
      value === 'metadata' || value === 'hybrid' ? value : 'script',
    isDeepAnalysisSatisfied: () => true,
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    asRecord,
    toGraphFromUnknown,
    safeGetSessionContext: async () => null,
    toStringField,
    writeJsonAndMarkdown: () => {},
    runRemoteScript: async () => ({ status: 200, data: {}, text: 'ok', usedEndpoint: '/api/x' }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

const THREE_CHANGES = [
  { filePath: 'src/a.js', objectId: 'sys_script_include:a', estimatedLines: 40 },
  { filePath: 'src/b.js', objectId: 'sys_script_include:b', estimatedLines: 40 },
  { filePath: 'src/c.js', objectId: 'sys_script_include:c', estimatedLines: 40 },
];

// Pins: a caller-supplied footprint budget must actually reach the evaluator. If the
// wiring dropped it, the built-in default (5 files / 200 lines / 10 objects) would apply
// instead, a change a team deliberately capped tighter would report footprintOk:true, and
// `readyForApply` would green-light an apply the budget was meant to block.
test('a caller-supplied minimal-footprint budget is honoured and blocks readyForApply', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply three changes under a tight footprint budget',
      script: 'gs.info("benign");',
      proposedChanges: THREE_CHANGES,
      footprintBudget: { maxFiles: 1, maxLines: 10, maxObjects: 2 },
    },
    makeWorkflowContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(
    payload.minimalFootprint.budget,
    { maxFiles: 1, maxLines: 10, maxObjects: 2 },
    'the caller budget must replace the default, not be ignored'
  );
  assert.equal(payload.minimalFootprint.withinBudget, false);
  assert.equal(payload.minimalFootprint.violations.length, 3);
  assert.equal(payload.gates.footprintOk, false);
  assert.equal(payload.gates.readyForApply, false);
});

// Pins: the default budget still applies when no override is supplied, so the assertion
// above really proves the override took effect rather than the same numbers appearing by
// coincidence.
test('the default minimal-footprint budget applies when no override is supplied', async () => {
  const res = await handleWorkflowTool(
    'sync_unified_change_workflow',
    {
      task: 'apply three changes with no footprint budget',
      script: 'gs.info("benign");',
      proposedChanges: THREE_CHANGES,
    },
    makeWorkflowContext()
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.minimalFootprint.budget.maxFiles, 5);
  assert.equal(payload.minimalFootprint.withinBudget, true);
  assert.equal(payload.gates.footprintOk, true);
});

// ---------------------------------------------------------------------------
// toolService.ts — executeMcpToolIntegration result normalisation
// ---------------------------------------------------------------------------

const INTEGRATION_OPTS = {
  timeoutMs: 1000,
  dryRun: true,
  // Supplying preflight/sessionContext keeps this entirely offline: without them the
  // workflow module would try to reach a live instance.
  preflight: { checks: { allOk: true } },
  sessionContext: { scope: { scope: 'x_branch_risk' } },
};

// Pins: a tool error that is NOT JSON (a bare validation message) must still come back
// with the caller's correlation id attached. Dropping it breaks the join between the
// integration caller's log line and the audit record for the same call, which is the only
// way to reconstruct what a failed automated run actually did.
test('executeMcpToolIntegration keeps the correlation id on a plain-text tool error', async () => {
  const result = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    {},
    { ...INTEGRATION_OPTS, correlationId: 'corr-plain-text-error' }
  );
  assert.equal(result.isError, true);
  assert.equal(result.payload.message, 'Missing required field: task');
  assert.equal(result.payload.correlationId, 'corr-plain-text-error');
});

// Pins: a JSON tool payload that carries no correlation id of its own gets the caller's
// injected rather than returned anonymous.
test('executeMcpToolIntegration injects the correlation id into a JSON tool payload', async () => {
  const result = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    { task: 'inspect a benign change', script: 'gs.info("benign");' },
    { ...INTEGRATION_OPTS, correlationId: 'corr-json-payload' }
  );
  assert.equal(result.payload.correlationId, 'corr-json-payload');
  assert.equal(result.payload.task, 'inspect a benign change');
});

// Pins: an unknown tool name is refused by name instead of falling through to a generic
// success, and the refusal is still correlated.
test('executeMcpToolIntegration refuses an unsupported tool by name', async () => {
  const result = await executeMcpToolIntegration(
    'sync_not_a_real_tool',
    {},
    { ...INTEGRATION_OPTS, correlationId: 'corr-unsupported' }
  );
  assert.equal(result.isError, true);
  assert.match(String(result.payload.error), /Unsupported tool in integration helper/);
  assert.equal(result.payload.correlationId, 'corr-unsupported');
});

// ---------------------------------------------------------------------------
// scopePaths.ts — artifact path derivation
// ---------------------------------------------------------------------------

// Pins: a table name that normalises to nothing must not produce a hidden `.md` dotfile.
// Every such table would write to the SAME invisible file, so one table's docs would
// silently overwrite another's and neither would appear in a directory listing.
test('a punctuation-only table name falls back to a visible file name', () => {
  const docPath = getScopeTableDocPath('x_demo', '---');
  assert.equal(path.basename(docPath), 'table.md');
  assert.notEqual(path.basename(docPath), '.md');
});

// Pins: the same fallback for a simulation id — otherwise two simulation reports with
// different (punctuation-only) ids collapse onto one file name.
test('a punctuation-only simulation id falls back to a visible report name', () => {
  const paths = getWorkflowSimulationReportPaths('x_demo', '!!!');
  assert.equal(
    path.basename(paths.markdownPath),
    'x_demo-workflow-simulation-default.md'
  );
  assert.equal(
    path.basename(paths.jsonPath),
    'x_demo-workflow-simulation-default.json'
  );
});

// Pins: a model-supplied relative path that escapes the docs bundle must throw rather
// than resolve. This is the only guard between a doc-bundle write and an arbitrary
// filesystem overwrite outside the project.
test('resolveContainedPath refuses a path that escapes the bundle', () => {
  const base = path.join(os.tmpdir(), 'syncrona-docs-bundle');
  assert.throws(
    () => resolveContainedPath(base, '../../etc/victim'),
    /Refusing to write outside the docs bundle/
  );
  assert.throws(
    () => resolveContainedPath(base, path.join(os.tmpdir(), 'elsewhere', 'x.md')),
    /Refusing to write outside the docs bundle/
  );
  // A legitimate nested path still resolves inside the bundle.
  const ok = resolveContainedPath(base, 'tables/incident.md');
  assert.equal(ok, path.join(base, 'tables', 'incident.md'));
});

// ---------------------------------------------------------------------------
// healthServer.ts — published health URL
// ---------------------------------------------------------------------------

// Pins: an IPv6 bind host must be bracketed in the published URL. Without the brackets
// the health endpoint advertises `http://::1:8080/healthz`, which no URL parser and no
// monitoring probe can resolve — the endpoint is up but unreachable by the address it
// reports.
test('the health endpoint URL brackets an IPv6 host', async () => {
  let server = null;
  try {
    server = await startHealthHttpServer(
      { enabled: true, port: 0, host: '::1', path: '/healthz' },
      () => ({ ok: true }),
      () => {}
    );
  } catch (error) {
    // No IPv6 loopback on this host: nothing to assert, and the test must not fail
    // for an environment reason.
    assert.ok(error);
    return;
  }
  try {
    assert.equal(server.url, `http://[::1]:${server.port}/healthz`);
    assert.equal(new URL(server.url).hostname, '[::1]');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// analysis/scopeDiscovery.ts — workspace without a src/ tree
// ---------------------------------------------------------------------------

// Pins: a project directory with no `src/` is a legal state (a fresh checkout, a
// docs-only repo, a scope that has never been downloaded). Scope discovery must answer
// with an empty graph; throwing ENOENT here fails the whole tool call with a filesystem
// error the user cannot act on.
test('scope discovery returns an empty graph when the workspace has no src/ directory', async () => {
  const dir = mkTmpDir('syncrona-no-src-');
  try {
    const sync = discoverWorkspaceScopeKnowledge(dir);
    assert.deepEqual(sync.entities, []);
    assert.deepEqual(sync.graph, { nodes: [], edges: [] });

    const async_ = await discoverWorkspaceScopeKnowledgeAsync(dir, {});
    assert.deepEqual(async_.entities, []);
    assert.deepEqual(async_.graph, { nodes: [], edges: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// REV-213. Pins: the two exported twins must answer a workspace the same way. The
// test above already pins the "no src/ at all" shape; this one pins the shape that
// gets PAST `existsSync(sourceDir)` and then cannot be listed, which is where the two
// disagreed. `discoverWorkspaceScopeKnowledgeAsync` wrapped its `readdir` in a
// try/catch and continued; the sync twin called `readdirSync` bare in the `for...of`
// header — the one unguarded fs call in a walk whose `statSync` and `readFileSync`
// were both already best-effort — so it threw ENOTDIR out of `sync_scope_knowledge`,
// a READ path, instead of reporting the entities it could see.
//
// The stake is not the exception type: it is that which of the two exported entry
// points a caller happens to use decided whether a legal-but-awkward working tree
// produced a graph or a filesystem error the user cannot act on.
test('scope discovery degrades to an empty graph when src/ exists but cannot be listed', async () => {
  const dir = mkTmpDir('syncrona-unlistable-src-');
  try {
    // `src` present as a regular file is the reproducible stand-in for the real
    // cases (a `src` symlink to a file, a directory whose read bit was stripped, a
    // subdirectory removed after the walk pushed it onto its stack): `existsSync`
    // says yes, `readdirSync` raises ENOTDIR.
    fs.writeFileSync(path.join(dir, 'src'), 'not a directory\n', 'utf-8');

    const sync = discoverWorkspaceScopeKnowledge(dir);
    assert.deepEqual(sync.entities, [], 'sync: an unlistable src/ must not throw');
    assert.deepEqual(sync.graph, { nodes: [], edges: [] });

    const async_ = await discoverWorkspaceScopeKnowledgeAsync(dir, {});
    assert.deepEqual(async_, sync, 'the two twins must agree on this workspace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// REV-213 companion: the guard must skip only the directory it could not list, not
// abandon the walk. Without this, "make readdirSync best-effort" could be satisfied
// by a `return` (as the recursive walkers in analysis/semantic.ts legitimately use)
// instead of the `continue` this stack-based loop needs — and every entity queued
// behind the bad directory would silently vanish from the graph.
test('scope discovery skips only the directory it cannot list and still reports its siblings', async () => {
  const dir = mkTmpDir('syncrona-partial-src-');
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(path.join(srcDir, 'good'), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'good', 'incident.js'),
      'var gr = new GlideRecord("incident");\n',
      'utf-8'
    );
    // A dangling symlink that stats as absent: the walk lists it, cannot stat it, and
    // must step over it. Its sibling is the thing that must survive.
    fs.symlinkSync(path.join(srcDir, 'never-existed'), path.join(srcDir, 'ghost'));

    const sync = discoverWorkspaceScopeKnowledge(dir);
    assert.equal(
      sync.entities.some((e) => e.path === 'src/good/incident.js'),
      true,
      'sync: the readable sibling must still be discovered'
    );
    assert.equal(
      sync.graph.nodes.some((n) => n.id === 'table:incident'),
      true,
      'sync: the GlideRecord table edge must still be built'
    );

    const async_ = await discoverWorkspaceScopeKnowledgeAsync(dir, {});
    assert.deepEqual(async_, sync, 'the two twins must agree on this workspace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
