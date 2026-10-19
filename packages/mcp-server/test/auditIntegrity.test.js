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

const {
  writeAuditEvent,
  checkAuditLogIntegrity,
  toCorruptAuditPath,
  toRotatedAuditPath,
} = require('../dist/audit.js');

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

// CONC-3 follow-up (REV-205): the quarantine name carries a millisecond timestamp, so two
// quarantines of the same file inside one millisecond collide. `toCorruptAuditPath` resolves
// that with a numeric suffix, and the test above was its only — accidental — coverage: five
// quarantines in a tight loop collide on an idle machine and do not under load, which is why
// `dist/audit.js` reported 96.57 / 92.12 on some runs of an unchanged tree and 96.25 / 91.70
// on others. A frozen clock turns that race into an assertion.
test('REV-205 toCorruptAuditPath: a same-millisecond collision suffixes instead of clobbering', () => {
  const dir = mkTmpDir('syncrona-audit-collision-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    // One instant, reused for every call — exactly the crash-loop case the arm exists for.
    const frozen = new Date('2026-08-07T12:34:56.789Z');
    const stamp = '2026-08-07T12-34-56-789Z';

    const first = toCorruptAuditPath(auditFile, frozen);
    assert.equal(path.basename(first), `audit.corrupt.${stamp}.log`);
    fs.writeFileSync(first, 'first-quarantine', 'utf-8');

    const second = toCorruptAuditPath(auditFile, frozen);
    assert.equal(path.basename(second), `audit.corrupt.${stamp}.1.log`);
    fs.writeFileSync(second, 'second-quarantine', 'utf-8');

    // The loop must keep counting, not stop at one collision.
    const third = toCorruptAuditPath(auditFile, frozen);
    assert.equal(path.basename(third), `audit.corrupt.${stamp}.2.log`);

    // The whole point: a quarantine is tamper evidence. Neither earlier file may be
    // clobbered by the path the caller is about to renameSync onto.
    assert.equal(fs.readFileSync(first, 'utf-8'), 'first-quarantine');
    assert.equal(fs.readFileSync(second, 'utf-8'), 'second-quarantine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-205 toCorruptAuditPath: defaults to the wall clock when no instant is supplied', () => {
  const dir = mkTmpDir('syncrona-audit-collision-default-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    const before = Date.now();
    const candidate = toCorruptAuditPath(auditFile);
    const after = Date.now();

    // Production calls the one-argument form; this pins that the default arm still stamps
    // the real time, so the frozen-clock test above cannot drift away from the caller.
    const match = /^audit\.corrupt\.(.+)\.log$/.exec(path.basename(candidate));
    assert.ok(match, `unexpected quarantine name: ${path.basename(candidate)}`);
    const stampedAt = Date.parse(match[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z'));
    assert.ok(
      stampedAt >= before && stampedAt <= after,
      `stamp ${match[1]} outside [${before}, ${after}]`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the same shape. Size rotation retires a log under a millisecond stamp
// too, so a burst of writes that crosses `maxBytes` more than once in the same millisecond
// collides exactly as quarantine does — and the collision arm was never covered at all
// there, because no test rotates twice that fast. `toRotatedAuditPath` shares one
// implementation with `toCorruptAuditPath` now, but sharing code is not sharing a test:
// the two differ in the infix, and the infix is what `pruneRotatedAuditFiles` and
// `pruneCorruptAuditFiles` use to tell a rotated log from a quarantined one.
test('REV-205 toRotatedAuditPath: a same-millisecond collision suffixes instead of clobbering', () => {
  const dir = mkTmpDir('syncrona-audit-rotate-collision-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    const frozen = new Date('2026-08-07T12:34:56.789Z');
    const stamp = '2026-08-07T12-34-56-789Z';

    const first = toRotatedAuditPath(auditFile, frozen);
    // No `corrupt.` infix: a rotated log is intact history, and the pruners must not
    // mistake it for tamper evidence (nor the other way round).
    assert.equal(path.basename(first), `audit.${stamp}.log`);
    assert.ok(!path.basename(first).includes('.corrupt.'));
    fs.writeFileSync(first, 'first-rotation', 'utf-8');

    const second = toRotatedAuditPath(auditFile, frozen);
    assert.equal(path.basename(second), `audit.${stamp}.1.log`);
    fs.writeFileSync(second, 'second-rotation', 'utf-8');

    const third = toRotatedAuditPath(auditFile, frozen);
    assert.equal(path.basename(third), `audit.${stamp}.2.log`);

    // Same stake as quarantine: the renameSync the caller is about to perform must not
    // land on a log that still holds events nothing else has a copy of.
    assert.equal(fs.readFileSync(first, 'utf-8'), 'first-rotation');
    assert.equal(fs.readFileSync(second, 'utf-8'), 'second-rotation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-205 toRotatedAuditPath: defaults to the wall clock when no instant is supplied', () => {
  const dir = mkTmpDir('syncrona-audit-rotate-default-');
  try {
    const auditFile = path.join(dir, 'audit.log');
    const before = Date.now();
    const candidate = toRotatedAuditPath(auditFile);
    const after = Date.now();

    const match = /^audit\.(.+)\.log$/.exec(path.basename(candidate));
    assert.ok(match, `unexpected rotated name: ${path.basename(candidate)}`);
    const stampedAt = Date.parse(match[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z'));
    assert.ok(
      stampedAt >= before && stampedAt <= after,
      `stamp ${match[1]} outside [${before}, ${after}]`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
