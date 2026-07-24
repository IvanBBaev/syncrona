// SPDX-License-Identifier: GPL-3.0-or-later
//
// SEC-6 (REV-87): audit writes must not follow symlinks and must not silently swallow
// failures for MUTATING tools. The old writeAuditEvent returned void, used size checks
// that followed symlinks, and always logged failures at debug. These tests assert the
// new fail-closed contract (AuditWriteResult) and symlink refusal — they fail on the
// pre-REV-87 behavior (undefined return / target written through the symlink).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditEvent } = require('../dist/audit.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('REV-87 writeAuditEvent refuses to write through a symlink and does not touch the target', () => {
  const dir = mkTmpDir('syncrona-audit-symlink-');
  try {
    const target = path.join(dir, 'target.log');
    fs.writeFileSync(target, 'SENTINEL\n');
    const linkPath = path.join(dir, 'audit.log');
    try {
      fs.symlinkSync(target, linkPath);
    } catch (_) {
      // Platform without symlink support: skip without failing the suite.
      return;
    }

    const result = writeAuditEvent(dir, linkPath, { tool: 'sync_push', mutating: true });

    assert.equal(result.ok, false, 'symlinked write must be refused');
    assert.equal(result.mutating, true);
    // The link target must be untouched: no audit content redirected through the symlink.
    assert.equal(fs.readFileSync(target, 'utf-8'), 'SENTINEL\n');
    // The path itself is still a symlink (was not replaced by a real appended file).
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-87 writeAuditEvent surfaces a failed MUTATING write instead of swallowing it', () => {
  const dir = mkTmpDir('syncrona-audit-failclosed-');
  try {
    // Parent of the audit file is a regular file, so append fails internally (ENOTDIR).
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not-a-dir');
    const auditFile = path.join(blockerFile, 'audit.log');

    let result;
    assert.doesNotThrow(() => {
      result = writeAuditEvent(blockerFile, auditFile, { tool: 'sync_deploy', mutating: true });
    });
    assert.equal(result.ok, false);
    assert.equal(result.mutating, true);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'a mutating write failure must carry an error message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-87 writeAuditEvent returns a success result for a normal non-mutating write', () => {
  const dir = mkTmpDir('syncrona-audit-okresult-');
  try {
    const file = path.join(dir, 'audit.log');
    const result = writeAuditEvent(dir, file, { event: 'tool.call', tool: 'sync_download', mutating: false });
    assert.equal(result.ok, true);
    assert.equal(result.mutating, false);
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REV-87 auditMutatingTool-shaped records (no event field, has tool) are treated as mutating', () => {
  const dir = mkTmpDir('syncrona-audit-mutshape-');
  try {
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    const auditFile = path.join(blockerFile, 'audit.log');
    // No `event` field + a `tool` field is the auditMutatingTool record shape.
    const result = writeAuditEvent(blockerFile, auditFile, { tool: 'sync_push', outcome: {} });
    assert.equal(result.ok, false);
    assert.equal(result.mutating, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
