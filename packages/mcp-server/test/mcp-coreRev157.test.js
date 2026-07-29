// SPDX-License-Identifier: GPL-3.0-or-later
// REV-157 — the MCP server must use the credential store's password verbatim.
// loadFromAuthStore / loadAuthStoreProfile used to push it through
// cleanEnvValue() (`value.trim().replace(/^['"]|['"]$/g, "")`) — dotenv unquoting
// semantics applied to a secret that never came from a .env file — and
// resolveServiceNowSecrets re-cleaned every merged candidate on top. The store
// deliberately keeps secrets byte-for-byte (normalizeStoredCredentials: "Do not
// coerce/trim secrets") and the core CLI reads them untouched, so a password with
// a trailing space or a surrounding quote authenticated fine from the CLI while
// every MCP tool call 401'd with nothing naming the transformation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveServiceNowSecrets,
  loadAuthStoreProfile,
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');
const {
  saveCredentials,
  setActiveInstance,
  clearStoreKeyCache,
} = require('@syncrona/credential-store');

// Passwords a generator can legitimately produce and `syncrona login` stores
// byte-for-byte: a trailing space, and a value wrapped in quote characters.
const TRAILING_SPACE_PASSWORD = 'Xk9!vQ2 ';
const QUOTED_PASSWORD = '"s3cret"';

const ENV_KEYS = [
  'SN_INSTANCE',
  'SN_USER',
  'SN_PASSWORD',
  'SYNCRONA_SECRETS_FILE',
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-rev157-home-'));
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

test('loadAuthStoreProfile keeps a stored password with a trailing space verbatim (REV-157)', async () => {
  const snap = snapshotEnv();
  try {
    withIsolatedStore();
    const instance = 'rev157a.service-now.com';
    await saveCredentials(instance, 'admin', TRAILING_SPACE_PASSWORD);

    const profile = loadAuthStoreProfile(instance);
    assert.ok(profile, 'the stored profile must load');
    assert.equal(
      profile.password,
      TRAILING_SPACE_PASSWORD,
      'the trailing space is part of the secret and must not be trimmed'
    );
  } finally {
    restoreEnv(snap);
  }
});

test('loadAuthStoreProfile does not strip quote characters from a stored password (REV-157)', async () => {
  const snap = snapshotEnv();
  try {
    withIsolatedStore();
    const instance = 'rev157b.service-now.com';
    await saveCredentials(instance, 'admin', QUOTED_PASSWORD);

    const profile = loadAuthStoreProfile(instance);
    assert.ok(profile, 'the stored profile must load');
    assert.equal(
      profile.password,
      QUOTED_PASSWORD,
      'surrounding quotes are secret bytes here, not dotenv quoting'
    );
    // The identifier fields keep their dotenv-style cleanup.
    assert.equal(profile.instance, instance);
    assert.equal(profile.user, 'admin');
  } finally {
    restoreEnv(snap);
  }
});

test('resolveServiceNowSecrets passes the auth-store password through untouched (REV-157)', async () => {
  const snap = snapshotEnv();
  try {
    const home = withIsolatedStore();
    const instance = 'rev157c.service-now.com';
    await saveCredentials(instance, 'admin', TRAILING_SPACE_PASSWORD);
    await setActiveInstance(instance);

    // No process env, no secrets file, no .env: the auth store is the only
    // provider that can answer, exercising the real merge loop.
    const projectDir = fs.mkdtempSync(path.join(home, 'project-'));
    clearServiceNowSecretsCache();
    const config = resolveServiceNowSecrets(projectDir);

    assert.equal(config.instance, instance);
    assert.equal(config.user, 'admin');
    assert.equal(
      config.password,
      TRAILING_SPACE_PASSWORD,
      'the merge loop must not re-clean a store-origin secret'
    );
  } finally {
    restoreEnv(snap);
  }
});

test('a whitespace-only password still counts as absent (REV-157 presence semantics)', () => {
  const snap = snapshotEnv();
  try {
    withIsolatedStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-rev157-blank-'));
    clearServiceNowSecretsCache();

    // Dropping cleanEnvValue must not turn "   " into a usable credential:
    // presence is still judged on the trimmed form.
    assert.throws(
      () =>
        resolveServiceNowSecrets(projectDir, [
          {
            name: 'blank',
            load: () => ({
              SN_INSTANCE: 'rev157d.service-now.com',
              SN_USER: 'admin',
              SN_PASSWORD: '   ',
            }),
          },
        ]),
      /Missing ServiceNow credentials/
    );
  } finally {
    restoreEnv(snap);
  }
});
