// SPDX-License-Identifier: GPL-3.0-or-later
// G9 — the MCP fetch client must honour corporate proxy variables. getDispatcher
// now takes an explicit env object and returns an undici EnvHttpProxyAgent when
// HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy carries a non-empty URL,
// composing with (and taking precedence over) the pre-existing mTLS / custom-CA
// Agent path. These tests lock down dispatcher selection (undefined vs Agent vs
// EnvHttpProxyAgent), env precedence sampling, empty-string and NO_PROXY-only
// handling, and cache keying: the proxy value participates in the cache key, so
// a proxy change must not keep serving a direct-connection Agent (and vice
// versa). Env objects are always passed explicitly — process.env is never
// mutated — so the suite stays parallel-safe. No live handshake happens: undici
// parses TLS material lazily on first connect, so fake PEM fixtures are fine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Agent, EnvHttpProxyAgent } = require('undici');

const {
  getDispatcher,
  clearDispatcherCache,
  clearTokenManagerCache,
  getCacheStatsForTest,
} = require('../dist/servicenowCore.js');

const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n';

const PROXY_URL = 'http://proxy.corp:8080';

// Temp dirs created by mkMtlsFixture, removed once at the end of the file.
const fixtureDirs = [];

function mkMtlsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-proxy-'));
  fixtureDirs.push(dir);
  const certPath = path.join(dir, 'client.crt');
  const keyPath = path.join(dir, 'client.key');
  fs.writeFileSync(certPath, FAKE_CERT, 'utf-8');
  fs.writeFileSync(keyPath, FAKE_KEY, 'utf-8');
  return { dir, certPath, keyPath };
}

function mkTlsConfig() {
  const { certPath, keyPath } = mkMtlsFixture();
  return {
    tlsCustom: true,
    clientCertPath: certPath,
    clientKeyPath: keyPath,
    rejectUnauthorized: true,
  };
}

function mkPlainConfig() {
  return {
    instance: 'dev00000.service-now.com',
    user: 'admin',
    password: 'secret',
  };
}

test.beforeEach(() => {
  clearDispatcherCache();
  clearTokenManagerCache();
});

test.after(() => {
  clearDispatcherCache();
  for (const dir of fixtureDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDispatcher returns undefined for a plain config with an explicitly empty env', () => {
  // The env object is passed explicitly, so the result must be undefined even
  // if the ambient process.env of the test runner happens to carry proxy vars.
  const dispatcher = getDispatcher(mkPlainConfig(), {});
  assert.strictEqual(dispatcher, undefined);
});

test('getDispatcher returns a plain Agent (not a proxy agent) for a tlsCustom config with an empty env', () => {
  const dispatcher = getDispatcher(mkTlsConfig(), {});
  assert.ok(dispatcher instanceof Agent, 'tlsCustom without proxy vars must yield an undici Agent');
  assert.ok(
    !(dispatcher instanceof EnvHttpProxyAgent),
    'no proxy vars means no EnvHttpProxyAgent'
  );
});

test('HTTPS_PROXY selects an EnvHttpProxyAgent for a plain config', () => {
  const dispatcher = getDispatcher(mkPlainConfig(), { HTTPS_PROXY: PROXY_URL });
  assert.ok(dispatcher instanceof EnvHttpProxyAgent);
});

test('lowercase https_proxy selects an EnvHttpProxyAgent for a plain config', () => {
  const dispatcher = getDispatcher(mkPlainConfig(), { https_proxy: PROXY_URL });
  assert.ok(dispatcher instanceof EnvHttpProxyAgent);
});

test('HTTP_PROXY selects an EnvHttpProxyAgent for a plain config', () => {
  const dispatcher = getDispatcher(mkPlainConfig(), { HTTP_PROXY: PROXY_URL });
  assert.ok(dispatcher instanceof EnvHttpProxyAgent);
});

test('lowercase http_proxy selects an EnvHttpProxyAgent for a plain config', () => {
  const dispatcher = getDispatcher(mkPlainConfig(), { http_proxy: PROXY_URL });
  assert.ok(dispatcher instanceof EnvHttpProxyAgent);
});

test('a proxied tlsCustom config yields an EnvHttpProxyAgent (proxy composes with mTLS material)', () => {
  const dispatcher = getDispatcher(mkTlsConfig(), { HTTPS_PROXY: PROXY_URL });
  assert.ok(
    dispatcher instanceof EnvHttpProxyAgent,
    'a proxy URL must win over the direct mTLS Agent path'
  );
});

test('NO_PROXY alone (no proxy URL) leaves a plain config without a dispatcher', () => {
  const dispatcher = getDispatcher(mkPlainConfig(), {
    NO_PROXY: 'internal.example.com',
  });
  assert.strictEqual(dispatcher, undefined);
});

test('NO_PROXY alone (no proxy URL) keeps the plain Agent path for a tlsCustom config', () => {
  const dispatcher = getDispatcher(mkTlsConfig(), {
    NO_PROXY: 'internal.example.com',
  });
  assert.ok(dispatcher instanceof Agent);
  assert.ok(!(dispatcher instanceof EnvHttpProxyAgent));
});

test('an empty-string proxy variable counts as unset', () => {
  assert.strictEqual(getDispatcher(mkPlainConfig(), { HTTPS_PROXY: '' }), undefined);
  const tlsDispatcher = getDispatcher(mkTlsConfig(), { HTTPS_PROXY: '' });
  assert.ok(tlsDispatcher instanceof Agent);
  assert.ok(!(tlsDispatcher instanceof EnvHttpProxyAgent));
});

test('same config and same env values reuse the cached EnvHttpProxyAgent', () => {
  const config = mkPlainConfig();
  // Two distinct env object literals with equal values must still hit the cache:
  // the key is derived from the values, not the object identity.
  const first = getDispatcher(config, { HTTPS_PROXY: PROXY_URL });
  const second = getDispatcher(config, { HTTPS_PROXY: PROXY_URL });
  assert.ok(first instanceof EnvHttpProxyAgent);
  assert.strictEqual(second, first, 'a repeated call must reuse the cached dispatcher');
  assert.strictEqual(getCacheStatsForTest().dispatchers, 1);
});

test('a changed proxy URL builds a different dispatcher (proxy value is part of the cache key)', () => {
  const config = mkPlainConfig();
  const first = getDispatcher(config, { HTTPS_PROXY: 'http://a:1' });
  const second = getDispatcher(config, { HTTPS_PROXY: 'http://b:2' });
  assert.ok(first instanceof EnvHttpProxyAgent);
  assert.ok(second instanceof EnvHttpProxyAgent);
  assert.notStrictEqual(second, first, 'a different proxy URL must not reuse the old dispatcher');
  assert.strictEqual(getCacheStatsForTest().dispatchers, 2);
});

test('the same tlsCustom config gets distinct dispatchers with and without a proxy', () => {
  const config = mkTlsConfig();
  const direct = getDispatcher(config, {});
  const proxied = getDispatcher(config, { HTTPS_PROXY: PROXY_URL });
  assert.ok(direct instanceof Agent);
  assert.ok(!(direct instanceof EnvHttpProxyAgent));
  assert.ok(proxied instanceof EnvHttpProxyAgent);
  assert.notStrictEqual(
    proxied,
    direct,
    'gaining a proxy must not keep serving the cached direct-connection Agent'
  );
});

test('clearDispatcherCache resets the stats and the next call builds a fresh instance', () => {
  const config = mkPlainConfig();
  const before = getDispatcher(config, { HTTPS_PROXY: PROXY_URL });
  assert.ok(before instanceof EnvHttpProxyAgent);
  assert.strictEqual(getCacheStatsForTest().dispatchers, 1);

  clearDispatcherCache();
  assert.strictEqual(getCacheStatsForTest().dispatchers, 0);

  const after = getDispatcher(config, { HTTPS_PROXY: PROXY_URL });
  assert.ok(after instanceof EnvHttpProxyAgent);
  assert.notStrictEqual(after, before, 'a cleared cache must rebuild the dispatcher');
  assert.strictEqual(getCacheStatsForTest().dispatchers, 1);
});

test('getCacheStatsForTest keeps its full shape (tokenManagers / dispatchers / caps)', () => {
  const stats = getCacheStatsForTest();
  assert.strictEqual(typeof stats.tokenManagers, 'number');
  assert.strictEqual(typeof stats.dispatchers, 'number');
  assert.strictEqual(typeof stats.maxTokenManagers, 'number');
  assert.strictEqual(typeof stats.maxDispatchers, 'number');
  assert.ok(stats.maxDispatchers > 0);
});
