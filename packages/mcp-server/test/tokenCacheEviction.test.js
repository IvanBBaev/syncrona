// SPDX-License-Identifier: GPL-3.0-or-later
// CONC-5 / REV-109 — two long-lived-state defects in servicenowCore:
//   (1) a 30s secrets cache plus a token manager cached under the (stale) creds
//       meant a rotated-away credential kept 401ing for up to 30s: even a forced
//       token refresh re-used the stale secret. The fix: a 401 that SURVIVES a
//       force-refresh drops that token manager and busts the secrets cache so the
//       NEXT request re-resolves fresh credentials.
//   (2) tokenManagers / dispatchers Maps grew unbounded. The fix caps both with
//       LRU eviction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getServiceNowConfig,
  snRequestWithConfig,
  getDispatcher,
  getCacheStatsForTest,
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
  clearTokenManagerCache,
  clearDispatcherCache,
} = require('../dist/servicenowCore.js');

const REAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_FETCH;
});

const ENV_KEYS = [
  'SN_INSTANCE',
  'SN_USER',
  'SN_PASSWORD',
  'SYNCRONA_SECRETS_FILE',
  'HOME',
  'SN_OAUTH_CLIENT_ID',
  'SN_OAUTH_CLIENT_SECRET',
  'SN_AUTH_METHOD',
  'SN_API_KEY',
  'SN_API_KEY_HEADER',
  'SN_JWT_KEY',
  'SN_CLIENT_CERT',
  'SN_CLIENT_KEY',
  'SN_CLIENT_KEY_PASSPHRASE',
  'SN_TLS_REJECT_UNAUTHORIZED',
];

function snapshotEnv() {
  const snap = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap) {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snap[key];
    }
  }
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();
  clearDispatcherCache();
}

function clearAllRelevantEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
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

// ---------------------------------------------------------------------------
// (1) 401 after force-refresh -> re-resolve fresh credentials
// ---------------------------------------------------------------------------

test('a 401 surviving a force-refresh evicts the token manager and busts the secrets cache (REV-109)', async () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.SN_INSTANCE = 'first.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-reresolve-home-'));
  clearServiceNowSecretsCache();
  clearTokenManagerCache();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-reresolve-'));
  try {
    // Prime the 30s secrets cache with the current instance value.
    const before = getServiceNowConfig(dir);
    assert.equal(before.instance, 'first.service-now.com');

    // The token endpoint always issues a token; every API call answers 401.
    let apiCalls = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth_token.do')) {
        return mkFetchResponse(200, { access_token: `tok-${Math.random()}` });
      }
      apiCalls += 1;
      return mkFetchResponse(401, { error: 'unauthorized' });
    };

    const oauthConfig = {
      instance: 'first.service-now.com',
      user: 'admin',
      password: 'secret',
      clientId: 'cid',
      clientSecret: 'csecret',
      authMethod: 'oauth-password',
    };

    const res = await snRequestWithConfig(
      oauthConfig,
      'GET',
      'api/now/table/incident',
      undefined,
      3000
    );

    assert.equal(res.status, 401);
    // Two API attempts: the original request and one retry after forceRefresh.
    assert.equal(apiCalls, 2, 'exactly one forced-refresh retry, then give up');

    // The token manager for this identity was dropped, so the next request will
    // build a fresh one instead of reusing the stale cached token.
    assert.equal(
      getCacheStatsForTest().tokenManagers,
      0,
      'the stale token manager must be evicted after a persistent 401'
    );

    // The secrets cache was busted: a resolve now picks up rotated credentials
    // instead of serving the stale config for the remainder of the TTL.
    process.env.SN_INSTANCE = 'rotated.service-now.com';
    const after = getServiceNowConfig(dir);
    assert.equal(
      after.instance,
      'rotated.service-now.com',
      'the 30s secrets cache must be busted so the next resolve is fresh'
    );
  } finally {
    restoreEnv(snap);
  }
});

// ---------------------------------------------------------------------------
// (2a) dispatcher Map is LRU-evicted past the cap
// ---------------------------------------------------------------------------

test('getDispatcher evicts the least-recently-used Agent past the cache cap (REV-109)', () => {
  clearDispatcherCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-disp-evict-'));
  const caPath = path.join(dir, 'ca.pem');
  fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n', 'utf-8');

  // Distinct passphrase => distinct cache key without needing many cert files.
  const makeConfig = (n) => ({
    tlsCustom: true,
    caBundlePath: caPath,
    clientKeyPassphrase: `pass-${n}`,
    rejectUnauthorized: true,
  });

  const { maxDispatchers } = getCacheStatsForTest();

  try {
    const first = getDispatcher(makeConfig(0));
    assert.ok(first);

    // Insert `maxDispatchers` more distinct configs -> maxDispatchers + 1 total,
    // which forces at least one eviction (the LRU entry is config 0).
    for (let n = 1; n <= maxDispatchers; n += 1) {
      getDispatcher(makeConfig(n));
    }

    assert.ok(
      getCacheStatsForTest().dispatchers <= maxDispatchers,
      'the dispatcher cache must never exceed its cap'
    );

    // config 0 was the least-recently-used and has been evicted -> a fresh
    // request for it builds a NEW Agent rather than returning the old one.
    const firstAgain = getDispatcher(makeConfig(0));
    assert.notStrictEqual(
      firstAgain,
      first,
      'the least-recently-used Agent must have been evicted'
    );
  } finally {
    clearDispatcherCache();
  }
});

// ---------------------------------------------------------------------------
// (2b) token-manager Map is bounded past the cap
// ---------------------------------------------------------------------------

test('token managers are evicted so the cache stays bounded past the cap (REV-109)', async () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.SN_INSTANCE = 'evict.service-now.com';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-tm-evict-home-'));
  clearTokenManagerCache();

  // Token endpoint issues a token; the API answers 200 so no retry loop runs.
  global.fetch = async (url) => {
    if (String(url).includes('oauth_token.do')) {
      return mkFetchResponse(200, { access_token: 'tok' });
    }
    return mkFetchResponse(200, { result: [] });
  };

  const { maxTokenManagers } = getCacheStatsForTest();
  try {
    // Each distinct clientSecret yields a distinct credential fingerprint, hence
    // a distinct token-manager key. Drive one more than the cap.
    for (let n = 0; n <= maxTokenManagers; n += 1) {
      const cfg = {
        instance: 'evict.service-now.com',
        user: 'admin',
        password: 'secret',
        clientId: 'cid',
        clientSecret: `csecret-${n}`,
        authMethod: 'oauth-password',
      };
      const res = await snRequestWithConfig(
        cfg,
        'GET',
        'api/now/table/incident',
        undefined,
        3000
      );
      assert.equal(res.status, 200);
    }

    assert.ok(
      getCacheStatsForTest().tokenManagers <= maxTokenManagers,
      'the token-manager cache must never exceed its cap'
    );
  } finally {
    restoreEnv(snap);
  }
});
