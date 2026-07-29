// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression coverage for the audit hardening wave REV-142..REV-147 and REV-190.
// Every test here reproduces a defect that the pre-fix `packages/mcp-server/src/audit.ts`
// exhibits:
//   REV-142 wholesale erasure of the log (deleted, or replaced with unchained "legacy"
//           JSON) was reported `valid`/`missing` because the out-of-band high-water marker
//           was never consulted on those paths.
//   REV-143 the high-water marker lived under os.tmpdir() — world-writable /tmp on Linux —
//           at a fully deterministic path, so it could be clobbered through a planted
//           symlink or simply reset to disable the truncation tripwire.
//   REV-144 checkAuditLogIntegrity read, rewrote and renamed the audit file with no symlink
//           guard, so a planted `audit.log -> victim` destroyed the victim at startup.
//   REV-145 looksLikeSecretValue returned false (fail-OPEN) for values over 8 KB, so a
//           padded secret was written to the audit log in cleartext.
//   REV-146 the chain append was an unsynchronised read-modify-write, so two processes
//           emitted the same seq and the log read as `tampered` forever.
//   REV-147 the inline-Authorization pattern matched ordinary prose ("Basic authentication
//           failed"), and a match replaces the WHOLE value with "<redacted>".
//   REV-190 the bare `user:pass@host` pattern accepted any host token, so a package spec
//           ("npm:lodash@4.17.21 installed") was erased the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Keep the chain key deterministic and off the OS keychain for the whole file.
process.env.SYNCRONA_STORE_KEY = 'rev142-regression-key';

const AUDIT_MODULE = require.resolve('../dist/audit.js');
const {
  writeAuditEvent,
  checkAuditLogIntegrity,
  sanitizeForAudit,
  __resetAuditChainKeyForTests,
} = require(AUDIT_MODULE);

__resetAuditChainKeyForTests();

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Each test gets its own audit dir AND its own out-of-band state dir, so the high-water
// marker never touches the developer's real ~/.syncrona.
function withAuditWorkspace(prefix, fn) {
  const root = mkTmpDir(prefix);
  const auditDir = path.join(root, '.syncrona-mcp');
  const auditFile = path.join(auditDir, 'audit.log');
  const stateDir = path.join(root, 'state');
  const previous = process.env.SYNCRONA_AUDIT_STATE_DIR;
  process.env.SYNCRONA_AUDIT_STATE_DIR = stateDir;
  try {
    fn({ root, auditDir, auditFile, stateDir });
  } finally {
    if (previous === undefined) {
      delete process.env.SYNCRONA_AUDIT_STATE_DIR;
    } else {
      process.env.SYNCRONA_AUDIT_STATE_DIR = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function buildChain(auditDir, auditFile, count) {
  for (let i = 0; i < count; i += 1) {
    const res = writeAuditEvent(auditDir, auditFile, {
      timestamp: new Date().toISOString(),
      tool: 'sync_push',
      mutating: true,
      idx: i,
    });
    assert.equal(res.ok, true);
  }
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function markerPath(stateDir, auditFile) {
  const id = crypto.createHash('sha256').update(path.resolve(auditFile)).digest('hex').slice(0, 40);
  return path.join(stateDir, `${id}.json`);
}

// --- SEC-5 follow-up (REV-142): erasure must not read as a healthy log ----------------

test('REV-142 flags a chained log replaced with legacy-shaped JSON as tampered', () => {
  withAuditWorkspace('syncrona-rev142-legacy-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 4);
    // The cheapest attack: overwrite the whole log with a line that carries no seq/prevHash,
    // which the pre-fix walk classified as "fully-legacy log: nothing to verify".
    fs.writeFileSync(auditFile, '{"event":"nothing happened"}\n', 'utf-8');

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
    assert.match(String(result.reason), /high-water/);
  });
});

test('REV-142 flags a chained record replaced with an unchained one as tampered', () => {
  withAuditWorkspace('syncrona-rev142-prefix-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 3);
    const lines = readLines(auditFile);
    // Drop the first chained record and replace it with an unchained one: the chain now
    // starts at seq 2 behind a tolerated "legacy" prefix.
    lines[0] = '{"event":"forged"}';
    fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
  });
});

// --- SEC-5 follow-up (REV-191): the tolerated legacy prefix must be bounded -----------

test('REV-191 flags a forged unchained record prepended to an intact chain', () => {
  withAuditWorkspace('syncrona-rev191-prepend-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 3);
    // The whole chain stays byte-identical; the forged line simply lands in front of it,
    // where the walk tolerates "legacy" records.
    const chain = fs.readFileSync(auditFile, 'utf-8');
    fs.writeFileSync(auditFile, `{"event":"forged approval","by":"admin"}\n${chain}`, 'utf-8');

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
    assert.match(String(result.reason), /legacy prefix/);
  });
});

test('REV-191 accepts a real legacy log that later gained a chain, across further writes', () => {
  withAuditWorkspace('syncrona-rev191-upgrade-', ({ auditDir, auditFile }) => {
    // Pre-REV-86 history: two unchained records already on disk before any chained write.
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(auditFile, '{"event":"old1"}\n{"event":"old2"}\n', 'utf-8');
    buildChain(auditDir, auditFile, 2);

    let result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, true, `unexpected: ${JSON.stringify(result)}`);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 4);

    // The recorded prefix must survive later appends.
    buildChain(auditDir, auditFile, 2);
    result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, true, `unexpected: ${JSON.stringify(result)}`);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 6);
  });
});

test('REV-191 flags deletion of a legacy line that preceded the chain', () => {
  withAuditWorkspace('syncrona-rev191-delete-', ({ auditDir, auditFile }) => {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(auditFile, '{"event":"old1"}\n{"event":"old2"}\n', 'utf-8');
    buildChain(auditDir, auditFile, 2);

    const lines = readLines(auditFile).slice(1);
    fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
    assert.match(String(result.reason), /legacy prefix/);
  });
});

test('REV-142 flags a deleted audit log as tampered instead of reporting it missing', () => {
  withAuditWorkspace('syncrona-rev142-deleted-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 5);
    fs.unlinkSync(auditFile);

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
    assert.match(String(result.reason), /deleted below high-water/);
  });
});

test('REV-142 keeps the erasure evidence: the next write does not restart at seq 1', () => {
  withAuditWorkspace('syncrona-rev142-nogoback-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 5);
    fs.unlinkSync(auditFile);

    assert.equal(writeAuditEvent(auditDir, auditFile, { event: 'after.erase' }).ok, true);
    const lines = readLines(auditFile);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).seq, 6);

    // ...and the gap is still reported after the log has been written to again.
    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tampered');
  });
});

test('REV-142 still accepts a genuinely legacy log that has no high-water marker', () => {
  withAuditWorkspace('syncrona-rev142-compat-', ({ auditDir, auditFile }) => {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(auditFile, '{"event":"pre-chain"}\n{"event":"pre-chain2"}\n', 'utf-8');

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'valid');
    assert.equal(result.totalLines, 2);
  });
});

test('REV-142 rotation is a legitimate fresh start and stays valid', () => {
  withAuditWorkspace('syncrona-rev142-rotate-', ({ auditDir, auditFile }) => {
    for (let i = 0; i < 6; i += 1) {
      assert.equal(
        writeAuditEvent(auditDir, auditFile, { event: 'rot', idx: i, pad: 'x'.repeat(64) }, 200, 3)
          .ok,
        true
      );
    }
    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, true, `unexpected: ${JSON.stringify(result)}`);
    assert.equal(result.status, 'valid');
    assert.equal(JSON.parse(readLines(auditFile)[0]).seq, 1);
  });
});

test('REV-142 quarantine is a legitimate fresh start and stays valid afterwards', () => {
  withAuditWorkspace('syncrona-rev142-quarantine-', ({ auditDir, auditFile }) => {
    buildChain(auditDir, auditFile, 3);
    const lines = readLines(auditFile);
    lines.splice(1, 0, 'this is not json');
    fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

    const quarantined = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(quarantined.status, 'quarantined');

    // The replacement log must not inherit the old marker, or it would read as tampered
    // forever.
    const after = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(after.ok, true, `unexpected: ${JSON.stringify(after)}`);
    assert.equal(after.status, 'valid');
  });
});

// --- SEC-5 follow-up (REV-143): marker location and symlink refusal -------------------

test('REV-143 keeps the high-water marker in a per-user state dir, not os.tmpdir()', () => {
  const root = mkTmpDir('syncrona-rev143-xdg-');
  const auditDir = path.join(root, '.syncrona-mcp');
  const auditFile = path.join(auditDir, 'audit.log');
  const xdgRoot = path.join(root, 'xdg-state');
  const prevState = process.env.SYNCRONA_AUDIT_STATE_DIR;
  const prevXdg = process.env.XDG_STATE_HOME;
  delete process.env.SYNCRONA_AUDIT_STATE_DIR;
  process.env.XDG_STATE_HOME = xdgRoot;
  try {
    assert.equal(writeAuditEvent(auditDir, auditFile, { event: 'x' }).ok, true);

    const stateDir = path.join(xdgRoot, 'syncrona', 'audit-integrity');
    const marker = markerPath(stateDir, auditFile);
    assert.equal(fs.existsSync(marker), true, 'high-water marker not written to the state dir');
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf-8')).seq, 1);
    // The state dir must not be readable by other local users.
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  } finally {
    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }
    if (prevState !== undefined) {
      process.env.SYNCRONA_AUDIT_STATE_DIR = prevState;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REV-143 refuses to write the high-water marker through a planted symlink', () => {
  withAuditWorkspace('syncrona-rev143-symlink-', ({ root, auditDir, auditFile, stateDir }) => {
    const victim = path.join(root, 'authorized_keys');
    fs.writeFileSync(victim, 'ssh-ed25519 AAAA victim\n', 'utf-8');

    // Plant the link both at the current marker path and at the pre-fix os.tmpdir() path,
    // so the test reproduces the original clobber as well as guarding the new location.
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(victim, markerPath(stateDir, auditFile));
    const legacyDir = path.join(os.tmpdir(), 'syncrona-audit-integrity');
    const legacyMarker = markerPath(legacyDir, auditFile);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.rmSync(legacyMarker, { force: true });
    fs.symlinkSync(victim, legacyMarker);

    try {
      // The audit record itself must still be written — a marker failure is never fatal.
      assert.equal(writeAuditEvent(auditDir, auditFile, { event: 'x' }).ok, true);
      assert.equal(readLines(auditFile).length, 1);
      assert.equal(fs.readFileSync(victim, 'utf-8'), 'ssh-ed25519 AAAA victim\n');
    } finally {
      fs.rmSync(legacyMarker, { force: true });
    }
  });
});

// --- SEC-6 follow-up (REV-144): the integrity check must not follow symlinks -----------

test('REV-144 refuses a symlinked audit file instead of rewriting the victim', () => {
  withAuditWorkspace('syncrona-rev144-file-', ({ root, auditDir, auditFile }) => {
    const victim = path.join(root, 'victim.txt');
    const victimContent = '{"a":1}\nIMPORTANT-USER-DATA';
    fs.writeFileSync(victim, victimContent, 'utf-8');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.symlinkSync(victim, auditFile);

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'audit path is a symlink');
    // The torn-tail branch used to truncate the victim to its first line.
    assert.equal(fs.readFileSync(victim, 'utf-8'), victimContent);
    assert.equal(fs.lstatSync(auditFile).isSymbolicLink(), true);
  });
});

test('REV-144 refuses a symlinked audit directory', () => {
  withAuditWorkspace('syncrona-rev144-dir-', ({ root, auditDir, auditFile }) => {
    const real = path.join(root, 'attacker');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'audit.log'), '{"a":1}\nTORN', 'utf-8');
    fs.symlinkSync(real, auditDir);

    const result = checkAuditLogIntegrity(auditDir, auditFile);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'audit path is a symlink');
    assert.equal(fs.readFileSync(path.join(real, 'audit.log'), 'utf-8'), '{"a":1}\nTORN');
  });
});

// --- SEC-8 follow-up (REV-145): the scan budget must fail CLOSED ----------------------

test('REV-145 redacts an oversized value instead of trusting it', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  const padded = `${'x'.repeat(9000)} ${pem}`;
  assert.equal(sanitizeForAudit({ body: padded }).body, '<redacted>');
  assert.equal(sanitizeForAudit(padded), '<redacted>');
  assert.equal(sanitizeForAudit({ payload: 'y'.repeat(8193) }).payload, '<redacted>');
});

test('REV-145 leaves an ordinary value at the scan budget verbatim', () => {
  const atBudget = 'x'.repeat(8192);
  assert.equal(sanitizeForAudit({ body: atBudget }).body, atBudget);
});

// --- CONC-8 (REV-146): concurrent writers must not duplicate a seq --------------------

const CHILD_WRITER = `
const path = require('path');
const [auditModule, auditDir, auditFile, countRaw, tag] = process.argv.slice(1);
const { writeAuditEvent } = require(auditModule);
const count = Number(countRaw);
for (let i = 0; i < count; i += 1) {
  const res = writeAuditEvent(auditDir, auditFile, { event: 'conc', tag, idx: i });
  if (!res.ok) {
    console.error('write failed: ' + res.error);
    process.exit(2);
  }
}
`;

test('REV-146 concurrent writers keep the chain intact', async () => {
  const root = mkTmpDir('syncrona-rev146-conc-');
  const auditDir = path.join(root, '.syncrona-mcp');
  const auditFile = path.join(auditDir, 'audit.log');
  const stateDir = path.join(root, 'state');
  const perChild = 120;
  const children = 3;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const env = {
      ...process.env,
      SYNCRONA_AUDIT_STATE_DIR: stateDir,
      SYNCRONA_STORE_KEY: 'rev142-regression-key',
    };
    const runs = [];
    for (let c = 0; c < children; c += 1) {
      runs.push(
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['-e', CHILD_WRITER, AUDIT_MODULE, auditDir, auditFile, String(perChild), `w${c}`],
            { env, stdio: ['ignore', 'ignore', 'inherit'] }
          );
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`child exited ${code}`))
          );
        })
      );
    }
    await Promise.all(runs);

    process.env.SYNCRONA_AUDIT_STATE_DIR = stateDir;
    try {
      const total = children * perChild;
      assert.equal(readLines(auditFile).length, total, 'a record was dropped');
      const result = checkAuditLogIntegrity(auditDir, auditFile);
      assert.equal(result.ok, true, `unexpected: ${JSON.stringify(result)}`);
      assert.equal(result.status, 'valid');
      assert.equal(result.totalLines, total);
    } finally {
      delete process.env.SYNCRONA_AUDIT_STATE_DIR;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- SEC-8 follow-up (REV-147 / REV-190): no whole-value redaction of prose -----------

test('REV-147 keeps ordinary auth-failure prose in the audit trail', () => {
  const benign = [
    'Basic authentication failed for the target instance',
    'basic configuration is incomplete',
    'Bearer credentials rejected',
    'switch to basic auth before retrying',
  ];
  for (const value of benign) {
    assert.equal(sanitizeForAudit(value), value, `over-redacted: ${value}`);
    assert.equal(sanitizeForAudit({ error: value }).error, value, `over-redacted: ${value}`);
  }
});

test('REV-190 keeps package specs and record references in the audit trail', () => {
  const benign = [
    'npm:lodash@4.17.21 installed',
    'update on incident:INC0010001@dev12345 failed',
    'sys_script_include:AbcUtil@dev408269 skipped',
  ];
  for (const value of benign) {
    assert.equal(sanitizeForAudit(value), value, `over-redacted: ${value}`);
  }
});

test('REV-147/REV-190 still redact real credential material', () => {
  const secrets = [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef',
    'basic YWRtaW46cGFzc3dvcmQ=',
    'Bearer AbCd1234EfGh5678Ijkl',
    'https://admin:hunter2@dev12345.service-now.com/api',
    'admin:hunter2@db.internal.example.com refused',
    'proxy user:pw@localhost rejected',
    'svc:s3cret@10.0.0.5 rejected',
  ];
  for (const value of secrets) {
    assert.equal(sanitizeForAudit(value), '<redacted>', `not redacted: ${value}`);
  }
});
