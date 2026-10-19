// SPDX-License-Identifier: GPL-3.0-or-later
// REV-208 (MCP half) — `readPemMaterial` in servicenowCore treats any value without
// PEM armor as a filesystem path and passes it to readFileSync, which embeds the
// argument verbatim in its message ("ENOENT: ... open '<value>'", ENAMETOOLONG past
// the OS filename limit). A JWT signing key supplied base64-encoded (the usual way
// to fit a PEM into one environment variable or CI secret) therefore travels inside
// the error message to all three sinks index.ts builds from a tool failure: the
// stderr logger, the audit event, and the structured error text returned to the
// client. The audit secret scanner does not catch it — audit.ts matches literal
// `-----BEGIN ... PRIVATE KEY-----` armor, which is exactly the shape readPemMaterial
// short-circuits on, and the message is well under SECRET_SCAN_BUDGET.
//
// The seam: readPemMaterial and buildOAuthConfig are module-private, but
// getTokenManager calls buildOAuthConfig synchronously, and snRequestWithConfig
// calls getTokenManager before any request leaves. So an exported call reaches the
// throw with no network and no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { snRequestWithConfig, clearTokenManagerCache } = require('../dist/servicenowCore.js');

function jwtConfig(jwtKey) {
  return {
    instance: 'http://127.0.0.1:1/',
    user: '',
    password: '',
    authMethod: 'oauth-jwt-bearer',
    clientId: 'jwt-id',
    clientSecret: 'jwt-secret',
    jwtKey,
    jwtIss: 'jwt-id',
    jwtSub: 'admin',
  };
}

// Every string a downstream sink can plausibly read off a thrown error. A fix that
// only rewrites the message but re-attaches the original error as `cause` has not
// fixed anything, so `cause` and the fs `path` property are covered too.
function errorSurface(error) {
  const cause = error && error.cause;
  return [
    error && error.message,
    error && error.stack,
    error && error.path !== undefined ? String(error.path) : '',
    cause && cause.message,
    cause && cause.path !== undefined ? String(cause.path) : '',
  ]
    .filter((part) => typeof part === 'string')
    .join('\n');
}

async function captureRejection(config) {
  try {
    await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 1000);
  } catch (e) {
    return e;
  }
  return undefined;
}

test('REV-208: a base64-encoded private key never reaches the thrown error', async () => {
  clearTokenManagerCache();
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const base64Key = Buffer.from(privateKey).toString('base64');
  assert.ok(!base64Key.includes('-----BEGIN'), 'precondition: no armor, so the fs path is taken');

  const error = await captureRejection(jwtConfig(base64Key));
  assert.ok(error, 'the unreadable key must still fail the request');
  const surface = errorSurface(error);
  assert.ok(
    !surface.includes(base64Key.slice(0, 64)),
    'the error surface must not carry the key material'
  );
  assert.ok(!surface.includes(base64Key.slice(-64)), 'nor its tail');
});

test('REV-208: a short base64 key body is withheld too — length must not be the guard', async () => {
  clearTokenManagerCache();
  // A P-256 key in DER is ~250 base64 characters: under every filename limit, so
  // the fs error is ENOENT rather than ENAMETOOLONG.
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const base64Key = privateKey.toString('base64');

  const error = await captureRejection(jwtConfig(base64Key));
  assert.ok(error, 'the unreadable key must still fail the request');
  assert.ok(!errorSurface(error).includes(base64Key.slice(0, 32)));
});

test('REV-208: the failure stays diagnosable for a genuinely wrong path', async () => {
  clearTokenManagerCache();
  const error = await captureRejection(jwtConfig('/nonexistent/jwt-signing-key.pem'));
  assert.ok(error, 'a missing key file must fail the request');
  assert.match(error.message, /JWT/i);
  assert.match(error.message, /ENOENT/);
  assert.match(error.message, /32 bytes/);
});
