// SPDX-License-Identifier: GPL-3.0-or-later
// The credential store persists multi-method auth material (`syncrona login`
// writes authMethod / clientId / clientSecret / apiKey / jwtKeyPath / JWT
// claims) and the core CLI consumes it — but resolveServiceNowSecrets used to
// read that material from process.env only, so a store-only non-Basic login
// either silently degraded to Basic (oauth-password) or refused to start
// (client-credentials / jwt-bearer / api-key store no password). These tests
// pin the store-backed path end-to-end, plus the two guard rails: an env-side
// identity suppresses stored extras (all-or-nothing, no mixing), and extras
// from a login to instance X are never applied to an env-configured instance Y.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  resolveServiceNowSecrets,
  snRequestWithConfig,
  clearServiceNowSecretsCache,
  clearTokenManagerCache,
} = require('../dist/servicenowCore.js');
const {
  saveCredentials,
  setActiveInstance,
  clearStoreKeyCache,
} = require('@syncrona/credential-store');

const ENV_KEYS = [
  'SN_INSTANCE',
  'SN_USER',
  'SN_PASSWORD',
  'SYNCRONA_SECRETS_FILE',
  'SN_AUTH_METHOD',
  'SN_OAUTH_CLIENT_ID',
  'SN_OAUTH_CLIENT_SECRET',
  'SN_API_KEY',
  'SN_API_KEY_HEADER',
  'SN_JWT_KEY',
  'SN_JWT_KID',
  'SN_JWT_ISS',
  'SN_JWT_SUB',
  'SN_JWT_AUD',
  'SN_CLIENT_CERT',
  'SN_CLIENT_KEY',
  'SN_CLIENT_KEY_PASSPHRASE',
  'SYNCRONA_CA_BUNDLE',
  'SYNCRONA_TLS_REJECT_UNAUTHORIZED',
  'HOME',
  'SYNCRONA_STORE_KEY',
  'SYNCRONA_USE_KEYCHAIN',
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
  clearStoreKeyCache();
  clearServiceNowSecretsCache();
}

// Isolate the credential store in a temp HOME with an explicit at-rest key, so
// the test never touches the developer's real store or OS keychain.
function withIsolatedStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-store-multi-home-'));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.SYNCRONA_USE_KEYCHAIN = '0';
  process.env.SYNCRONA_STORE_KEY = '11'.repeat(32);
  clearStoreKeyCache();
  clearServiceNowSecretsCache();
  return home;
}

function freshProjectDir(home) {
  return fs.mkdtempSync(path.join(home, 'project-'));
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('a store-only api-key login authenticates end-to-end through the MCP transport', async () => {
  const snap = snapshotEnv();
  clearTokenManagerCache();
  const seen = [];
  const { server, base } = await startServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const home = withIsolatedStore();
    // instanceToBaseUrl preserves an explicit http:// prefix, so the stored
    // instance can point at the local mock and exercise the real fetch path.
    await saveCredentials(base, '', '', {
      authMethod: 'api-key',
      apiKey: 'store-key-1',
    });
    await setActiveInstance(base);

    const config = resolveServiceNowSecrets(freshProjectDir(home));
    assert.equal(config.instance, base);
    assert.equal(config.authMethod, 'api-key');
    assert.equal(config.apiKey, 'store-key-1');

    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    const call = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.equal(call.headers['x-sn-apikey'], 'store-key-1');
    assert.ok(!call.headers.authorization, 'no Authorization header for api-key');
  } finally {
    await close(server);
    restoreEnv(snap);
  }
});

test('a store-only oauth-client-credentials login resolves with its client pair verbatim', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    const instance = 'store-cc.service-now.com';
    // Trailing space on purpose: store-origin secrets must never be
    // dotenv-cleaned on the way out (REV-157).
    const secret = 'cs3cret ';
    await saveCredentials(instance, '', '', {
      authMethod: 'oauth-client-credentials',
      clientId: 'cid-cc',
      clientSecret: secret,
    });
    await setActiveInstance(instance);

    // This configuration used to throw "Missing ServiceNow credentials for
    // basic auth" because the stored client pair was never read.
    const config = resolveServiceNowSecrets(freshProjectDir(home));
    assert.equal(config.authMethod, 'oauth-client-credentials');
    assert.equal(config.clientId, 'cid-cc');
    assert.equal(config.clientSecret, secret);
  } finally {
    restoreEnv(snap);
  }
});

test('a store-only oauth-jwt-bearer login carries the key path and JWT claims', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    const instance = 'store-jwt.service-now.com';
    const keyPath = path.join(home, 'signing-key.pem');
    await saveCredentials(instance, '', '', {
      authMethod: 'oauth-jwt-bearer',
      clientId: 'cid-jwt',
      clientSecret: 'jwt-client-secret',
      jwtKeyPath: keyPath,
      jwtKid: 'kid-1',
      jwtIss: 'iss-1',
      jwtSub: 'integration.user',
      jwtAud: 'aud-1',
    });
    await setActiveInstance(instance);

    const config = resolveServiceNowSecrets(freshProjectDir(home));
    assert.equal(config.authMethod, 'oauth-jwt-bearer');
    assert.equal(config.jwtKey, keyPath, 'stored jwtKeyPath feeds the jwtKey seam');
    assert.equal(config.jwtKid, 'kid-1');
    assert.equal(config.jwtIss, 'iss-1');
    assert.equal(config.jwtSub, 'integration.user');
    assert.equal(config.jwtAud, 'aud-1');
  } finally {
    restoreEnv(snap);
  }
});

test('a store-only oauth-password login resolves to oauth-password, not silent Basic', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    const instance = 'store-ropc.service-now.com';
    await saveCredentials(instance, 'admin', 'pw-1', {
      authMethod: 'oauth-password',
      clientId: 'cid-ropc',
      clientSecret: 'sec-ropc',
    });
    await setActiveInstance(instance);

    const config = resolveServiceNowSecrets(freshProjectDir(home));
    assert.equal(
      config.authMethod,
      'oauth-password',
      'the stored method must win — this login used to degrade to basic'
    );
    assert.equal(config.clientId, 'cid-ropc');
    assert.equal(config.clientSecret, 'sec-ropc');
    assert.equal(config.user, 'admin');
    assert.equal(config.password, 'pw-1');
  } finally {
    restoreEnv(snap);
  }
});

test('an env-supplied identity suppresses stored extras (all-or-nothing, no mixing)', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    const instance = 'store-envwins.service-now.com';
    await saveCredentials(instance, '', '', {
      authMethod: 'api-key',
      apiKey: 'store-key-2',
    });
    await setActiveInstance(instance);

    // The operator configured a full Basic identity in the environment for the
    // same instance: that env-side choice stands untouched.
    process.env.SN_INSTANCE = instance;
    process.env.SN_USER = 'env.user';
    process.env.SN_PASSWORD = 'env-pw';

    const config = resolveServiceNowSecrets(freshProjectDir(home));
    assert.equal(config.authMethod, 'basic');
    assert.equal(config.user, 'env.user');
    assert.equal(config.apiKey, undefined, 'stored extras must not leak under an env identity');
  } finally {
    restoreEnv(snap);
  }
});

test('stored extras for instance X are never applied to an env-configured instance Y', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    await saveCredentials('store-x.service-now.com', '', '', {
      authMethod: 'api-key',
      apiKey: 'store-key-x',
    });
    await setActiveInstance('store-x.service-now.com');

    // Only the instance comes from the environment (the secrets-file layout
    // `syncrona mcp` writes behaves the same): pointing at ANOTHER instance
    // must not borrow the stored API key — it fails closed instead.
    process.env.SN_INSTANCE = 'other-y.service-now.com';

    assert.throws(
      () => resolveServiceNowSecrets(freshProjectDir(home)),
      /Missing ServiceNow credentials/,
      'the store extras must be skipped on an instance mismatch'
    );
  } finally {
    restoreEnv(snap);
  }
});
