// SPDX-License-Identifier: GPL-3.0-or-later
// Phase 3 — MCP transport coverage for the additional ServiceNow auth methods:
// inbound REST API key, OAuth client-credentials grant, OAuth JWT bearer grant,
// mutual TLS, plus resolveServiceNowSecrets per-method validation and the undici
// dispatcher seam. Drives the real fetch path against local node:http / node:https
// mock instances (instanceToBaseUrl preserves an explicit http(s):// prefix).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Agent } = require('undici');

const {
  snRequestWithConfig,
  resolveServiceNowSecrets,
  getDispatcher,
  clearTokenManagerCache,
  clearDispatcherCache,
} = require('../dist/servicenowCore.js');

const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

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

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

function genRsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Auth material is read straight from process.env by resolveServiceNowSecrets
// (mirroring how SN_OAUTH_CLIENT_ID/SECRET have always been read). Snapshot and
// clear these before a test, restore after, so tests don't leak into each other
// or pick up the developer's real environment.
const AUTH_ENV_VARS = [
  'SN_AUTH_METHOD',
  'SN_API_KEY',
  'SN_API_KEY_HEADER',
  'SN_OAUTH_CLIENT_ID',
  'SN_OAUTH_CLIENT_SECRET',
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
];

function snapshotEnv() {
  const saved = {};
  for (const key of AUTH_ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved) {
  for (const key of AUTH_ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// A providers array that feeds instance/user/password without touching the
// filesystem or the scrypt-backed auth store.
function fixedProviders(values) {
  return [{ name: 'fixture', load: () => values }];
}

// ---------------------------------------------------------------------------
// Inbound REST API key
// ---------------------------------------------------------------------------

test('api-key method sends the key on the default header (x-sn-apikey) and no Authorization', async () => {
  clearTokenManagerCache();
  const seen = [];
  const { server, base } = await startServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = {
      instance: base,
      user: '',
      password: '',
      authMethod: 'api-key',
      apiKey: 'k-123',
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    const call = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.equal(call.headers['x-sn-apikey'], 'k-123');
    assert.ok(!call.headers.authorization, 'no Authorization header for api-key');
    assert.ok(!seen.some((s) => s.url.endsWith('oauth_token.do')), 'token endpoint not hit');
  } finally {
    await close(server);
  }
});

test('api-key method honours a custom header name (apiKeyHeader override)', async () => {
  clearTokenManagerCache();
  const seen = [];
  const { server, base } = await startServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = {
      instance: base,
      user: '',
      password: '',
      authMethod: 'api-key',
      apiKey: 'k-9',
      apiKeyHeader: 'X-Custom-Key',
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    const call = seen.find((s) => s.url.includes('/api/now/table/incident'));
    // node lowercases incoming header names.
    assert.equal(call.headers['x-custom-key'], 'k-9');
    assert.ok(!call.headers['x-sn-apikey'], 'default header not used when overridden');
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// OAuth client-credentials grant
// ---------------------------------------------------------------------------

test('oauth-client-credentials acquires a token with grant_type=client_credentials (no username) and uses the Bearer', async () => {
  clearTokenManagerCache();
  const seen = [];
  const tokenBodies = [];
  let tokenHits = 0;
  const { server, base } = await startServer(async (req, res) => {
    if (req.url.endsWith('oauth_token.do')) {
      tokenHits += 1;
      tokenBodies.push(await readBody(req));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'cc-tok', expires_in: 1800 }));
    }
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = {
      instance: base,
      user: '',
      password: '',
      authMethod: 'oauth-client-credentials',
      clientId: 'cc-id',
      clientSecret: 'cc-secret',
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    assert.ok(tokenHits >= 1, 'token endpoint hit');
    const params = new URLSearchParams(tokenBodies[0]);
    assert.equal(params.get('grant_type'), 'client_credentials');
    assert.equal(params.get('client_id'), 'cc-id');
    assert.equal(params.get('client_secret'), 'cc-secret');
    assert.equal(params.get('username'), null, 'no username in a client_credentials body');
    const apiCall = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.equal(apiCall.auth, 'Bearer cc-tok');
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// OAuth JWT bearer grant
// ---------------------------------------------------------------------------

test('oauth-jwt-bearer signs an assertion and posts the RFC 7523 grant URN', async () => {
  clearTokenManagerCache();
  const { publicKey, privateKey } = genRsaKeyPair();
  const seen = [];
  let capturedAssertion = '';
  let capturedGrant = '';
  const { server, base } = await startServer(async (req, res) => {
    if (req.url.endsWith('oauth_token.do')) {
      const params = new URLSearchParams(await readBody(req));
      capturedGrant = params.get('grant_type') || '';
      capturedAssertion = params.get('assertion') || '';
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'jwt-tok', expires_in: 1800 }));
    }
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = {
      instance: base,
      user: 'svc-account',
      password: '',
      authMethod: 'oauth-jwt-bearer',
      clientId: 'jwt-id',
      clientSecret: 'jwt-secret',
      jwtKey: privateKey, // inline PEM
      jwtIss: 'jwt-id',
      jwtAud: base,
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);

    assert.equal(capturedGrant, JWT_BEARER_GRANT_TYPE);
    const parts = capturedAssertion.split('.');
    assert.equal(parts.length, 3, 'assertion is a compact JWS (header.payload.signature)');

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    assert.equal(header.alg, 'RS256');
    assert.equal(payload.iss, 'jwt-id');
    assert.equal(payload.aud, base);
    assert.equal(payload.sub, 'svc-account');

    // The signature verifies against the public half of the signing key.
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    assert.ok(
      verify.verify(publicKey, Buffer.from(parts[2], 'base64url')),
      'assertion signature verifies with the signing key'
    );

    const apiCall = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.equal(apiCall.auth, 'Bearer jwt-tok');
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// resolveServiceNowSecrets — per-method validation
// ---------------------------------------------------------------------------

test('resolveServiceNowSecrets accepts an instance-only api-key config', () => {
  const saved = snapshotEnv();
  try {
    process.env.SN_AUTH_METHOD = 'api-key';
    process.env.SN_API_KEY = 'k-1';
    const cfg = resolveServiceNowSecrets(
      '/nonexistent-project',
      fixedProviders({ SN_INSTANCE: 'https://dev.example.com', SN_USER: '', SN_PASSWORD: '' })
    );
    assert.equal(cfg.authMethod, 'api-key');
    assert.equal(cfg.apiKey, 'k-1');
    assert.equal(cfg.instance, 'https://dev.example.com');
  } finally {
    restoreEnv(saved);
  }
});

test('resolveServiceNowSecrets accepts an mTLS-only config (no Authorization material)', () => {
  const saved = snapshotEnv();
  try {
    process.env.SN_CLIENT_CERT = '/certs/client-cert.pem';
    process.env.SN_CLIENT_KEY = '/certs/client-key.pem';
    const cfg = resolveServiceNowSecrets(
      '/nonexistent-project',
      fixedProviders({ SN_INSTANCE: 'https://dev.example.com', SN_USER: '', SN_PASSWORD: '' })
    );
    assert.equal(cfg.clientCertPath, '/certs/client-cert.pem');
    assert.equal(cfg.clientKeyPath, '/certs/client-key.pem');
    assert.equal(cfg.tlsCustom, true);
  } finally {
    restoreEnv(saved);
  }
});

test('resolveServiceNowSecrets accepts client-credentials without a user/password', () => {
  const saved = snapshotEnv();
  try {
    process.env.SN_AUTH_METHOD = 'oauth-client-credentials';
    process.env.SN_OAUTH_CLIENT_ID = 'cc';
    process.env.SN_OAUTH_CLIENT_SECRET = 's';
    const cfg = resolveServiceNowSecrets(
      '/nonexistent-project',
      fixedProviders({ SN_INSTANCE: 'https://dev.example.com', SN_USER: '', SN_PASSWORD: '' })
    );
    assert.equal(cfg.authMethod, 'oauth-client-credentials');
    assert.equal(cfg.clientId, 'cc');
    assert.equal(cfg.clientSecret, 's');
  } finally {
    restoreEnv(saved);
  }
});

test('resolveServiceNowSecrets keeps Basic working with a user + password (backward compatible)', () => {
  const saved = snapshotEnv();
  try {
    const cfg = resolveServiceNowSecrets(
      '/nonexistent-project',
      fixedProviders({ SN_INSTANCE: 'https://dev.example.com', SN_USER: 'u', SN_PASSWORD: 'p' })
    );
    assert.equal(cfg.authMethod, 'basic');
    assert.equal(cfg.user, 'u');
    assert.equal(cfg.password, 'p');
  } finally {
    restoreEnv(saved);
  }
});

test('resolveServiceNowSecrets throws for Basic without a user', () => {
  const saved = snapshotEnv();
  try {
    assert.throws(
      () =>
        resolveServiceNowSecrets(
          '/nonexistent-project',
          fixedProviders({ SN_INSTANCE: 'https://dev.example.com', SN_USER: '', SN_PASSWORD: 'p' })
        ),
      /SN_USER|credentials/
    );
  } finally {
    restoreEnv(saved);
  }
});

test('resolveServiceNowSecrets throws when the instance is missing', () => {
  const saved = snapshotEnv();
  try {
    assert.throws(
      () =>
        resolveServiceNowSecrets(
          '/nonexistent-project',
          fixedProviders({ SN_INSTANCE: '', SN_USER: 'u', SN_PASSWORD: 'p' })
        ),
      /Missing ServiceNow instance/
    );
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// getDispatcher — undici Agent seam
// ---------------------------------------------------------------------------

test('getDispatcher returns undefined for default TLS', () => {
  clearDispatcherCache();
  assert.equal(getDispatcher({ instance: 'x' }), undefined);
  assert.equal(getDispatcher({ instance: 'x', tlsCustom: false }), undefined);
});

test('getDispatcher builds and caches one Agent per distinct TLS material', () => {
  clearDispatcherCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snmtls-unit-'));
  const { publicKey, privateKey } = genRsaKeyPair();
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  fs.writeFileSync(certPath, publicKey);
  fs.writeFileSync(keyPath, privateKey);

  try {
    const config = {
      instance: 'x',
      tlsCustom: true,
      clientCertPath: certPath,
      clientKeyPath: keyPath,
      rejectUnauthorized: true,
    };
    const a1 = getDispatcher(config);
    assert.ok(a1 instanceof Agent, 'builds an undici Agent');
    const a2 = getDispatcher(config);
    assert.equal(a1, a2, 'same TLS material reuses the cached dispatcher');
    a1.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDispatcher throws loudly on an unreadable client cert path', () => {
  clearDispatcherCache();
  assert.throws(() =>
    getDispatcher({
      instance: 'x',
      tlsCustom: true,
      clientCertPath: '/no/such/cert.pem',
      clientKeyPath: '/no/such/key.pem',
    })
  );
});

// ---------------------------------------------------------------------------
// Mutual TLS handshake smoke test
// ---------------------------------------------------------------------------

test('mutual TLS: the client presents its certificate; a request without it is rejected', async (t) => {
  clearDispatcherCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snmtls-hs-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );
  } catch (err) {
    t.skip(`openssl unavailable: ${err.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  const certPem = fs.readFileSync(certPath);
  const keyPem = fs.readFileSync(keyPath);
  let sawClientCert = false;
  const server = https.createServer(
    { key: keyPem, cert: certPem, ca: [certPem], requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      sawClientCert = !!(peer && peer.subject);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: [] }));
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `https://127.0.0.1:${port}`;

  let okDisp;
  let noDisp;
  try {
    // WITH the client certificate: the handshake completes and the API returns 200.
    // rejectUnauthorized:false on the client side skips verification of the
    // self-signed server cert so the assertion isolates client-cert presentation.
    const okConfig = {
      instance: base,
      user: '',
      password: '',
      authMethod: 'basic',
      clientCertPath: certPath,
      clientKeyPath: keyPath,
      caBundlePath: certPath,
      rejectUnauthorized: false,
      tlsCustom: true,
    };
    const out = await snRequestWithConfig(okConfig, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    assert.ok(sawClientCert, 'server observed the presented client certificate');
    okDisp = getDispatcher(okConfig);

    // WITHOUT a client certificate: the mTLS server aborts the handshake.
    const noCertConfig = {
      instance: base,
      user: '',
      password: '',
      authMethod: 'basic',
      caBundlePath: certPath,
      rejectUnauthorized: false,
      tlsCustom: true,
    };
    await assert.rejects(
      snRequestWithConfig(noCertConfig, 'GET', 'api/now/table/incident', undefined, 5000),
      'a request without the client certificate is rejected'
    );
    noDisp = getDispatcher(noCertConfig);
  } finally {
    if (okDisp && okDisp.close) okDisp.close();
    if (noDisp && noDisp.close) noDisp.close();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
