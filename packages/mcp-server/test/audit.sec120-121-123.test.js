// SPDX-License-Identifier: GPL-3.0-or-later
//
// SEC-5 follow-up (REV-120): on a default install (no SYNCRONA_STORE_KEY) the audit
// chain must be keyed from the credential store's per-install secret instead of falling
// back to a plain, publicly recomputable SHA-256 chain.
// SEC-6 follow-up (REV-121): a symlinked audit DIRECTORY (not just a symlinked audit
// file) must be refused, never followed.
// SEC-8 follow-up (REV-123): a BARE secret-shaped string passed to sanitizeForAudit
// (e.g. a raw error message) must be redacted, embedded JWTs must be caught, and the
// sensitive-key list must cover cookie/session/passphrase/otp-style keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeAuditEvent,
  checkAuditLogIntegrity,
  sanitizeForAudit,
  __resetAuditChainKeyForTests,
} = require('../dist/audit.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- SEC-8 (REV-123) --------------------------------------------------------------

test('REV-123 sanitizeForAudit redacts a BARE secret-shaped string (not wrapped in an object)', () => {
  assert.equal(sanitizeForAudit('postgres://user:secretpw@db.host/app'), '<redacted>');
  assert.equal(sanitizeForAudit('bearer AbCdEf123456789'), '<redacted>');
  // A JWT embedded in surrounding text (e.g. inside an error message) must be caught too.
  assert.equal(
    sanitizeForAudit('login failed token=eyJhbGci.eyJzdWIx.SsIg rest'),
    '<redacted>'
  );
});

test('REV-123 sanitizeForAudit keeps a benign bare string verbatim', () => {
  assert.equal(sanitizeForAudit('all systems ok'), 'all systems ok');
});

test('REV-123 sanitizeForAudit redacts cookie/session/passphrase/otp keys but keeps benign keys', () => {
  const out = sanitizeForAudit({
    cookie: 'x',
    sessionId: 'x',
    passphrase: 'x',
    otp: '123456',
    ok: 'keep',
  });
  assert.equal(out.cookie, '<redacted>');
  assert.equal(out.sessionId, '<redacted>');
  assert.equal(out.passphrase, '<redacted>');
  assert.equal(out.otp, '<redacted>');
  assert.equal(out.ok, 'keep');
});

// --- SEC-5 (REV-120) --------------------------------------------------------------

test('REV-120 without SYNCRONA_STORE_KEY the chain is keyed from the credential store and still verifies intact', () => {
  const dir = mkTmpDir('syncrona-audit-rev120-');
  const prev = process.env.SYNCRONA_STORE_KEY;
  delete process.env.SYNCRONA_STORE_KEY;
  __resetAuditChainKeyForTests();
  try {
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 3; i += 1) {
      const res = writeAuditEvent(dir, file, { event: 'evt', idx: i });
      assert.equal(res.ok, true);
    }

    // A written+read-back chain verifies as intact with the store-derived key.
    const result = checkAuditLogIntegrity(dir, file);
    assert.equal(result.status, 'valid');
    assert.equal(result.ok, true);
    assert.equal(result.totalLines, 3);

    // And tamper detection still works in this (env-keyless) mode: an interior edit breaks
    // the chain, proving the hash links were actually computed and checked.
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const parsed = JSON.parse(lines[1]);
    parsed.idx = 999;
    lines[1] = JSON.stringify(parsed);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const tampered = checkAuditLogIntegrity(dir, file);
    assert.equal(tampered.status, 'tampered');
  } finally {
    if (prev === undefined) {
      delete process.env.SYNCRONA_STORE_KEY;
    } else {
      process.env.SYNCRONA_STORE_KEY = prev;
    }
    // Drop the memoized key so later tests are not pinned to this test's key mode.
    __resetAuditChainKeyForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- SEC-6 (REV-121) --------------------------------------------------------------

test('REV-121 writeAuditEvent refuses to write through a SYMLINKED audit directory', () => {
  const base = mkTmpDir('syncrona-audit-rev121-');
  try {
    const realTarget = path.join(base, 'attacker-dir');
    fs.mkdirSync(realTarget);
    const linkedDir = path.join(base, '.syncrona-mcp');
    try {
      fs.symlinkSync(realTarget, linkedDir);
    } catch (_) {
      // Platform without symlink support: skip without failing the suite.
      return;
    }
    const auditFile = path.join(linkedDir, 'audit.log');

    // Mirror the REV-87 contract: the internal refusal throw is caught and surfaced as a
    // failed AuditWriteResult (fail-closed for mutating records).
    const result = writeAuditEvent(linkedDir, auditFile, { tool: 'sync_push', mutating: true });

    assert.equal(result.ok, false, 'a symlinked audit directory must be refused');
    assert.equal(result.mutating, true);
    assert.equal(typeof result.error, 'string');
    assert.ok(
      result.error.includes('symlinked directory'),
      `expected a symlinked-directory refusal, got: ${result.error}`
    );
    // Nothing must be written into the symlink's target directory.
    assert.equal(fs.readdirSync(realTarget).length, 0, 'attacker dir must stay untouched');
    // The path itself is still a symlink (was not replaced by a real directory).
    assert.equal(fs.lstatSync(linkedDir).isSymbolicLink(), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
