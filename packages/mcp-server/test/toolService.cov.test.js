// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeTimeout,
  loadGuardrailConfig,
  makeDryRunResponse,
  buildHealthHttpSnapshot,
  generateCorrelationId,
  resolveCorrelationId,
  withCorrelationIdInResponse,
  getToolMetrics,
  clearToolMetrics,
  replaceToolMetrics,
  setAuditIntegrityStatus,
} = require('../dist/toolService.js');

// ---------------------------------------------------------------------------
// normalizeTimeout
// ---------------------------------------------------------------------------

test('normalizeTimeout returns default for non-number input', () => {
  assert.equal(normalizeTimeout(undefined), 120000);
  assert.equal(normalizeTimeout(null), 120000);
  assert.equal(normalizeTimeout('5000'), 120000);
  assert.equal(normalizeTimeout({}), 120000);
});

test('normalizeTimeout returns default for NaN', () => {
  assert.equal(normalizeTimeout(NaN), 120000);
});

test('normalizeTimeout clamps below the floor to 1000', () => {
  assert.equal(normalizeTimeout(0), 1000);
  assert.equal(normalizeTimeout(-500), 1000);
  assert.equal(normalizeTimeout(999), 1000);
});

test('normalizeTimeout clamps above the ceiling to 900000', () => {
  assert.equal(normalizeTimeout(1000000), 900000);
  assert.equal(normalizeTimeout(900001), 900000);
});

test('normalizeTimeout passes through valid in-range values', () => {
  assert.equal(normalizeTimeout(5000), 5000);
  assert.equal(normalizeTimeout(1000), 1000);
  assert.equal(normalizeTimeout(900000), 900000);
});

// ---------------------------------------------------------------------------
// loadGuardrailConfig
// ---------------------------------------------------------------------------

test('loadGuardrailConfig returns default config when file is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolservice-guardrail-'));
  try {
    const cfg = loadGuardrailConfig(tmpDir);
    assert.equal(cfg.enforcePreflightForMutations, false);
    assert.equal(cfg.expectedScope, '');
    assert.equal(cfg.policy.activeEnvironment, 'default');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadGuardrailConfig parses a valid config file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolservice-guardrail-'));
  try {
    const cfgPath = path.join(tmpDir, 'sync.mcp.guardrails.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        enforcePreflightForMutations: true,
        expectedScope: 'x_my_scope',
        policy: { activeEnvironment: 'prod', tools: {}, environments: {} },
      }),
      'utf-8'
    );
    const cfg = loadGuardrailConfig(tmpDir);
    assert.equal(cfg.enforcePreflightForMutations, true);
    assert.equal(cfg.expectedScope, 'x_my_scope');
    assert.equal(cfg.policy.activeEnvironment, 'prod');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadGuardrailConfig returns default config on invalid JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolservice-guardrail-'));
  try {
    const cfgPath = path.join(tmpDir, 'sync.mcp.guardrails.json');
    fs.writeFileSync(cfgPath, '{ not valid json', 'utf-8');
    const cfg = loadGuardrailConfig(tmpDir);
    assert.equal(cfg.enforcePreflightForMutations, false);
    assert.equal(cfg.expectedScope, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadGuardrailConfig defaults projectDir param when omitted', () => {
  // Exercises the default-parameter branch (PROJECT_DIR = process.cwd()).
  // The package root has no sync.mcp.guardrails.json so this falls back to defaults.
  const cfg = loadGuardrailConfig();
  assert.equal(typeof cfg.enforcePreflightForMutations, 'boolean');
  assert.ok(cfg.policy);
});

// ---------------------------------------------------------------------------
// makeDryRunResponse
// ---------------------------------------------------------------------------

test('makeDryRunResponse builds a well-formed dry-run envelope', () => {
  const res = makeDryRunResponse('sync_push', { file: 'a.js' });
  assert.equal(res.isError, false);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.tool, 'sync_push');
  assert.deepEqual(parsed.planned, { file: 'a.js' });
});

test('makeDryRunResponse mirrors the text payload into structuredContent', () => {
  // Dry-run responses are success results, so tools that declare an
  // outputSchema must carry structuredContent identical to the text block.
  const res = makeDryRunResponse('sync_set_scope', { scope: 'x_app' });
  assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text));
});

// ---------------------------------------------------------------------------
// buildHealthHttpSnapshot
// ---------------------------------------------------------------------------

test('buildHealthHttpSnapshot reports ok status with server/audit metadata', () => {
  clearToolMetrics();
  const snapshot = buildHealthHttpSnapshot();
  assert.equal(snapshot.status, 'ok');
  assert.equal(typeof snapshot.timestamp, 'string');
  assert.ok(snapshot.uptimeSeconds >= 0);
  assert.equal(snapshot.server.name, 'syncrona-mcp-server');
  assert.equal(snapshot.server.transport, 'stdio');
  assert.ok(snapshot.server.toolCount > 0);
  assert.ok(snapshot.metrics);
  assert.ok(Array.isArray(snapshot.metrics.windows));
  assert.ok(snapshot.audit);
});

test('buildHealthHttpSnapshot reflects recorded metrics and audit integrity status', () => {
  clearToolMetrics();
  replaceToolMetrics([
    { tool: 'sync_status', ok: true, latencyMs: 12, timestamp: new Date().toISOString() },
  ]);
  setAuditIntegrityStatus('verified');
  const snapshot = buildHealthHttpSnapshot();
  assert.equal(snapshot.audit.integrity, 'verified');
  assert.ok(snapshot.metrics.tools.sync_status);
  assert.equal(snapshot.metrics.tools.sync_status.total, 1);
  clearToolMetrics();
  setAuditIntegrityStatus('unknown');
});

// ---------------------------------------------------------------------------
// generateCorrelationId / resolveCorrelationId
// ---------------------------------------------------------------------------

test('generateCorrelationId derives the timestamp segment from the given seed', () => {
  const id = generateCorrelationId(0);
  assert.match(id, /^corr_0_[a-z0-9]+$/);
});

test('generateCorrelationId clamps negative seeds to 0', () => {
  const id = generateCorrelationId(-100);
  assert.match(id, /^corr_0_[a-z0-9]+$/);
});

test('generateCorrelationId encodes a positive seed as base36', () => {
  const id = generateCorrelationId(1234567890);
  const expectedTsPart = (1234567890).toString(36);
  assert.ok(id.startsWith(`corr_${expectedTsPart}_`));
});

test('resolveCorrelationId returns a sanitized, truncated explicit id when provided', () => {
  const id = resolveCorrelationId({ correlationId: '  weird id!@# ' }, 0);
  assert.equal(id, 'weird_id___');
});

test('resolveCorrelationId truncates overly long explicit ids to 120 chars', () => {
  const long = 'a'.repeat(200);
  const id = resolveCorrelationId({ correlationId: long }, 0);
  assert.equal(id.length, 120);
});

test('resolveCorrelationId falls back to generateCorrelationId when correlationId is missing', () => {
  const id = resolveCorrelationId({}, 0);
  assert.match(id, /^corr_0_[a-z0-9]+$/);
});

test('resolveCorrelationId falls back to generateCorrelationId when correlationId is blank', () => {
  const id = resolveCorrelationId({ correlationId: '   ' }, 0);
  assert.match(id, /^corr_0_[a-z0-9]+$/);
});

test('resolveCorrelationId falls back to generateCorrelationId when correlationId is not a string', () => {
  const id = resolveCorrelationId({ correlationId: 12345 }, 0);
  assert.match(id, /^corr_0_[a-z0-9]+$/);
});

// ---------------------------------------------------------------------------
// withCorrelationIdInResponse
// ---------------------------------------------------------------------------

test('withCorrelationIdInResponse returns response unchanged when content is empty', () => {
  const res = { isError: false, content: [] };
  const out = withCorrelationIdInResponse(res, 'corr_1');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse returns response unchanged when content is not an array', () => {
  const res = { isError: false, content: undefined };
  const out = withCorrelationIdInResponse(res, 'corr_1');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse returns response unchanged when first text block is blank', () => {
  const res = { isError: false, content: [{ type: 'text', text: '   ' }] };
  const out = withCorrelationIdInResponse(res, 'corr_1');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse injects correlationId into a JSON object payload', () => {
  const res = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_abc');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.correlationId, 'corr_abc');
  assert.equal(parsed.ok, true);
  // The handler never opted into structuredContent, so injecting the
  // correlation id must not conjure one.
  assert.equal('structuredContent' in out, false);
});

test('withCorrelationIdInResponse keeps structuredContent identical to the rebuilt text payload', () => {
  const res = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    structuredContent: { ok: true },
  };
  const out = withCorrelationIdInResponse(res, 'corr_mirror');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.correlationId, 'corr_mirror');
  assert.deepEqual(out.structuredContent, parsed);
});

test('withCorrelationIdInResponse leaves an existing non-blank correlationId untouched', () => {
  const res = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ correlationId: 'already-set' }) }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_new');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse overrides a blank existing correlationId', () => {
  const res = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ correlationId: '   ' }) }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_new');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.correlationId, 'corr_new');
});

test('withCorrelationIdInResponse preserves trailing content blocks', () => {
  const res = {
    isError: false,
    content: [
      { type: 'text', text: JSON.stringify({ a: 1 }) },
      { type: 'text', text: 'second block' },
    ],
  };
  const out = withCorrelationIdInResponse(res, 'corr_x');
  assert.equal(out.content.length, 2);
  assert.equal(out.content[1].text, 'second block');
});

test('withCorrelationIdInResponse converges a JSON array payload into a structured error (error case)', () => {
  const res = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify([1, 2, 3]) }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_arr');
  assert.match(out.content[0].text, /Tool execution failed \[TOOL_EXECUTION\]/);
  assert.match(out.content[0].text, /corr_arr/);
});

test('withCorrelationIdInResponse leaves a JSON array payload unchanged on success', () => {
  const res = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify([1, 2, 3]) }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_arr');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse converges plain (non-JSON) error text into structured envelope', () => {
  const res = { isError: true, content: [{ type: 'text', text: 'boom, something broke' }] };
  const out = withCorrelationIdInResponse(res, 'corr_plain');
  assert.match(out.content[0].text, /^Tool execution failed \[TOOL_EXECUTION\]/);
  assert.match(out.content[0].text, /corr_plain/);
});

test('withCorrelationIdInResponse leaves plain non-JSON success text untouched', () => {
  const res = { isError: false, content: [{ type: 'text', text: 'all good, no json here' }] };
  const out = withCorrelationIdInResponse(res, 'corr_plain');
  assert.equal(out, res);
});

test('withCorrelationIdInResponse leaves text already in the structured error envelope alone', () => {
  const res = {
    isError: true,
    content: [{ type: 'text', text: 'Tool execution failed [SOME_CODE]: details here' }],
  };
  const out = withCorrelationIdInResponse(res, 'corr_dup');
  assert.equal(out, res);
});

// ---------------------------------------------------------------------------
// getToolMetrics / clearToolMetrics / replaceToolMetrics / setAuditIntegrityStatus
// ---------------------------------------------------------------------------

test('clearToolMetrics + replaceToolMetrics manage the buffer directly', () => {
  clearToolMetrics();
  assert.equal(getToolMetrics().length, 0);

  replaceToolMetrics([
    { tool: 'a', ok: true, latencyMs: 1, timestamp: new Date().toISOString() },
    { tool: 'b', ok: false, latencyMs: 2, timestamp: new Date().toISOString() },
  ]);
  const metrics = getToolMetrics();
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].tool, 'a');
  assert.equal(metrics[1].tool, 'b');

  clearToolMetrics();
  assert.equal(getToolMetrics().length, 0);
});

test('setAuditIntegrityStatus updates the value reflected in buildHealthHttpSnapshot', () => {
  setAuditIntegrityStatus('tampered');
  const snap1 = buildHealthHttpSnapshot();
  assert.equal(snap1.audit.integrity, 'tampered');

  setAuditIntegrityStatus('ok');
  const snap2 = buildHealthHttpSnapshot();
  assert.equal(snap2.audit.integrity, 'ok');
});
