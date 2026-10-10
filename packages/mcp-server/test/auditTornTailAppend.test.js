// SPDX-License-Identifier: GPL-3.0-or-later
//
// A writer killed mid-append (a second MCP server on the same workspace, or a short write
// on a full disk) leaves audit.log ending in a partial line with no newline. The startup
// integrity check repairs that, but a write that lands BEFORE the next check appended its
// record straight onto the fragment: the record became part of one unparseable line, so
// it was unreadable and lost to every consumer, while writeAuditEvent still reported ok.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditEvent, checkAuditLogIntegrity } = require('../dist/audit.js');

test('a record written after a torn trailing line lands on its own parseable line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-audit-torn-append-'));
  try {
    const file = path.join(dir, 'audit.log');
    assert.equal(writeAuditEvent(dir, file, { tool: 'first', mutating: true }).ok, true);
    fs.appendFileSync(file, '{"tool":"torn","mutat', 'utf-8');

    const result = writeAuditEvent(dir, file, { tool: 'sync_push', mutating: true });
    assert.equal(result.ok, true);

    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    assert.equal(lines[lines.length - 1], '', 'the file still ends with a newline');
    const parsed = lines
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch (_) {
          return [];
        }
      });
    assert.deepEqual(
      parsed.map((record) => record.tool),
      ['first', 'sync_push']
    );

    // The fragment is now an interior malformed line, so the next check quarantines the
    // log; the record survives inside the quarantined copy.
    const integrity = checkAuditLogIntegrity(dir, file);
    assert.equal(integrity.status, 'quarantined');
    assert.match(fs.readFileSync(integrity.quarantinedFile, 'utf-8'), /"tool":"sync_push"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('records appended to a newline-terminated log stay one per line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-audit-torn-append-'));
  try {
    const file = path.join(dir, 'audit.log');
    writeAuditEvent(dir, file, { tool: 'a', mutating: true });
    writeAuditEvent(dir, file, { tool: 'b', mutating: true });
    const raw = fs.readFileSync(file, 'utf-8');
    assert.equal(raw.split('\n').length, 3);
    assert.ok(!raw.includes('\n\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
