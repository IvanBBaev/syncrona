// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCommand, runSyncroCliCommand } = require('../dist/processRunner.js');
const {
  parseLogLevel,
  parseLogFormat,
  configureLogger,
  getLoggerConfig,
  logger,
} = require('../dist/logger.js');
const { sanitizeForAudit, writeAuditEvent, checkAuditLogIntegrity } = require('../dist/audit.js');
const { appendMetricEvent, loadMetricEvents } = require('../dist/metricsStore.js');
const {
  closeResource,
  createGracefulShutdownController,
} = require('../dist/gracefulShutdown.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// processRunner.ts
// ---------------------------------------------------------------------------

test('runCommand resolves with stdout/exitCode 0 on success', async () => {
  const res = await runCommand(process.execPath, ['-e', 'console.log("hello-world")'], 5000, process.cwd());
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /hello-world/);
  assert.equal(res.timedOut, false);
});

test('runCommand captures stderr and non-zero exit code', async () => {
  const res = await runCommand(
    process.execPath,
    ['-e', 'process.stderr.write("boom"); process.exit(3)'],
    5000,
    process.cwd()
  );
  assert.equal(res.exitCode, 3);
  assert.match(res.stderr, /boom/);
});

test('runCommand passes extraEnv into the child process', async () => {
  const res = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.MY_TEST_VAR || "")'],
    5000,
    process.cwd(),
    { MY_TEST_VAR: 'injected-value' }
  );
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /injected-value/);
});

test('runCommand resolves with exitCode 1 and error message when spawn fails', async () => {
  const res = await runCommand('this-binary-does-not-exist-xyz', [], 5000, process.cwd());
  assert.equal(res.exitCode, 1);
  assert.equal(res.timedOut, false);
  assert.ok(res.stderr.length > 0);
});

test('runCommand times out and kills a long-running child', async () => {
  const res = await runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    200,
    process.cwd()
  );
  assert.equal(res.timedOut, true);
  // exitCode should reflect the killed process (non-zero or null-coalesced to 1)
  assert.notEqual(res.exitCode, 0);
}, { timeout: 10000 });

test('runCommand truncates stdout that exceeds the capture cap', async () => {
  // Write well beyond MAX_OUTPUT_CHARS (5,000,000) using a tight loop that emits
  // large chunks quickly, so the truncation-notice path is exercised without a
  // slow test.
  const script =
    "const chunk = 'x'.repeat(1000000); for (let i = 0; i < 6; i++) { process.stdout.write(chunk); } ";
  const res = await runCommand(process.execPath, ['-e', script], 15000, process.cwd());
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /\[output truncated: exceeded capture limit\]/);
}, { timeout: 20000 });

test('runCommand truncates stderr that exceeds the capture cap', async () => {
  const script =
    "const chunk = 'x'.repeat(1000000); for (let i = 0; i < 6; i++) { process.stderr.write(chunk); } ";
  const res = await runCommand(process.execPath, ['-e', script], 15000, process.cwd());
  assert.equal(res.exitCode, 0);
  assert.match(res.stderr, /\[output truncated: exceeded capture limit\]/);
}, { timeout: 20000 });

test('runSyncroCliCommand uses the local core dist when it exists relative to __dirname', async () => {
  // In this monorepo checkout, packages/core/dist/index.js exists relative to
  // dist/processRunner.js's __dirname, so this exercises the "node localCoreCli"
  // branch. We only assert the call resolves with a well-formed CmdResult.
  const res = await runSyncroCliCommand('--help', [], 5000, process.cwd());
  assert.equal(typeof res.exitCode, 'number');
  assert.equal(typeof res.stdout, 'string');
  assert.equal(typeof res.stderr, 'string');
}, { timeout: 10000 });

// ---------------------------------------------------------------------------
// logger.ts
// ---------------------------------------------------------------------------

test('parseLogLevel accepts all valid levels case-insensitively and trims', () => {
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.equal(parseLogLevel('INFO'), 'info');
  assert.equal(parseLogLevel('  warn  '), 'warn');
  assert.equal(parseLogLevel('Error'), 'error');
  assert.equal(parseLogLevel('silent'), 'silent');
});

test('parseLogLevel falls back to default "info" for invalid/missing values', () => {
  assert.equal(parseLogLevel(undefined), 'info');
  assert.equal(parseLogLevel(null), 'info');
  assert.equal(parseLogLevel('bogus'), 'info');
  assert.equal(parseLogLevel(''), 'info');
});

test('parseLogFormat reads from env-style value', () => {
  assert.equal(parseLogFormat('json'), 'json');
  assert.equal(parseLogFormat('TEXT'), 'text');
  assert.equal(parseLogFormat('nonsense'), 'text');
  assert.equal(parseLogFormat(undefined), 'text');
});

test('parseLogFormat prefers --log-format <value> CLI flag over env value', () => {
  assert.equal(parseLogFormat('text', ['node', 'script', '--log-format', 'json']), 'json');
  assert.equal(parseLogFormat('json', ['node', 'script', '--log-format', 'text']), 'text');
});

test('parseLogFormat ignores --log-format flag with invalid trailing value', () => {
  assert.equal(parseLogFormat('json', ['node', 'script', '--log-format', 'bogus']), 'json');
});

test('parseLogFormat ignores --log-format at end of argv with no following value', () => {
  assert.equal(parseLogFormat('json', ['node', 'script', '--log-format']), 'json');
});

test('parseLogFormat supports --log-format=value inline syntax', () => {
  assert.equal(parseLogFormat('text', ['--log-format=json']), 'json');
  assert.equal(parseLogFormat('text', ['--log-format=bogus']), 'text');
});

test('configureLogger/getLoggerConfig roundtrip updates level and format independently', () => {
  const original = getLoggerConfig();
  try {
    configureLogger({ level: 'debug' });
    assert.equal(getLoggerConfig().level, 'debug');

    configureLogger({ format: 'json' });
    let cfg = getLoggerConfig();
    assert.equal(cfg.format, 'json');
    assert.equal(cfg.level, 'debug');

    configureLogger({ level: 'error', format: 'text' });
    cfg = getLoggerConfig();
    assert.equal(cfg.level, 'error');
    assert.equal(cfg.format, 'text');

    // Calling with no options changes nothing.
    configureLogger();
    cfg = getLoggerConfig();
    assert.equal(cfg.level, 'error');
    assert.equal(cfg.format, 'text');
  } finally {
    configureLogger(original);
  }
});

test('logger writes to stderr in text format honoring level threshold', () => {
  const original = getLoggerConfig();
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    configureLogger({ level: 'warn', format: 'text' });
    logger.debug('should-not-appear');
    logger.info('should-not-appear-either');
    logger.warn('warn-message', { foo: 'bar', count: 3, flag: true, skip: undefined });
    logger.error('error-message');

    assert.equal(captured.length, 2);
    assert.match(captured[0], /WARN warn-message foo=bar count=3 flag=true/);
    assert.doesNotMatch(captured[0], /skip=/);
    assert.match(captured[1], /ERROR error-message/);
  } finally {
    process.stderr.write = originalWrite;
    configureLogger(original);
  }
});

test('logger writes JSON records with merged fields, dropping undefined values', () => {
  const original = getLoggerConfig();
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    configureLogger({ level: 'debug', format: 'json' });
    logger.info('json-message', { a: 1, b: undefined });
    assert.equal(captured.length, 1);
    const record = JSON.parse(captured[0]);
    assert.equal(record.level, 'info');
    assert.equal(record.message, 'json-message');
    assert.equal(record.a, 1);
    assert.ok(!('b' in record));
    assert.equal(typeof record.time, 'string');
  } finally {
    process.stderr.write = originalWrite;
    configureLogger(original);
  }
});

test('logger renders non-primitive field values via JSON.stringify in text mode', () => {
  const original = getLoggerConfig();
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    configureLogger({ level: 'debug', format: 'text' });
    logger.debug('nested', { obj: { x: 1 } });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /obj=\{"x":1\}/);
  } finally {
    process.stderr.write = originalWrite;
    configureLogger(original);
  }
});

test('logger falls back to String(value) in text mode when JSON.stringify throws (circular ref)', () => {
  const original = getLoggerConfig();
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    configureLogger({ level: 'debug', format: 'text' });
    const circular = {};
    circular.self = circular;
    logger.debug('circular-field', { bad: circular });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /bad=\[object Object\]/);
  } finally {
    process.stderr.write = originalWrite;
    configureLogger(original);
  }
});

// ---------------------------------------------------------------------------
// audit.ts
// ---------------------------------------------------------------------------

test('sanitizeForAudit redacts sensitive keys, script length, and recurses arrays/objects', () => {
  const input = {
    password: 'p@ss',
    token: 'abc',
    Authorization: 'Bearer xyz',
    api_key: 'k1',
    apiKey: 'k2',
    secret: 's1',
    key: 'k3',
    script: 'var x = 1;',
    nested: { authorization: 'nested-secret', ok: 'fine' },
    list: [{ password: 'in-array' }, 'plain-string', 42],
    normal: 'value',
  };
  const out = sanitizeForAudit(input);
  assert.equal(out.password, '<redacted>');
  assert.equal(out.token, '<redacted>');
  assert.equal(out.Authorization, '<redacted>');
  assert.equal(out.api_key, '<redacted>');
  assert.equal(out.apiKey, '<redacted>');
  assert.equal(out.secret, '<redacted>');
  assert.equal(out.key, '<redacted>');
  assert.equal(out.script, '<script:10 chars>');
  assert.equal(out.nested.authorization, '<redacted>');
  assert.equal(out.nested.ok, 'fine');
  assert.equal(out.list[0].password, '<redacted>');
  assert.equal(out.list[1], 'plain-string');
  assert.equal(out.list[2], 42);
  assert.equal(out.normal, 'value');
});

test('sanitizeForAudit passes through primitives and null unchanged', () => {
  assert.equal(sanitizeForAudit('hello'), 'hello');
  assert.equal(sanitizeForAudit(42), 42);
  assert.equal(sanitizeForAudit(null), null);
  assert.equal(sanitizeForAudit(undefined), undefined);
  assert.equal(sanitizeForAudit(true), true);
});

test('writeAuditEvent creates dir/file and appends JSON lines', () => {
  const dir = mkTmpDir('syncrona-audit-');
  try {
    const nestedDir = path.join(dir, 'nested');
    const file = path.join(nestedDir, 'audit.log');
    writeAuditEvent(nestedDir, file, { event: 'first' });
    writeAuditEvent(nestedDir, file, { event: 'second' });
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).event, 'first');
    assert.equal(JSON.parse(lines[1]).event, 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAuditEvent rotates the file once maxBytes is exceeded and prunes old backups', () => {
  const dir = mkTmpDir('syncrona-audit-rotate-');
  try {
    const file = path.join(dir, 'audit.log');
    // Small maxBytes so the very first write already exceeds it on the next call.
    writeAuditEvent(dir, file, { event: 'seed', pad: 'x'.repeat(50) }, 10, 2);
    const sizeAfterFirst = fs.statSync(file).size;
    assert.ok(sizeAfterFirst >= 10);

    // Next write should trigger rotation because current file size >= maxBytes(10).
    writeAuditEvent(dir, file, { event: 'second' }, 10, 2);

    const entries = fs.readdirSync(dir);
    const rotated = entries.filter((n) => n !== 'audit.log');
    assert.ok(rotated.length >= 1, 'expected at least one rotated backup file');
    // Active file should exist and contain only the second event.
    const activeContent = fs.readFileSync(file, 'utf-8').trim();
    assert.equal(JSON.parse(activeContent).event, 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAuditEvent prunes rotated backups beyond maxBackups, keeping only the newest', () => {
  const dir = mkTmpDir('syncrona-audit-prune-');
  try {
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 4; i += 1) {
      writeAuditEvent(dir, file, { event: `e${i}` }, 1, 1);
    }
    const rotatedCount = fs.readdirSync(dir).filter((n) => n !== 'audit.log').length;
    assert.equal(rotatedCount, 1, 'expected pruning to keep only 1 rotated backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAuditEvent swallows errors when the path is unwritable (best-effort)', () => {
  // Point auditFile at a path whose parent is actually a file, not a directory,
  // so mkdirSync/appendFileSync fail internally; the function must not throw.
  const dir = mkTmpDir('syncrona-audit-badpath-');
  try {
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not-a-dir');
    const auditFile = path.join(blockerFile, 'audit.log');
    assert.doesNotThrow(() => {
      writeAuditEvent(blockerFile, auditFile, { event: 'x' });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAuditLogIntegrity creates auditDir when it does not yet exist', () => {
  const parent = mkTmpDir('syncrona-audit-mkdir-');
  try {
    const auditDir = path.join(parent, 'does', 'not', 'exist', 'yet');
    const auditFile = path.join(auditDir, 'audit.log');
    assert.equal(fs.existsSync(auditDir), false);
    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(fs.existsSync(auditDir), true);
    assert.equal(result.status, 'missing');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('checkAuditLogIntegrity reports "missing" status when file does not exist', () => {
  const dir = mkTmpDir('syncrona-audit-missing-');
  try {
    const file = path.join(dir, 'audit.log');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'missing');
    assert.equal(result.totalLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAuditLogIntegrity reports "valid" status for well-formed JSONL', () => {
  const dir = mkTmpDir('syncrona-audit-valid-');
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 2);
    assert.equal(result.malformedLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAuditLogIntegrity reports "error" status when the audit "file" is actually a directory', () => {
  const dir = mkTmpDir('syncrona-audit-errstatus-');
  try {
    // auditFile points at a directory, so existsSync(auditFile) is true but
    // readFileSync(auditFile) throws EISDIR, exercising the catch branch.
    const auditFileAsDir = path.join(dir, 'audit.log');
    fs.mkdirSync(auditFileAsDir);
    const result = checkAuditLogIntegrity(dir, auditFileAsDir);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.equal(result.totalLines, 0);
    assert.equal(result.malformedLines, 0);
    assert.equal(result.quarantinedFile, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAuditLogIntegrity quarantines a file with malformed lines and records recovery event', () => {
  const dir = mkTmpDir('syncrona-audit-corrupt-');
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, '{"a":1}\nnot-json\n{"b":2}\n');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'quarantined');
    assert.equal(result.totalLines, 3);
    assert.equal(result.malformedLines, 1);
    assert.ok(result.quarantinedFile.includes('.corrupt.'));
    assert.ok(fs.existsSync(result.quarantinedFile));

    // A fresh audit.log should have been created containing the recovery event.
    assert.ok(fs.existsSync(file));
    const recoveryRaw = fs.readFileSync(file, 'utf-8').trim();
    const recoveryEvent = JSON.parse(recoveryRaw);
    assert.equal(recoveryEvent.event, 'audit.integrity.recovered');
    assert.equal(recoveryEvent.malformedLines, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// metricsStore.ts
// ---------------------------------------------------------------------------

test('appendMetricEvent then loadMetricEvents roundtrips a single event', () => {
  const dir = mkTmpDir('syncrona-metrics-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const event = { tool: 'my_tool', ok: true, latencyMs: 42, timestamp: new Date().toISOString() };
    appendMetricEvent(dir, file, event);
    const loaded = loadMetricEvents(dir, file);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].tool, 'my_tool');
    assert.equal(loaded[0].ok, true);
    assert.equal(loaded[0].latencyMs, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMetricEvents returns [] when the metrics dir/file does not yet exist', () => {
  const dir = mkTmpDir('syncrona-metrics-empty-');
  try {
    const file = path.join(dir, 'sub', 'metrics.jsonl');
    const loaded = loadMetricEvents(dir, file);
    assert.deepEqual(loaded, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMetricEvents filters out malformed lines and lines missing required fields', () => {
  const dir = mkTmpDir('syncrona-metrics-malformed-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const lines = [
      JSON.stringify({ tool: 'a', ok: true, latencyMs: 5, timestamp: '2024-01-01T00:00:00Z' }),
      'not-json-at-all',
      JSON.stringify({ ok: true, latencyMs: 5, timestamp: '2024-01-01T00:00:00Z' }), // missing tool
      JSON.stringify({ tool: 'b', ok: false, timestamp: '2024-01-01T00:00:01Z' }), // missing latencyMs -> defaults 0
      JSON.stringify({ tool: 'c', ok: true, latencyMs: -5, timestamp: '2024-01-01T00:00:02Z', correlationId: '  ' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const loaded = loadMetricEvents(dir, file);
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0].tool, 'a');
    assert.equal(loaded[1].tool, 'b');
    assert.equal(loaded[1].latencyMs, 0);
    assert.equal(loaded[2].tool, 'c');
    assert.equal(loaded[2].latencyMs, 0); // Math.max(-5, 0)
    assert.ok(!('correlationId' in loaded[2])); // blank correlationId trimmed away
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMetricEvents respects maxItems, keeping only the most recent tail, clamped to [1, 5000]', () => {
  const dir = mkTmpDir('syncrona-metrics-limit-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const lines = [];
    for (let i = 0; i < 10; i += 1) {
      lines.push(
        JSON.stringify({ tool: `tool-${i}`, ok: true, latencyMs: i, timestamp: `2024-01-01T00:00:0${i}Z` })
      );
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const loaded = loadMetricEvents(dir, file, 3);
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0].tool, 'tool-7');
    assert.equal(loaded[2].tool, 'tool-9');

    // maxItems below 1 clamps to 1.
    const loadedMin = loadMetricEvents(dir, file, 0);
    assert.equal(loadedMin.length, 1);
    assert.equal(loadedMin[0].tool, 'tool-9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendMetricEvent rotates the file once maxBytes is exceeded and prunes old backups', () => {
  const dir = mkTmpDir('syncrona-metrics-rotate-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const event = (n) => ({ tool: `t${n}`, ok: true, latencyMs: n, timestamp: new Date().toISOString() });
    appendMetricEvent(dir, file, event(1), 10, 2);
    const sizeAfterFirst = fs.statSync(file).size;
    assert.ok(sizeAfterFirst >= 10);

    appendMetricEvent(dir, file, event(2), 10, 2);
    const entries = fs.readdirSync(dir);
    const rotated = entries.filter((n) => n !== 'metrics.jsonl');
    assert.ok(rotated.length >= 1, 'expected at least one rotated backup file');

    const activeContent = fs.readFileSync(file, 'utf-8').trim();
    assert.equal(JSON.parse(activeContent).tool, 't2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendMetricEvent prunes rotated backups beyond maxBackups, keeping only the newest', () => {
  const dir = mkTmpDir('syncrona-metrics-prune-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const event = (n) => ({ tool: `t${n}`, ok: true, latencyMs: n, timestamp: new Date().toISOString() });
    // Force a rotation on every single append (maxBytes=1) with maxBackups=1, so
    // multiple rotated files accumulate and the prune loop deletes all but the
    // single newest one.
    for (let i = 0; i < 4; i += 1) {
      appendMetricEvent(dir, file, event(i), 1, 1);
    }
    const rotatedCount = fs.readdirSync(dir).filter((n) => n !== 'metrics.jsonl').length;
    assert.equal(rotatedCount, 1, 'expected pruning to keep only 1 rotated backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendMetricEvent swallows errors when the path is unwritable (best-effort)', () => {
  const dir = mkTmpDir('syncrona-metrics-badpath-');
  try {
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not-a-dir');
    const metricsFile = path.join(blockerFile, 'metrics.jsonl');
    assert.doesNotThrow(() => {
      appendMetricEvent(blockerFile, metricsFile, {
        tool: 't',
        ok: true,
        latencyMs: 1,
        timestamp: new Date().toISOString(),
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMetricEvents returns [] and swallows errors on unreadable path', () => {
  const dir = mkTmpDir('syncrona-metrics-readbad-');
  try {
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not-a-dir');
    const metricsFile = path.join(blockerFile, 'metrics.jsonl');
    const loaded = loadMetricEvents(blockerFile, metricsFile);
    assert.deepEqual(loaded, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gracefulShutdown.ts
// ---------------------------------------------------------------------------

test('closeResource is a no-op for undefined resource or resource without close()', async () => {
  await assert.doesNotReject(closeResource(undefined));
  await assert.doesNotReject(closeResource({}));
});

test('closeResource awaits an async close() function', async () => {
  let closed = false;
  await closeResource({
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      closed = true;
    },
  });
  assert.equal(closed, true);
});

test('closeResource swallows a throwing close() (best-effort)', async () => {
  await assert.doesNotReject(
    closeResource({
      close: () => {
        throw new Error('boom');
      },
    })
  );
});

test('createGracefulShutdownController: beginRequest/endRequest track active count and block once shutting down', async () => {
  const dir = mkTmpDir('syncrona-shutdown-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    let exitCode = null;
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 1000,
      pollIntervalMs: 10,
      waitFn: async () => {},
      exitFn: (code) => {
        exitCode = code;
      },
      logger: () => {},
    });

    assert.equal(controller.isShuttingDown(), false);
    assert.equal(controller.beginRequest(), true);
    assert.equal(controller.beginRequest(), true);
    controller.endRequest();

    await controller.shutdown('SIGTERM');

    assert.equal(controller.isShuttingDown(), true);
    // Once shutting down, new requests must be rejected.
    assert.equal(controller.beginRequest(), false);
    assert.equal(exitCode, 0);

    const auditContent = fs.readFileSync(auditFile, 'utf-8');
    assert.match(auditContent, /shutdown\.requested/);
    assert.match(auditContent, /shutdown\.drained/);
    assert.match(auditContent, /shutdown\.completed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createGracefulShutdownController: shutdown is idempotent (concurrent calls share one promise)', async () => {
  const dir = mkTmpDir('syncrona-shutdown-idem-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    let exitCalls = 0;
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 500,
      pollIntervalMs: 10,
      waitFn: async () => {},
      exitFn: () => {
        exitCalls += 1;
      },
      logger: () => {},
    });

    const [p1, p2] = [controller.shutdown('SIGINT'), controller.shutdown('SIGINT')];
    await Promise.all([p1, p2]);
    assert.equal(exitCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createGracefulShutdownController: exitProcess=false skips exitFn, and transport/server resources are closed', async () => {
  const dir = mkTmpDir('syncrona-shutdown-noexit-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    let exitCalled = false;
    let transportClosed = false;
    let serverClosed = false;
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 500,
      pollIntervalMs: 10,
      waitFn: async () => {},
      exitFn: () => {
        exitCalled = true;
      },
      exitProcess: false,
      logger: () => {},
      serverResource: {
        close: () => {
          serverClosed = true;
        },
      },
    });
    controller.setTransportResource({
      close: () => {
        transportClosed = true;
      },
    });

    await controller.shutdown('SIGHUP');
    assert.equal(exitCalled, false);
    assert.equal(transportClosed, true);
    assert.equal(serverClosed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createGracefulShutdownController: drains before timing out when activeRequests reaches zero', async () => {
  const dir = mkTmpDir('syncrona-shutdown-drain-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 2000,
      pollIntervalMs: 5,
      waitFn: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      exitFn: () => {},
      exitProcess: false,
      logger: () => {},
    });

    controller.beginRequest();
    setTimeout(() => controller.endRequest(), 20);

    await controller.shutdown('SIGTERM');

    const auditContent = fs.readFileSync(auditFile, 'utf-8');
    const drainedLine = auditContent
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .find((e) => e.event === 'shutdown.drained');
    assert.ok(drainedLine);
    assert.equal(drainedLine.drained, true);
    assert.equal(drainedLine.pendingRequests, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 10000 });

test('createGracefulShutdownController: uses the built-in setTimeout-based sleep when waitFn is omitted', async () => {
  const dir = mkTmpDir('syncrona-shutdown-realwait-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    const controller = createGracefulShutdownController({
      auditDir: dir,
      auditFile,
      drainTimeoutMs: 1000,
      pollIntervalMs: 10,
      exitFn: () => {},
      exitProcess: false,
      logger: () => {},
    });
    controller.beginRequest();
    setTimeout(() => controller.endRequest(), 15);
    await controller.shutdown('SIGTERM');
    assert.equal(controller.isShuttingDown(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 10000 });

test('createGracefulShutdownController: uses default logger/exitFn/audit paths when omitted (no throw)', async () => {
  // Exercise the branches where options.logger, options.exitFn, options.auditDir,
  // options.auditFile are NOT provided, without ever calling the real process.exit.
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
  };
  const originalErrorLog = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    const controller = createGracefulShutdownController({
      drainTimeoutMs: 200,
      pollIntervalMs: 10,
      waitFn: async () => {},
    });
    await controller.shutdown('SIGTERM');
    assert.equal(exitCode, 0);
    assert.ok(errors.some((m) => /shutdown requested/.test(m)));
  } finally {
    process.exit = originalExit;
    console.error = originalErrorLog;
  }
});
