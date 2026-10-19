// SPDX-License-Identifier: GPL-3.0-or-later
//
// runBackgroundScript opens a UI session for sys.scripts.do. For token-based
// auth methods the Bearer token must be resolved BEFORE the abort timer is
// armed: a slow token acquisition (short-lived token in the 30s expiry-skew
// window, or an LRU-evicted token manager) would otherwise consume the whole
// timeout budget, and the page requests would reject on an already-aborted
// signal without ever being sent. snRequestWithConfig follows the same rule.
// These tests pin that ordering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runBackgroundScript,
  clearServiceNowSecretsCache,
  clearTokenManagerCache,
  clearDispatcherCache,
} = require('../dist/servicenowCore.js');
const { FORM_HTML, scriptResultHtml } = require('./scriptsBackgroundFetchMock.cjs');

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
  process.env.SN_AUTH_METHOD = 'oauth-client-credentials';
  process.env.SN_OAUTH_CLIENT_ID = 'client-id';
  process.env.SN_OAUTH_CLIENT_SECRET = 'client-secret';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-home-'));
  clearServiceNowSecretsCache();
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

function scriptsPage(url, init, onDispatch, postDelayMs) {
  if (init && init.signal && init.signal.aborted) {
    return Promise.reject(abortError());
  }
  onDispatch();
  if (String(init && init.method).toUpperCase() === 'GET') {
    return Promise.resolve(mkResponse(200, FORM_HTML));
  }
  const answer = mkResponse(200, scriptResultHtml('*** Script: ok'));
  return postDelayMs ? respondAfter(postDelayMs, answer, init && init.signal) : Promise.resolve(answer);
}

// Runs first: the next test jumps Date.now() forward, which pushes the
// request pacer's next slot into the future for the rest of this file.
test('sys.scripts.do session: the timeout still aborts a slow request itself', async () => {
  await withOAuthEnv(async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-proj2-'));
    const timeoutMs = 250;
    let scriptsDoDispatched = false;

    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('oauth_token.do')) {
        return mkResponse(200, JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      if (u.includes('sys.scripts.do')) {
        return scriptsPage(
          url,
          init,
          () => {
            scriptsDoDispatched = true;
          },
          1200
        );
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    await assert.rejects(
      runBackgroundScript('gs.info(1);', timeoutMs, undefined, projectDir),
      (err) => err && err.name === 'AbortError'
    );
    assert.equal(scriptsDoDispatched, true);
  });
});

test('sys.scripts.do session: a slow token refresh must not consume the request timeout budget', async (t) => {
  // The first token is cached for half its 20s lifetime; the clock jumps past
  // that after the first run, so the second run's getToken() goes back to the
  // network and takes longer than the whole request timeout.
  let skewMs = 0;
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + skewMs);
  await withOAuthEnv(async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-abort-order-proj-'));
    const timeoutMs = 250;
    const tokenDelayMs = 600;
    let tokenCalls = 0;
    let pageRequests = 0;
    const authHeaders = [];

    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('oauth_token.do')) {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return mkResponse(200, JSON.stringify({ access_token: 'tok-1', expires_in: 20 }));
        }
        return respondAfter(
          tokenDelayMs,
          mkResponse(200, JSON.stringify({ access_token: 'tok-2', expires_in: 3600 })),
          init && init.signal
        );
      }
      if (u.includes('sys.scripts.do')) {
        authHeaders.push(init.headers.Authorization);
        return scriptsPage(url, init, () => {
          pageRequests += 1;
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    const first = await runBackgroundScript('gs.info(1);', timeoutMs, undefined, projectDir);
    assert.equal(first.status, 200);
    skewMs += 15000;
    const result = await runBackgroundScript('gs.info(1);', timeoutMs, undefined, projectDir);

    assert.equal(tokenCalls, 2);
    assert.equal(pageRequests, 4);
    assert.deepEqual(authHeaders, ['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
    assert.equal(result.usedEndpoint, '/sys.scripts.do');
    assert.equal(result.status, 200);
    assert.equal(result.text, '*** Script: ok');
  });
});
