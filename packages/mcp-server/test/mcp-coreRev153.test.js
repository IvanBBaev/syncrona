// SPDX-License-Identifier: GPL-3.0-or-later
// REV-153 — the OAuth token poster must resolve its undici dispatcher on every
// POST instead of capturing the one that existed when the token manager was
// created. The old code did `const dispatcher = getDispatcher(config)` once, in
// getTokenManager, and closed over it in the TokenPoster, while tokenManagerKey
// carried no TLS material at all. That produced three observable defects:
//   (a) an in-place cert rotation rebuilt the dispatcher for data requests
//       (REV-92) but the token leg kept presenting the expired material until
//       process restart — and a dead token leg breaks every OAuth call;
//   (b) once the LRU evicted (and closed) that pinned Agent, every later token
//       POST went through a destroyed client;
//   (c) two configs differing ONLY in their TLS material collided on one cached
//       token manager, so the second identity's token leg presented the first
//       identity's client certificate.
// dispatcherCertRotation.test.js only exercises getDispatcher directly, so none
// of this was covered. These tests drive the real token leg through a stubbed
// global.fetch and inspect the dispatcher attached to each token POST.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  snRequestWithConfig,
  getDispatcher,
  getCacheStatsForTest,
  clearDispatcherCache,
  clearTokenManagerCache,
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n';

const REAL_FETCH = global.fetch;

test.afterEach(() => {
  global.fetch = REAL_FETCH;
  clearDispatcherCache();
  clearTokenManagerCache();
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
});

function mkTlsFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const certPath = path.join(dir, 'client.crt');
  const keyPath = path.join(dir, 'client.key');
  const caPath = path.join(dir, 'ca.pem');
  fs.writeFileSync(certPath, FAKE_CERT, 'utf-8');
  fs.writeFileSync(keyPath, FAKE_KEY, 'utf-8');
  fs.writeFileSync(caPath, FAKE_CERT, 'utf-8');
  return { dir, certPath, keyPath, caPath };
}

// utimesSync guarantees an observably different mtime; two writeFileSync calls in
// the same millisecond could otherwise share an mtimeMs on a fast filesystem.
function bumpMtime(filePath, deltaMs) {
  const when = new Date(Date.now() + deltaMs);
  fs.utimesSync(filePath, when, when);
}

function mkFetchResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
  };
}

// Record the dispatcher attached to each oauth_token.do POST. `expires_in: 1` is
// well inside the token manager's 30s expiry skew, so every request re-posts and
// each POST is observable.
function stubFetchRecordingTokenDispatchers() {
  const seen = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('oauth_token.do')) {
      seen.push(init && init.dispatcher);
      return mkFetchResponse(200, {
        access_token: `tok-${seen.length}`,
        expires_in: 1,
      });
    }
    return mkFetchResponse(200, { result: [] });
  };
  return seen;
}

function oauthConfig(extra) {
  return {
    instance: 'rev153.service-now.com',
    user: 'admin',
    password: 'secret',
    clientId: 'cid',
    clientSecret: 'csecret',
    authMethod: 'oauth-password',
    rejectUnauthorized: true,
    tlsCustom: true,
    ...extra,
  };
}

test('the token POST follows an in-place client-cert rotation instead of the Agent pinned at manager creation (REV-153)', async () => {
  clearDispatcherCache();
  clearTokenManagerCache();
  const { certPath, keyPath } = mkTlsFixture('sn-rev153-rot-');
  const config = oauthConfig({ clientCertPath: certPath, clientKeyPath: keyPath });
  const tokenDispatchers = stubFetchRecordingTokenDispatchers();

  const first = await snRequestWithConfig(
    config,
    'GET',
    'api/now/table/incident',
    undefined,
    3000
  );
  assert.equal(first.status, 200);
  assert.equal(tokenDispatchers.length, 1, 'the first request must fetch a token');
  const before = tokenDispatchers[0];
  assert.ok(before, 'the token POST must carry the mTLS dispatcher');
  assert.strictEqual(before, getDispatcher(config), 'and it must be the cached Agent');

  // cert-manager / certbot renews the client certificate in place: same path,
  // new bytes, new mtime.
  fs.writeFileSync(certPath, `${FAKE_CERT}# rotated\n`, 'utf-8');
  bumpMtime(certPath, 5000);

  const second = await snRequestWithConfig(
    config,
    'GET',
    'api/now/table/incident',
    undefined,
    3000
  );
  assert.equal(second.status, 200);
  assert.equal(tokenDispatchers.length, 2, 'the expired token must be re-fetched');

  // The token manager itself is deliberately reused (its key folds in cert PATHS,
  // not mtimes) — so this proves the SAME poster closure picked up the new Agent.
  assert.equal(
    getCacheStatsForTest().tokenManagers,
    1,
    'a rotated cert must not throw away the cached token manager'
  );
  const after = tokenDispatchers[1];
  assert.notStrictEqual(
    after,
    before,
    'the token POST must not keep using the pre-rotation Agent'
  );
  assert.strictEqual(
    after,
    getDispatcher(config),
    'the token POST must use the freshly rebuilt Agent'
  );
});

test('the token POST does not reuse an Agent the LRU already closed (REV-153)', async () => {
  clearDispatcherCache();
  clearTokenManagerCache();
  const { caPath } = mkTlsFixture('sn-rev153-evict-');
  const config = oauthConfig({
    caBundlePath: caPath,
    clientKeyPassphrase: 'pinned',
  });
  const tokenDispatchers = stubFetchRecordingTokenDispatchers();

  await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 3000);
  assert.equal(tokenDispatchers.length, 1);
  const pinned = tokenDispatchers[0];
  assert.ok(pinned);

  // Flood the dispatcher cache with distinct TLS material until the LRU evicts
  // (and closes) the Agent this identity started with. Distinct passphrases give
  // distinct cache keys without needing many cert files.
  const { maxDispatchers } = getCacheStatsForTest();
  for (let n = 0; n < maxDispatchers; n += 1) {
    getDispatcher({
      tlsCustom: true,
      caBundlePath: caPath,
      clientKeyPassphrase: `flood-${n}`,
      rejectUnauthorized: true,
    });
  }
  assert.equal(pinned.closed, true, 'the LRU must have closed the original Agent');

  await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 3000);
  assert.equal(tokenDispatchers.length, 2);
  const rebuilt = tokenDispatchers[1];
  assert.notStrictEqual(
    rebuilt,
    pinned,
    'the token POST must not go through the evicted, closed Agent'
  );
  assert.notEqual(rebuilt.closed, true, 'the rebuilt Agent must be usable');
});

test('token managers are keyed by TLS material, so two client certs never share one poster (REV-153)', async () => {
  clearDispatcherCache();
  clearTokenManagerCache();
  const a = mkTlsFixture('sn-rev153-ident-a-');
  const b = mkTlsFixture('sn-rev153-ident-b-');
  stubFetchRecordingTokenDispatchers();

  // Same instance, user, client id and secrets — only the client certificate
  // differs, which is exactly the collision the old key could not see.
  const configA = oauthConfig({ clientCertPath: a.certPath, clientKeyPath: a.keyPath });
  const configB = oauthConfig({ clientCertPath: b.certPath, clientKeyPath: b.keyPath });

  await snRequestWithConfig(configA, 'GET', 'api/now/table/incident', undefined, 3000);
  await snRequestWithConfig(configB, 'GET', 'api/now/table/incident', undefined, 3000);

  assert.equal(
    getCacheStatsForTest().tokenManagers,
    2,
    'configs differing only in TLS material must get their own token manager'
  );
});
