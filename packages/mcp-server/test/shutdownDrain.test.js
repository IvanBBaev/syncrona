// SPDX-License-Identifier: GPL-3.0-or-later
// CONC-7 (REV-111): the fixed 5s drain abandoned long in-flight tool calls (and the
//   scope bootstrap) mid-write on SIGTERM. The default is now 30s and operator-tunable
//   via SYNCRONA_SHUTDOWN_DRAIN_MS, clamped to [1s, 10min]; an explicit programmatic
//   option always wins over the env var so callers/tests stay deterministic.
// CONC-4 (REV-108): the scope bootstrap now begins/ends a tracked request (like the
//   CallTool handler), so the shutdown drain WAITS for it instead of racing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createGracefulShutdownController,
  resolveDrainTimeoutMs,
  DEFAULT_DRAIN_TIMEOUT_MS,
  MIN_DRAIN_TIMEOUT_MS,
  MAX_DRAIN_TIMEOUT_MS,
  DRAIN_TIMEOUT_ENV_VAR,
} = require('../dist/gracefulShutdown.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-drain-'));
}

function readDrainedEvent(auditFile) {
  const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n');
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.event === 'shutdown.drained') {
      return record;
    }
  }
  throw new Error('no shutdown.drained event found in audit log');
}

// ---------------------------------------------------------------------------
// CONC-7 (REV-111): resolveDrainTimeoutMs precedence / clamping / validation
// ---------------------------------------------------------------------------

test('resolveDrainTimeoutMs: exposes the documented constants', () => {
  assert.equal(DEFAULT_DRAIN_TIMEOUT_MS, 30000);
  assert.equal(MIN_DRAIN_TIMEOUT_MS, 1000);
  assert.equal(MAX_DRAIN_TIMEOUT_MS, 600000);
  assert.equal(DRAIN_TIMEOUT_ENV_VAR, 'SYNCRONA_SHUTDOWN_DRAIN_MS');
});

test('resolveDrainTimeoutMs: default (30s) with no option and no env', () => {
  assert.equal(resolveDrainTimeoutMs(undefined, {}), 30000);
});

test('resolveDrainTimeoutMs: env var overrides the default', () => {
  assert.equal(resolveDrainTimeoutMs(undefined, { SYNCRONA_SHUTDOWN_DRAIN_MS: '45000' }), 45000);
  assert.equal(resolveDrainTimeoutMs(undefined, { SYNCRONA_SHUTDOWN_DRAIN_MS: '  45000  ' }), 45000);
});

test('resolveDrainTimeoutMs: an explicit option always beats the env var', () => {
  assert.equal(resolveDrainTimeoutMs(12000, { SYNCRONA_SHUTDOWN_DRAIN_MS: '45000' }), 12000);
});

test('resolveDrainTimeoutMs: clamps to [1s, 10min] from either source', () => {
  assert.equal(resolveDrainTimeoutMs(50, {}), 1000);
  assert.equal(resolveDrainTimeoutMs(9999999, {}), 600000);
  assert.equal(resolveDrainTimeoutMs(undefined, { SYNCRONA_SHUTDOWN_DRAIN_MS: '10' }), 1000);
  assert.equal(resolveDrainTimeoutMs(undefined, { SYNCRONA_SHUTDOWN_DRAIN_MS: '999999999' }), 600000);
});

test('resolveDrainTimeoutMs: ignores an invalid env value and falls back to the default', () => {
  for (const bad of ['abc', '0', '-5', '', '   ', 'NaN']) {
    assert.equal(resolveDrainTimeoutMs(undefined, { SYNCRONA_SHUTDOWN_DRAIN_MS: bad }), 30000);
  }
});

test('resolveDrainTimeoutMs: ignores an invalid option and falls through to env/default', () => {
  assert.equal(resolveDrainTimeoutMs(Number.NaN, { SYNCRONA_SHUTDOWN_DRAIN_MS: '45000' }), 45000);
  assert.equal(resolveDrainTimeoutMs(-1, {}), 30000);
  assert.equal(resolveDrainTimeoutMs(0, {}), 30000);
});

// ---------------------------------------------------------------------------
// CONC-4 (REV-108): a tracked (bootstrap-like) request is drained, not raced
// ---------------------------------------------------------------------------

test('shutdown drain waits for a begun request and drains cleanly once it ends', async () => {
  const dir = mkTmpDir();
  try {
    const auditFile = path.join(dir, 'audit.log');
    let polls = 0;
    let exitCode = null;
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 5000,
      pollIntervalMs: 1,
      // End the tracked request on the first poll — mirrors runScopeBootstrap's
      // begin(before)/end(finally) so the drain observes an active request, waits,
      // then sees it complete.
      waitFn: async () => {
        polls += 1;
        if (polls === 1) {
          controller.endRequest();
        }
      },
      exitFn: (code) => {
        exitCode = code;
      },
      logger: () => {},
    });

    // Simulate the scope bootstrap registering itself as an active request.
    assert.equal(controller.beginRequest(), true);

    await controller.shutdown('SIGTERM');

    assert.equal(polls >= 1, true, 'the drain loop must have waited at least one poll');
    const drainedEvent = readDrainedEvent(auditFile);
    assert.equal(drainedEvent.drained, true);
    assert.equal(drainedEvent.pendingRequests, 0);
    assert.equal(exitCode, 0);
    // New requests are refused once shutting down.
    assert.equal(controller.beginRequest(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown drain reports drained=false and the pending count when a tracked request never finishes', async () => {
  const dir = mkTmpDir();
  try {
    const auditFile = path.join(dir, 'audit.log');
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 1000, // smallest allowed drain (clamped floor) keeps the test short
      pollIntervalMs: 50,
      waitFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      exitFn: () => {},
      logger: () => {},
    });

    // A tracked request that is never ended (a bootstrap/tool call that outlives
    // the drain window) must NOT be silently forgotten: the audit records it.
    assert.equal(controller.beginRequest(), true);

    await controller.shutdown('SIGTERM');

    const drainedEvent = readDrainedEvent(auditFile);
    assert.equal(drainedEvent.drained, false);
    assert.equal(drainedEvent.pendingRequests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
