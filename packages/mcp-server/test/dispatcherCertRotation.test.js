// SPDX-License-Identifier: GPL-3.0-or-later
// CONC-1 / REV-92 — the TLS dispatcher cache must be invalidated when a cert /
// key / CA bundle is rotated in place (same path, new bytes). Before the fix the
// cache key was the set of file PATHS only, so an in-place renewal kept serving
// the stale Agent (built from the now-expired cert) until process restart — a
// total mTLS outage at cert expiry. The fix folds each file's mtimeMs into the
// cache key. These tests exercise getDispatcher directly (no live handshake:
// undici's Agent parses the cert lazily on first connect, so fake PEM is fine).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getDispatcher,
  clearDispatcherCache,
} = require('../dist/servicenowCore.js');

const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n';

function mkMtlsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-cert-rot-'));
  const certPath = path.join(dir, 'client.crt');
  const keyPath = path.join(dir, 'client.key');
  fs.writeFileSync(certPath, FAKE_CERT, 'utf-8');
  fs.writeFileSync(keyPath, FAKE_KEY, 'utf-8');
  return { dir, certPath, keyPath };
}

// utimesSync guarantees an observably different mtime; two writeFileSync calls in
// the same millisecond could otherwise share an mtimeMs on a fast filesystem.
function bumpMtime(filePath, deltaMs) {
  const when = new Date(Date.now() + deltaMs);
  fs.utimesSync(filePath, when, when);
}

test('getDispatcher reuses one Agent while the cert files are unchanged', () => {
  clearDispatcherCache();
  const { certPath, keyPath } = mkMtlsFixture();
  const config = {
    tlsCustom: true,
    clientCertPath: certPath,
    clientKeyPath: keyPath,
    rejectUnauthorized: true,
  };

  const first = getDispatcher(config);
  const second = getDispatcher(config);
  assert.ok(first);
  assert.strictEqual(second, first, 'unchanged cert files must reuse the cached Agent');

  clearDispatcherCache();
});

test('getDispatcher rebuilds the Agent after an in-place client-cert rotation (new mtime) (REV-92)', () => {
  clearDispatcherCache();
  const { certPath, keyPath } = mkMtlsFixture();
  const config = {
    tlsCustom: true,
    clientCertPath: certPath,
    clientKeyPath: keyPath,
    rejectUnauthorized: true,
  };

  const before = getDispatcher(config);
  assert.ok(before);

  // Renew the certificate in place: same path, new bytes, new mtime.
  fs.writeFileSync(certPath, `${FAKE_CERT}# rotated\n`, 'utf-8');
  bumpMtime(certPath, 5000);

  const after = getDispatcher(config);
  assert.ok(after);
  assert.notStrictEqual(
    after,
    before,
    'an in-place cert rotation must drop the stale Agent and rebuild it'
  );

  clearDispatcherCache();
});

test('getDispatcher rebuilds the Agent when the CA bundle is rotated in place (REV-92)', () => {
  clearDispatcherCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-ca-rot-'));
  const caPath = path.join(dir, 'ca.pem');
  fs.writeFileSync(caPath, FAKE_CERT, 'utf-8');
  const config = {
    tlsCustom: true,
    caBundlePath: caPath,
    rejectUnauthorized: true,
  };

  const before = getDispatcher(config);
  assert.ok(before);

  fs.writeFileSync(caPath, `${FAKE_CERT}# new-ca\n`, 'utf-8');
  bumpMtime(caPath, 5000);

  const after = getDispatcher(config);
  assert.notStrictEqual(after, before, 'a rotated CA bundle must rebuild the Agent');

  clearDispatcherCache();
});
