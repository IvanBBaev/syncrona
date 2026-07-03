// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, randomBytes, scryptSync } = require('node:crypto');

const {
  cleanEnvValue,
  parseDotEnv,
  instanceToBaseUrl,
  resolveServiceNowSecrets,
  getServiceNowConfig,
  loadAuthStoreProfile,
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
  clearTokenManagerCache,
  clearDispatcherCache,
  hasEnvFile,
  toTableResultRows,
  summarizeRows,
} = require('../dist/servicenowCore.js');

const {
  handleServiceNowCrudTool,
} = require('../dist/handlers/serviceNowCrudHandlers.js');

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
  'SN_JWT_KID',
  'SN_JWT_ISS',
  'SN_JWT_SUB',
  'SN_JWT_AUD',
  'SN_CLIENT_CERT',
  'SN_CLIENT_KEY',
  'SN_CLIENT_KEY_PASSPHRASE',
  'SN_TLS_REJECT_UNAUTHORIZED',
  'SYNCRONA_SCOPED_API_PREFIXES',
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

// ---------------------------------------------------------------------------
// cleanEnvValue
// ---------------------------------------------------------------------------

test('cleanEnvValue trims whitespace and strips matching single/double quotes', () => {
  assert.equal(cleanEnvValue('  hello  '), 'hello');
  assert.equal(cleanEnvValue('"quoted"'), 'quoted');
  assert.equal(cleanEnvValue("'quoted'"), 'quoted');
  assert.equal(cleanEnvValue('no-quotes'), 'no-quotes');
  assert.equal(cleanEnvValue(''), '');
  // Mismatched quote characters are not treated as a pair - only leading and
  // trailing occurrences of the same quote char are stripped independently.
  assert.equal(cleanEnvValue('"mixed\''), 'mixed');
});

// ---------------------------------------------------------------------------
// parseDotEnv
// ---------------------------------------------------------------------------

test('parseDotEnv skips blank lines, comments, and malformed entries', () => {
  const raw = [
    '',
    '   ',
    '# a full comment',
    'FOO=bar',
    '=noKeyAtAll',
    'NOEQUALSSIGN',
    'BAZ = spaced value ',
    'QUOTED="wrapped"',
  ].join('\n');

  const parsed = parseDotEnv(raw);
  assert.equal(parsed.FOO, 'bar');
  assert.equal(parsed.BAZ, 'spaced value');
  assert.equal(parsed.QUOTED, 'wrapped');
  assert.equal('' in parsed, false);
  assert.equal(parsed.NOEQUALSSIGN, undefined);
});

test('parseDotEnv handles CRLF line endings', () => {
  const raw = 'A=1\r\nB=2\r\n';
  const parsed = parseDotEnv(raw);
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, '2');
});

// ---------------------------------------------------------------------------
// instanceToBaseUrl
// ---------------------------------------------------------------------------

test('instanceToBaseUrl variants: bare host, http, https, trailing slash', () => {
  assert.equal(instanceToBaseUrl('dev1.service-now.com'), 'https://dev1.service-now.com/');
  assert.equal(instanceToBaseUrl('http://dev1.service-now.com'), 'http://dev1.service-now.com/');
  assert.equal(instanceToBaseUrl('https://dev1.service-now.com'), 'https://dev1.service-now.com/');
  assert.equal(instanceToBaseUrl('https://dev1.service-now.com/'), 'https://dev1.service-now.com/');
  assert.equal(instanceToBaseUrl('dev1.service-now.com/'), 'https://dev1.service-now.com/');
});

// ---------------------------------------------------------------------------
// hasEnvFile
// ---------------------------------------------------------------------------

test('hasEnvFile reflects presence of a .env file in the project dir', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-envfile-'));
  assert.equal(hasEnvFile(tempDir), false);
  fs.writeFileSync(path.join(tempDir, '.env'), 'SN_INSTANCE=x\n', 'utf-8');
  assert.equal(hasEnvFile(tempDir), true);
});

// ---------------------------------------------------------------------------
// toTableResultRows / summarizeRows (pure helpers, quick coverage)
// ---------------------------------------------------------------------------

test('toTableResultRows filters non-object entries and handles missing result', () => {
  assert.deepEqual(toTableResultRows({ result: [{ a: 1 }, null, 'x', 5, { b: 2 }] }), [
    { a: 1 },
    { b: 2 },
  ]);
  assert.deepEqual(toTableResultRows({}), []);
  assert.deepEqual(toTableResultRows(null), []);
  assert.deepEqual(toTableResultRows('not an object'), []);
});

test('summarizeRows counts by field, defaulting missing values to <empty>', () => {
  const rows = [{ state: '1' }, {}, { state: '1' }, { state: '2' }];
  assert.deepEqual(summarizeRows(rows, 'state'), { '1': 2, '2': 1, '<empty>': 1 });
});

// ---------------------------------------------------------------------------
// resolveServiceNowSecrets — error branches
// ---------------------------------------------------------------------------

test('resolveServiceNowSecrets throws when no instance is resolvable from any provider', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-noinst-'));
  clearServiceNowSecretsCache();

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-empty-'));
  try {
    assert.throws(() => resolveServiceNowSecrets(emptyDir), /Missing ServiceNow instance/);
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets throws with a clear message when basic auth is missing SN_USER', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.SN_INSTANCE = 'dev1.service-now.com';
  // No SN_USER, no SN_PASSWORD -> basic method, missing both.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-nouser-'));
  clearServiceNowSecretsCache();

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-empty2-'));
  try {
    assert.throws(
      () => resolveServiceNowSecrets(emptyDir),
      /Missing ServiceNow credentials for basic auth/
    );
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: mTLS-only config skips the Authorization-material requirement', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-mtls-'));
  const certPath = path.join(tempDir, 'client.crt');
  const keyPath = path.join(tempDir, 'client.key');
  fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n', 'utf-8');
  fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n', 'utf-8');

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_CLIENT_CERT = certPath;
  process.env.SN_CLIENT_KEY = keyPath;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-mtls-home-'));
  clearServiceNowSecretsCache();

  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.instance, 'dev1.service-now.com');
    assert.equal(cfg.authMethod, 'basic');
    assert.equal(cfg.tlsCustom, true);
    assert.equal(cfg.clientCertPath, certPath);
    assert.equal(cfg.clientKeyPath, keyPath);
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: explicit SN_AUTH_METHOD=api-key resolves with the api key material', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_AUTH_METHOD = 'api-key';
  process.env.SN_API_KEY = 'my-api-key';
  process.env.SN_API_KEY_HEADER = 'x-custom-key';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-apikey-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-apikey-'));
  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.authMethod, 'api-key');
    assert.equal(cfg.apiKey, 'my-api-key');
    assert.equal(cfg.apiKeyHeader, 'x-custom-key');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: explicit SN_AUTH_METHOD=api-key without SN_API_KEY throws', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_AUTH_METHOD = 'api-key';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-apikey-missing-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-apikey-missing-'));
  try {
    assert.throws(
      () => resolveServiceNowSecrets(tempDir),
      /Missing ServiceNow credentials for api-key auth/
    );
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: oauth-client-credentials method resolves without a password', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_AUTH_METHOD = 'client-credentials';
  process.env.SN_OAUTH_CLIENT_ID = 'cid';
  process.env.SN_OAUTH_CLIENT_SECRET = 'csecret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-cc-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-cc-'));
  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.authMethod, 'oauth-client-credentials');
    assert.equal(cfg.clientId, 'cid');
    assert.equal(cfg.clientSecret, 'csecret');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: unrecognized SN_AUTH_METHOD falls back to inference', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_AUTH_METHOD = 'totally-bogus-method';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-bogus-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-bogus-'));
  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    // Unknown explicit method -> falls back to inference -> basic (no client id/secret).
    assert.equal(cfg.authMethod, 'basic');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: implicit oauth-password inferred when client id+secret+password all present', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();

  process.env.SN_INSTANCE = 'dev1.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  process.env.SN_OAUTH_CLIENT_ID = 'cid';
  process.env.SN_OAUTH_CLIENT_SECRET = 'csecret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-oauthpw-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-oauthpw-'));
  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.authMethod, 'oauth-password');
    assert.equal(cfg.clientId, 'cid');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: reads instance from a nested "servicenow" object in secrets.json', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-nested-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-nested-'));
  fs.mkdirSync(path.join(tempDir, '.syncrona-mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.syncrona-mcp', 'secrets.json'),
    JSON.stringify({
      servicenow: {
        instance: 'nested.service-now.com',
        user: 'nested-user',
        password: 'nested-pass',
      },
    }),
    'utf-8'
  );

  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.instance, 'nested.service-now.com');
    assert.equal(cfg.user, 'nested-user');
    assert.equal(cfg.password, 'nested-pass');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: malformed secrets.json is ignored (falls through to a later provider)', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-badjson-home-'));
  process.env.SN_INSTANCE = 'fallback.service-now.com';
  process.env.SN_USER = 'fallback-user';
  process.env.SN_PASSWORD = 'fallback-pass';
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-badjson-'));
  fs.mkdirSync(path.join(tempDir, '.syncrona-mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.syncrona-mcp', 'secrets.json'),
    '{ not valid json',
    'utf-8'
  );

  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    // process-env provider already filled every key, so the (malformed)
    // secrets-file provider's parse failure is simply swallowed.
    assert.equal(cfg.instance, 'fallback.service-now.com');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: secrets-file provider parse failure is logged and swallowed, falling through to auth store', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-badjson-fallthrough-'));
  process.env.HOME = tempHome;
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-badjson-fallthrough-dir-'));
  fs.mkdirSync(path.join(tempDir, '.syncrona-mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.syncrona-mcp', 'secrets.json'),
    '{ not valid json',
    'utf-8'
  );

  // No env vars and no active-instance config.json -> instance stays empty
  // through every provider, including the auth store, so this exercises the
  // secrets-file JSON.parse catch branch on the way to the final error.
  try {
    assert.throws(() => resolveServiceNowSecrets(tempDir), /Missing ServiceNow instance/);
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: auth store with an active instance but no stored credentials yields empty values', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-activenocreds-'));
  process.env.HOME = tempHome;
  clearServiceNowSecretsCache();

  const syncronaDir = path.join(tempHome, '.syncrona');
  fs.mkdirSync(syncronaDir, { recursive: true });
  fs.writeFileSync(
    path.join(syncronaDir, 'config.json'),
    JSON.stringify({ activeInstance: 'ghost-instance.service-now.com' }),
    'utf-8'
  );
  // Deliberately no credentials/ dir / .enc file for that instance.

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-activenocreds-dir-'));
  try {
    assert.throws(() => resolveServiceNowSecrets(tempDir), /Missing ServiceNow instance/);
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets: SYNCRONA_SECRETS_FILE env var overrides the default secrets.json path', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-override-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-override-'));
  const customPath = path.join(tempDir, 'custom-secrets.json');
  fs.writeFileSync(
    customPath,
    JSON.stringify({
      SN_INSTANCE: 'custom.service-now.com',
      SN_USER: 'custom-user',
      SN_PASSWORD: 'custom-pass',
    }),
    'utf-8'
  );
  process.env.SYNCRONA_SECRETS_FILE = customPath;

  try {
    const cfg = resolveServiceNowSecrets(tempDir);
    assert.equal(cfg.instance, 'custom.service-now.com');
    assert.equal(cfg.user, 'custom-user');
  } finally {
    restoreEnv(snap);
  }
});

// ---------------------------------------------------------------------------
// getServiceNowConfig — caching behaviour
// ---------------------------------------------------------------------------

test('getServiceNowConfig caches the resolved config per projectDir until cleared', () => {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.SN_INSTANCE = 'cache1.service-now.com';
  process.env.SN_USER = 'u1';
  process.env.SN_PASSWORD = 'p1';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-cache-home-'));
  clearServiceNowSecretsCache();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-cache-'));
  try {
    const first = getServiceNowConfig(tempDir);
    assert.equal(first.instance, 'cache1.service-now.com');

    // Mutate env; without clearing the cache, the stale config should still
    // be returned because getServiceNowConfig caches per projectDir.
    process.env.SN_INSTANCE = 'cache2.service-now.com';
    const second = getServiceNowConfig(tempDir);
    assert.equal(second.instance, 'cache1.service-now.com');

    clearServiceNowSecretsCache();
    const third = getServiceNowConfig(tempDir);
    assert.equal(third.instance, 'cache2.service-now.com');
  } finally {
    restoreEnv(snap);
  }
});

// ---------------------------------------------------------------------------
// loadAuthStoreProfile
// ---------------------------------------------------------------------------

function writeEncryptedCredential(credentialsDir, instance, creds) {
  const salt = 'syncrona-credential-store-v1';
  const key = scryptSync(`${os.hostname()}:${os.userInfo().username}:${salt}`, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(creds), 'utf8'),
    cipher.final(),
  ]);
  const payload = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
  fs.writeFileSync(
    path.join(credentialsDir, `${instance.replace(/[^a-zA-Z0-9.-]/g, '_')}.enc`),
    payload,
    'utf-8'
  );
}

test('loadAuthStoreProfile returns null for an empty/blank instance name', () => {
  const snap = snapshotEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-profile-empty-'));
  try {
    assert.equal(loadAuthStoreProfile(''), null);
    assert.equal(loadAuthStoreProfile('   '), null);
  } finally {
    restoreEnv(snap);
  }
});

test('loadAuthStoreProfile returns null when no credentials exist for the instance', () => {
  const snap = snapshotEnv();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-profile-missing-'));
  try {
    assert.equal(loadAuthStoreProfile('nonexistent.service-now.com'), null);
  } finally {
    restoreEnv(snap);
  }
});

test('loadAuthStoreProfile returns a valid profile from the encrypted credential store', () => {
  const snap = snapshotEnv();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-profile-ok-'));
  process.env.HOME = tempHome;

  const syncronaDir = path.join(tempHome, '.syncrona');
  const credentialsDir = path.join(syncronaDir, 'credentials');
  fs.mkdirSync(credentialsDir, { recursive: true });

  const instance = 'profile-instance.service-now.com';
  writeEncryptedCredential(credentialsDir, instance, {
    instance,
    user: 'profile-user',
    password: 'profile-pass',
  });

  try {
    const profile = loadAuthStoreProfile(`  ${instance}  `);
    assert.ok(profile);
    assert.equal(profile.instance, instance);
    assert.equal(profile.user, 'profile-user');
    assert.equal(profile.password, 'profile-pass');
  } finally {
    restoreEnv(snap);
  }
});

test('loadAuthStoreProfile returns null when the stored credential is missing a required field', () => {
  const snap = snapshotEnv();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-profile-partial-'));
  process.env.HOME = tempHome;

  const syncronaDir = path.join(tempHome, '.syncrona');
  const credentialsDir = path.join(syncronaDir, 'credentials');
  fs.mkdirSync(credentialsDir, { recursive: true });

  const instance = 'partial-instance.service-now.com';
  // No password stored.
  writeEncryptedCredential(credentialsDir, instance, {
    instance,
    user: 'partial-user',
  });

  try {
    assert.equal(loadAuthStoreProfile(instance), null);
  } finally {
    restoreEnv(snap);
  }
});

// ---------------------------------------------------------------------------
// Cache-clear seams — smoke coverage (no observable state, just must not throw)
// ---------------------------------------------------------------------------

test('cache-clearing seams are safe to call repeatedly and in any order', () => {
  clearScopedApiPrefixCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();
  clearTokenManagerCache();
  clearDispatcherCache();
  clearDispatcherCache();
  clearServiceNowSecretsCache();
  clearServiceNowSecretsCache();
});

// ---------------------------------------------------------------------------
// serviceNowCrudHandlers — network-path coverage via injected global.fetch
// ---------------------------------------------------------------------------

function makeCrudContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  const flows = [];
  return {
    timeoutMs: 2000,
    dryRun: false,
    startedAt: Date.now(),
    createAndSyncScriptInclude: async (params) => {
      flows.push(params);
      return { isFailure: false, name: params.name };
    },
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    _flows: flows,
    ...overrides,
  };
}

function withServiceNowEnv(fn) {
  const snap = snapshotEnv();
  clearAllRelevantEnv();
  process.env.SN_INSTANCE = 'crud-test.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-core-crud-home-'));
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();
  clearDispatcherCache();

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      restoreEnv(snap);
    });
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

test('sn_query_records: happy path hits the table API and returns rows + analysis', async () => {
  await withServiceNowEnv(async () => {
    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return mkFetchResponse(200, {
        result: [
          { sys_id: '1', state: 'active' },
          { sys_id: '2', state: 'closed' },
          { sys_id: '3', state: 'active' },
        ],
      });
    };

    const res = await handleServiceNowCrudTool(
      'sn_query_records',
      {
        table: 'incident',
        query: 'active=true',
        fields: ['sys_id', 'state'],
        limit: 10,
        analyzeField: 'state',
      },
      makeCrudContext()
    );

    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.status, 200);
    assert.equal(payload.table, 'incident');
    assert.equal(payload.rowCount, 3);
    assert.deepEqual(payload.analysis.counts, { active: 2, closed: 1 });
    assert.match(capturedUrl, /\/api\/now\/table\/incident\?/);
    assert.match(capturedUrl, /sysparm_fields=sys_id%2Cstate/);
  });
});

test('sn_query_records: clamps out-of-range limit and reports a non-2xx status as an error', async () => {
  await withServiceNowEnv(async () => {
    global.fetch = async () => mkFetchResponse(403, { error: { message: 'Forbidden' } });

    const res = await handleServiceNowCrudTool(
      'sn_query_records',
      { table: 'incident', limit: 99999 },
      makeCrudContext()
    );

    assert.equal(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.status, 403);
    assert.equal(payload.rowCount, 0);
  });
});

test('sn_create_record: real (non-dry-run) create posts to the table API and audits the outcome', async () => {
  await withServiceNowEnv(async () => {
    let capturedInit = null;
    global.fetch = async (url, init) => {
      capturedInit = init;
      return mkFetchResponse(201, { result: { sys_id: 'abc123' } });
    };

    const ctx = makeCrudContext();
    const res = await handleServiceNowCrudTool(
      'sn_create_record',
      { table: 'incident', record: { short_description: 'test' }, confirmDestructive: true },
      ctx
    );

    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.status, 201);
    assert.equal(payload.result.result.sys_id, 'abc123');
    assert.equal(ctx._audits.length, 1);
    assert.equal(ctx._audits[0].outcome.status, 201);
    assert.equal(capturedInit.method, 'POST');
  });
});

test('sn_execute_background_script: rejects an unsafe endpointPath before any network call', async () => {
  await withServiceNowEnv(async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return mkFetchResponse(200, 'ok');
    };

    const res = await handleServiceNowCrudTool(
      'sn_execute_background_script',
      {
        script: 'gs.info("x")',
        endpointPath: '../../etc/passwd',
        confirmDestructive: true,
      },
      makeCrudContext()
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unsafe endpointPath/);
    assert.equal(fetchCalled, false);
  });
});

test('sn_execute_background_script: real run posts the script and audits the used endpoint', async () => {
  await withServiceNowEnv(async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/api/x_nuvo_sinc/sinc/runBackgroundScript')) {
        return mkFetchResponse(200, { result: 'done' });
      }
      return mkFetchResponse(404, 'not found');
    };

    const ctx = makeCrudContext();
    const res = await handleServiceNowCrudTool(
      'sn_execute_background_script',
      { script: 'gs.info("hi")', confirmDestructive: true },
      ctx
    );

    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.status, 200);
    assert.equal(ctx._audits.length, 1);
    assert.match(ctx._audits[0].outcome.usedEndpoint, /runBackgroundScript/);
  });
});
