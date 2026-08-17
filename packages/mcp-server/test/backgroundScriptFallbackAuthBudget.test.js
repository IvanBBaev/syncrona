// SPDX-License-Identifier: GPL-3.0-or-later
//
// Seventh-wave re-exam of the refuted servicenowCore.ts:1130 finding: in the
// runBackgroundScript sys.scripts.do fallback, the abort timer used to be armed
// BEFORE the OAuth token await. A slow token acquisition (short-lived token in
// the 30s expiry-skew window, or an LRU-evicted token manager) then consumed
// the whole timeout budget, the timer aborted the controller, and the fallback
// fetch rejected on an already-aborted signal without the request ever being
// sent. snRequestWithConfig was fixed for exactly this ordering; the fallback
// had not been. These tests pin the corrected ordering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runBackgroundScript,
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
  clearTokenManagerCache,
  clearDispatcherCache,
} = require('../dist/servicenowCore.js');

const ENV_KEYS = [
  'SN_INSTANCE',
  'SN_USER',
  'SN_PASSWORD',
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
  'SN_CA_BUNDLE',
  'SN_CLIENT_CERT',
  'SN_CLIENT_KEY',
  'SN_CLIENT_KEY_PASSPHRASE',
  'SN_TLS_REJECT_UNAUTHORIZED',
  'SYNCRONA_SECRETS_FILE',
  'SYNCRONA_SCOPED_API_PREFIXES',
  'HOME',
] ;

const REAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_FETCH;
});

function withOAuthEnv(fn) {
  const snap = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SN_INSTANCE = 'abort-order-test.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  process.env.SN_OAUTH_CLIENT_ID = 'client-id';
  process.env.SN_OAUTH_CLIENT_SECRET = 'client-secret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-home-'));
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();
  clearDispatcherCache();

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (snap[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = snap[key];
        }
      }
      clearServiceNowSecretsCache();
      clearTokenManagerCache();
      clearDispatcherCache();
    });
}

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

function mkResponse(status, bodyText) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

// Emulates the WHATWG fetch abort contract that real undici enforces: reject
// immediately when handed an already-aborted signal (the request is never
// dispatched), and reject mid-flight when the signal fires during the delay.
function respondAfter(delayMs, response, signal) {
  if (signal && signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(response);
    }, delayMs);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

test('sys.scripts.do fallback: a slow token refresh must not consume the request timeout budget', async () => {
  await withOAuthEnv(async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-proj-'));
    const timeoutMs = 250;
    const tokenDelayMs = 600;
    let tokenCalls = 0;
    let scriptsDoDispatched = false;

    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('oauth_token.do')) {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          // expires_in 20s sits inside the token manager's 30s expiry skew, so
          // the fallback's getToken() is forced back onto the network — the
          // exact condition under which the old timer ordering aborted the
          // request before it was sent.
          return mkResponse(200, JSON.stringify({ access_token: 'tok-1', expires_in: 20 }));
        }
        return respondAfter(
          tokenDelayMs,
          mkResponse(200, JSON.stringify({ access_token: 'tok-2', expires_in: 3600 })),
          init && init.signal
        );
      }
      if (u.includes('/api/x_custom/run')) {
        return mkResponse(404, JSON.stringify({ error: { message: 'Not found' } }));
      }
      if (u.includes('sys.scripts.do')) {
        if (init && init.signal && init.signal.aborted) {
          return Promise.reject(abortError());
        }
        scriptsDoDispatched = true;
        return mkResponse(200, '*** Script: ok');
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    const result = await runBackgroundScript('gs.info(1);', timeoutMs, 'api/x_custom/run', projectDir);

    assert.equal(tokenCalls, 2);
    assert.equal(scriptsDoDispatched, true);
    assert.equal(result.usedEndpoint, '/sys.scripts.do');
    assert.equal(result.status, 200);
    assert.equal(result.text, '*** Script: ok');
  });
});

test('sys.scripts.do fallback: the timeout still aborts a slow request itself', async () => {
  await withOAuthEnv(async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-proj2-'));
    const timeoutMs = 250;
    let scriptsDoDispatched = false;

    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('oauth_token.do')) {
        // Long-lived token: the fallback's getToken() is a warm cache hit, so
        // the whole budget belongs to the sys.scripts.do request below.
        return mkResponse(200, JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      if (u.includes('/api/x_custom/run')) {
        return mkResponse(404, JSON.stringify({ error: { message: 'Not found' } }));
      }
      if (u.includes('sys.scripts.do')) {
        if (init && init.signal && init.signal.aborted) {
          return Promise.reject(abortError());
        }
        scriptsDoDispatched = true;
        return respondAfter(1200, mkResponse(200, '*** Script: late'), init && init.signal);
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    await assert.rejects(
      runBackgroundScript('gs.info(1);', timeoutMs, 'api/x_custom/run', projectDir),
      (err) => err && err.name === 'AbortError'
    );
    assert.equal(scriptsDoDispatched, true);
  });
});
