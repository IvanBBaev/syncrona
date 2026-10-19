// SPDX-License-Identifier: GPL-3.0-or-later
//
// SEC-8 (REV-96): audit redaction must inspect VALUES, not only keys, and the key
// allow-list must catch camelCase credential names that the old separator-anchored
// `/(^|[_-])key($|[_-])/` regex let through. Each test below fails on the pre-REV-96
// behavior (unredacted camelCase keys / unredacted secret-bearing values).
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeForAudit } = require('../dist/audit.js');

test('REV-96 sanitizeForAudit redacts camelCase/credential keys the old key regex missed', () => {
  const input = {
    privateKey: 'MIIB-private-material',
    signingKey: 'sign-me',
    clientKey: 'client-material',
    credential: 'c',
    credentials: 'cc',
    jwt: 'header.payload.sig',
    assertion: 'saml-assertion-blob',
    bearer: 'opaque-bearer-value',
    passwd: 'hunter2',
    pwd: 'hunter2',
    clientCert: '-----BEGIN CERTIFICATE-----',
  };
  const out = sanitizeForAudit(input);
  for (const key of Object.keys(input)) {
    assert.equal(out[key], '<redacted>', `expected key "${key}" to be redacted`);
  }
});

test('REV-96 sanitizeForAudit redacts secrets smuggled in benign-keyed VALUES', () => {
  const input = {
    dsn: 'postgres://dbuser:s3cr3t@db.internal:5432/app',
    ticket: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    config: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    message: 'Authorization: Bearer abcdef1234567890',
    awsLine: 'export AKIAIOSFODNN7EXAMPLE now',
  };
  const out = sanitizeForAudit(input);
  assert.equal(out.dsn, '<redacted>');
  assert.equal(out.ticket, '<redacted>');
  assert.equal(out.config, '<redacted>');
  assert.equal(out.message, '<redacted>');
  assert.equal(out.awsLine, '<redacted>');
});

test('REV-96 sanitizeForAudit does not over-redact ordinary values (no false positives)', () => {
  const input = {
    url: 'https://example.com/api/v1/tables',
    path: '/sys_script/records',
    host: 'example.service-now.com',
    count: 3,
    ratio: 0.5,
    enabled: true,
    note: 'updated the business rule ordering',
  };
  const out = sanitizeForAudit(input);
  assert.deepEqual(out, input);
});

test('REV-96 value redaction also applies to nested objects and arrays', () => {
  const input = {
    connections: [{ dsn: 'mysql://u:p@host/db' }],
    nested: { note: 'plain', deep: { ref: 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzzzzzzzzz' } },
  };
  const out = sanitizeForAudit(input);
  assert.equal(out.connections[0].dsn, '<redacted>');
  assert.equal(out.nested.note, 'plain');
  assert.equal(out.nested.deep.ref, '<redacted>');
});
