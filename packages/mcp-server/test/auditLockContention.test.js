// SPDX-License-Identifier: GPL-3.0-or-later
//
// CONC-8 follow-up: the contention arms of the audit lock (acquireAuditLock /
// releaseAuditLock) used to be exercised only INCIDENTALLY, by real cross-process
// contention between concurrently running test files. That made the branch-coverage
// measurement of dist/audit.js scheduler-dependent: the stale-reclaim body and the
// release best-effort catch were hit on some full-suite runs and not others
// (observed as 92.15 <-> 92.18 drift in the coverage gate), and the vanished-lock
// and deadline arms ran only 3-4 times per suite, so a quiet machine could drop
// them to zero. These tests drive every arm deterministically through
// writeAuditEvent, so the measurement no longer depends on load.
//
// The lock functions are intentionally not exported; each scenario is staged from
// the outside: a planted lock file next to the audit file, and (for the two
// vanished-lock windows) a targeted one-shot patch of the `fs` module method that
// the compiled dist/audit.js looks up at call time on the shared module object.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditEvent } = require('../dist/audit.js');

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

test('a fresh foreign lock stalls the writer to the deadline, then the record is written anyway', () => {
  const dir = mkTmpDir('syncrona-audit-lock-deadline-');
  try {
    const file = path.join(dir, 'audit.log');
    const lockPath = `${file}.lock`;
    // A live foreign writer: fresh mtime, so the stale-reclaim path must NOT fire.
    fs.writeFileSync(lockPath, '999999');

    const started = Date.now();
    const res = writeAuditEvent(dir, file, { event: 'evt', marker: 'deadline' });
    const elapsed = Date.now() - started;

    // Losing the lock must never lose the record: the writer falls through unlocked.
    assert.equal(res.ok, true);
    assert.equal(readLines(file).length, 1);
    // It genuinely waited for the full window (500ms minus timer slack) ...
    assert.ok(elapsed >= 450, `expected a ~500ms wait, took ${elapsed}ms`);
    // ... and a lock it never acquired is not its to release.
    assert.ok(fs.existsSync(lockPath), 'the foreign lock must survive the fall-through');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale foreign lock (mtime beyond the 10s threshold) is reclaimed, not waited on', () => {
  const dir = mkTmpDir('syncrona-audit-lock-stale-');
  try {
    const file = path.join(dir, 'audit.log');
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, '999999');
    // A writer that crashed a minute ago.
    const then = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, then, then);

    const res = writeAuditEvent(dir, file, { event: 'evt', marker: 'stale' });

    assert.equal(res.ok, true);
    assert.equal(readLines(file).length, 1);
    // Reclaim, not deadline: the deadline path would have left the planted lock in
    // place (see the test above); reclaiming unlinks it, and the writer's own
    // replacement lock is released after the write.
    assert.ok(!fs.existsSync(lockPath), 'the stale lock must be reclaimed and released');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock that vanishes between the EEXIST failure and the stat is retried immediately', () => {
  const dir = mkTmpDir('syncrona-audit-lock-vanish-');
  const realStatSync = fs.statSync;
  try {
    const file = path.join(dir, 'audit.log');
    const lockPath = `${file}.lock`;
    // Fresh mtime: if the interception ever failed to fire, the stale path could not
    // mask it — the test would fail on the deadline wait instead.
    fs.writeFileSync(lockPath, '999999');

    let intercepted = 0;
    fs.statSync = function statSyncVanishingLock(p, ...args) {
      if (p === lockPath) {
        intercepted += 1;
        fs.statSync = realStatSync;
        // The competing writer released the lock in the window between our failed
        // O_EXCL open and this stat: make it true, then report it.
        fs.unlinkSync(lockPath);
        const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return realStatSync.call(this, p, ...args);
    };

    const res = writeAuditEvent(dir, file, { event: 'evt', marker: 'vanished' });

    assert.equal(res.ok, true);
    assert.equal(intercepted, 1, 'the stat of the lock must have been intercepted exactly once');
    assert.equal(readLines(file).length, 1);
    assert.ok(!fs.existsSync(lockPath), 'the retried acquire must succeed and release its lock');
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing a lock that a stale-reclaimer already removed is best-effort', () => {
  const dir = mkTmpDir('syncrona-audit-lock-release-');
  const realUnlinkSync = fs.unlinkSync;
  try {
    const file = path.join(dir, 'audit.log');
    const lockPath = `${file}.lock`;
    // No planted lock: the writer acquires its own. Simulate a concurrent process
    // stale-reclaiming it mid-write, so the final release finds nothing to unlink.
    let intercepted = 0;
    fs.unlinkSync = function unlinkSyncReclaimedLock(p, ...args) {
      if (p === lockPath) {
        intercepted += 1;
        fs.unlinkSync = realUnlinkSync;
        realUnlinkSync.call(this, p, ...args);
        const err = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return realUnlinkSync.call(this, p, ...args);
    };

    const res = writeAuditEvent(dir, file, { event: 'evt', marker: 'release' });

    assert.equal(res.ok, true, 'a failed lock release must never fail the write');
    assert.equal(intercepted, 1, 'the release unlink must have been intercepted exactly once');
    assert.equal(readLines(file).length, 1);
  } finally {
    fs.unlinkSync = realUnlinkSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
