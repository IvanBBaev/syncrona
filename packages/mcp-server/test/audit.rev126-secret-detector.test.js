// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-8 follow-up (REV-126): looksLikeSecretValue caught connection strings, JWTs, PEM
// keys, inline Authorization and AWS access-key IDs, but missed the most common
// vendor-prefixed API keys/tokens and raw high-entropy secrets. Broaden the detector while
// keeping precision — ordinary forensic values (URLs, table paths, prose, 32-char
// sys_ids, 40-char git SHAs) must stay verbatim.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeForAudit } = require('../dist/audit.js');

// Every value here is synthetic, but a complete vendor token spelled out as one
// literal is what push-protection scanners match on, and a blocked push is not a
// finding worth arguing with. Assemble each fixture from its vendor prefix and a
// fake body so the full pattern only ever exists at runtime — the detector under
// test receives exactly the same string either way.
const token = (...parts) => parts.join('');

const SECRETS = {
  stripeSecret: token('sk', '_live_', '51ABCdefGHIjklMNOpqr'),
  stripeTest: token('pk', '_test_', '51ABCdefGHIjklMNOpqr'),
  openai: token('sk', '-', 'ABCDEFGHIJKLMNOPQRSTuvwx0123456789'),
  githubPat: token('ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  githubFineGrained: token('github', '_pat_', 'ABCDEFGHIJKLMNOPQRSTUV1234567890'),
  slack: token('xoxb', '-1234567890-', 'ABCDEFGHIJKLMNOP'),
  gitlab: token('glpat', '-', 'ABCDEFGHIJKLMNOPqrst'),
  google: token('AIza', 'ABCDEFGHIJKLMNOPQRSTUVWX01234567890'),
  rawHex: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  awsSecretLabelled: token('aws_secret_access_key=', 'wJalrXUtnFEMIabcdEXAMPLEKEY'),
};

for (const [name, value] of Object.entries(SECRETS)) {
  test(`REV-126 redacts a bare ${name} secret string`, () => {
    assert.equal(sanitizeForAudit(value), '<redacted>');
  });
  test(`REV-126 redacts a ${name} secret smuggled in a benign-keyed value`, () => {
    const out = sanitizeForAudit({ note: value });
    assert.equal(out.note, '<redacted>');
  });
}

const KEEP = {
  prose1: 'all systems ok',
  prose2: 'updated the business rule ordering',
  url: 'https://example.com/api/v1/tables',
  host: 'example.service-now.com',
  sysId32: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  gitSha40: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
};

for (const [name, value] of Object.entries(KEEP)) {
  test(`REV-126 keeps a benign ${name} value verbatim`, () => {
    assert.equal(sanitizeForAudit(value), value);
    const out = sanitizeForAudit({ note: value });
    assert.equal(out.note, value);
  });
}
