// SPDX-License-Identifier: GPL-3.0-or-later
//
// SEC-5 (REV-86): the audit log is a tamper-evident hash chain (seq + prevHash). An
// interior edit, a removed interior line, or a truncation below the persisted high-water
// must be reported as `tampered`. CONC-3 (REV-94): a single torn TRAILING line is a crash
// artifact and must be recovered (dropped) instead of quarantining the whole history;
// interior corruption still quarantines, and `.corrupt.` files are capped.
//
// The tamper tests build a REAL chain through writeAuditEvent (which also persists the
// high-water tripwire), then manipulate the file on disk. They fail on the pre-REV-86/94
// behavior (any well-formed-JSON edit read as `valid`; any torn tail quarantined).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditEvent, checkAuditLogIntegrity } = require('../dist/audit.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Build a real chained audit log; returns the ordered line strings actually on disk.
function buildChain(dir, file, count) {
  for (let i = 0; i < count; i += 1) {
    const res = writeAuditEvent(dir, file, { event: 'evt', idx: i, marker: 'orig' });
    assert.equal(res.ok, true);
  }
  return readLines(file);
}

// --- SEC-5 (REV-86) -------------------------------------------------------------

test('REV-86 flags a tampered log when an interior line is edited (hash-chain break)', () => {
  const dir = mkTmpDir('syncrona-audit-tamper-edit-');
  try {
    const file = path.join(dir, 'audit.log');
    const lines = buildChain(dir, file, 3);
    // Edit the middle line but keep it valid JSON (and keep its own seq/prevHash).
    const parsed = JSON.parse(lines[1]);
    parsed.marker = 'tampered';
    lines[1] = JSON.stringify(parsed);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'tampered');
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-86 flags a tampered log when an interior line is removed (sequence gap)', () => {
  const dir = mkTmpDir('syncrona-audit-tamper-del-');
  try {
    const file = path.join(dir, 'audit.log');
    const lines = buildChain(dir, file, 3);
    const kept = [lines[0], lines[2]]; // drop the middle line
    fs.writeFileSync(file, `${kept.join('\n')}\n`);

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'tampered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-86 flags a tampered log when the trailing line is fully removed (truncation below high-water)', () => {
  const dir = mkTmpDir('syncrona-audit-tamper-trunc-');
  try {
    const file = path.join(dir, 'audit.log');
    const lines = buildChain(dir, file, 3); // high-water now records seq 3
    const kept = lines.slice(0, 2); // remove a COMPLETE trailing line (still valid JSON)
    fs.writeFileSync(file, `${kept.join('\n')}\n`);

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'tampered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-86 a fully-legacy log (no seq/prevHash) is still valid (backward compatibility)', () => {
  const dir = mkTmpDir('syncrona-audit-legacy-');
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-86 an intact chain built by writeAuditEvent validates as valid', () => {
  const dir = mkTmpDir('syncrona-audit-intact-');
  try {
    const file = path.join(dir, 'audit.log');
    buildChain(dir, file, 4);
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-86 tamper detection also works in HMAC mode (SYNCRONA_STORE_KEY set)', () => {
  const dir = mkTmpDir('syncrona-audit-hmac-');
  const prev = process.env.SYNCRONA_STORE_KEY;
  process.env.SYNCRONA_STORE_KEY = 'unit-test-install-secret';
  try {
    const file = path.join(dir, 'audit.log');
    const lines = buildChain(dir, file, 3);
    const parsed = JSON.parse(lines[1]);
    parsed.marker = 'tampered';
    lines[1] = JSON.stringify(parsed);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'tampered');
  } finally {
    if (prev === undefined) {
      delete process.env.SYNCRONA_STORE_KEY;
    } else {
      process.env.SYNCRONA_STORE_KEY = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CONC-3 (REV-94) ------------------------------------------------------------

test('REV-94 recovers a torn trailing line and keeps the valid history', () => {
  const dir = mkTmpDir('syncrona-audit-torntail-');
  try {
    const file = path.join(dir, 'audit.log');
    buildChain(dir, file, 2);
    // Simulate a crash mid-append: a partial, unterminated JSON line at the very end.
    fs.appendFileSync(file, '{"event":"partial",');

    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'recovered');
    assert.equal(result.ok, true);
    assert.equal(result.malformedLines, 1);
    assert.equal(result.totalLines, 2);

    // History preserved, torn line gone, and NOT quarantined.
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).idx, 0);
    assert.equal(JSON.parse(lines[1]).idx, 1);
    const corrupt = fs.readdirSync(dir).filter((n) => n.includes('.corrupt.'));
    assert.equal(corrupt.length, 0, 'a torn tail must not be quarantined');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-94 a newline-terminated malformed final line is corruption, not a torn tail (quarantines)', () => {
  const dir = mkTmpDir('syncrona-audit-termtail-');
  try {
    const file = path.join(dir, 'audit.log');
    // The final malformed line is COMPLETE (ends with a newline): a genuinely torn write
    // would have lost its terminator. This must quarantine, not recover.
    fs.writeFileSync(file, '{"event":"good"}\nnot-json\n');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'quarantined');
    assert.ok(result.quarantinedFile.includes('.corrupt.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-94 still quarantines interior corruption (malformed line is not the tail)', () => {
  const dir = mkTmpDir('syncrona-audit-interior-');
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, '{"a":1}\nGARBAGE-NOT-JSON\n{"b":2}\n');
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'quarantined');
    assert.equal(result.malformedLines, 1);
    assert.ok(result.quarantinedFile.includes('.corrupt.'));
    assert.equal(fs.existsSync(result.quarantinedFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-94 caps the number of retained .corrupt. quarantine files', () => {
  const dir = mkTmpDir('syncrona-audit-corruptcap-');
  try {
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 5; i += 1) {
      // Interior corruption forces a quarantine each round.
      fs.writeFileSync(file, '{"a":1}\nBROKEN\n{"b":2}\n');
      const result = checkAuditLogIntegrity(dir, file, 2);
      assert.equal(result.status, 'quarantined');
    }
    const corruptCount = fs.readdirSync(dir).filter((n) => n.includes('.corrupt.')).length;
    assert.ok(corruptCount <= 2, `expected <= 2 retained corrupt files, got ${corruptCount}`);
    assert.ok(corruptCount >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
