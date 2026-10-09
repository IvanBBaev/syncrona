// SPDX-License-Identifier: GPL-3.0-or-later
//
// ERR-1: the request retry loop must be idempotency-aware. A non-idempotent
// write (POST/PATCH) may only be re-sent when we can prove it never reached the
// instance (a pre-send network error). It must NOT be replayed on a retryable
// 5xx (the write may have committed before the error) nor on a client-side
// timeout abort (the server may still be executing it). Idempotent methods
// (GET/HEAD/OPTIONS) retry on any transient failure as before.
const test = require('node:test');
const assert = require('node:assert/strict');

const servicenowCore = require('../dist/servicenowCore.js');
const {
  snRequest,
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
  clearTokenManagerCache,
} = servicenowCore;

const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function mkResponse(status, payload) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function withEnv(vars, fn) {
  const keys = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD', 'SN_AUTH_METHOD'];
  const old = {};
  for (const key of keys) {
    old[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key];
      }
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
      clearTokenManagerCache();
    });
}

const BASIC_ENV = {
  SN_INSTANCE: 'dev123.service-now.com',
  SN_USER: 'admin',
  SN_PASSWORD: 'secret',
};

test('POST is NOT re-sent on a retryable 500 (write may have committed)', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return mkResponse(500, { error: { message: 'server error' } });
    };
    const res = await snRequest('POST', '/api/now/table/incident', { x: 1 }, 5000);
    assert.equal(res.status, 500);
    assert.equal(calls, 1, 'a non-idempotent POST must be sent exactly once');
  });
});

test('GET IS retried 3× on a retryable 500 (safe to replay)', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return mkResponse(500, { error: { message: 'server error' } });
    };
    const res = await snRequest('GET', '/api/now/table/incident', undefined, 5000);
    assert.equal(res.status, 500);
    assert.equal(calls, 3, 'an idempotent GET retries up to MAX_REQUEST_ATTEMPTS');
  });
});

test('POST is NOT re-sent after a client-side timeout abort', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(
      snRequest('POST', '/api/now/table/incident', { x: 1 }, 5000)
    );
    assert.equal(calls, 1, 'an aborted POST must not be replayed');
  });
});

test('POST IS retried on a pre-send ECONNREFUSED (never reached the server)', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      // undici shape: a TypeError whose .cause carries the syscall code.
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    };
    await assert.rejects(
      snRequest('POST', '/api/now/table/incident', { x: 1 }, 5000)
    );
    assert.equal(calls, 3, 'a pre-send connection failure is safe to retry');
  });
});

// Review round 8, finding 2: `retryTransient: false` sends each request once,
// like core's axios client, so a caller with its own retry loop (sync_cicd_run's
// poll) owns every retry. The OAuth 401 refresh is not a transient retry and
// stays.
const { snRequestWithConfig } = servicenowCore;
const BASIC_CONFIG = { instance: 'dev123.service-now.com', user: 'admin', password: 'secret' };
const OAUTH_CONFIG = { ...BASIC_CONFIG, clientId: 'cid-once', clientSecret: 'secret' };
const NO_RETRY = { retryTransient: false };
const resetError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

test('retryTransient: false sends a GET once on a retryable 503', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return mkResponse(503, 'Service Unavailable');
    };
    const res = await snRequestWithConfig(BASIC_CONFIG, 'GET', 'api/sn_cicd/progress/p', undefined, 5000, NO_RETRY);
    assert.equal(res.status, 503);
    assert.equal(calls, 1);
  });
});

test('retryTransient: false does not re-send a GET after a network error', async () => {
  await withEnv(BASIC_ENV, async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw resetError();
    };
    await assert.rejects(
      snRequestWithConfig(BASIC_CONFIG, 'GET', 'api/sn_cicd/progress/p', undefined, 5000, NO_RETRY),
      /fetch failed/
    );
    assert.equal(calls, 1);
  });
});

test('retryTransient: false does not retry a failed OAuth token fetch', async () => {
  await withEnv(BASIC_ENV, async () => {
    let apiCalls = 0;
    let tokenCalls = 0;
    global.fetch = async (input) => {
      if (String(input).endsWith('oauth_token.do')) {
        tokenCalls += 1;
        throw resetError();
      }
      apiCalls += 1;
      return mkResponse(200, { result: {} });
    };
    await assert.rejects(
      snRequestWithConfig(OAUTH_CONFIG, 'GET', 'api/sn_cicd/progress/p', undefined, 5000, NO_RETRY)
    );
    const once = tokenCalls;
    clearTokenManagerCache();
    tokenCalls = 0;
    await assert.rejects(snRequestWithConfig(OAUTH_CONFIG, 'GET', 'api/sn_cicd/progress/p', undefined, 5000));
    assert.equal(apiCalls, 0);
    assert.ok(once >= 1);
    assert.equal(tokenCalls, once * 3, 'the default retries the token fetch per attempt; false tries it once');
  });
});

test('retryTransient: false still refreshes an OAuth token once on a 401', async () => {
  await withEnv(BASIC_ENV, async () => {
    let apiCalls = 0;
    let tokenCalls = 0;
    global.fetch = async (input) => {
      if (String(input).endsWith('oauth_token.do')) {
        tokenCalls += 1;
        const token = { access_token: `tok-${tokenCalls}`, refresh_token: 'r', expires_in: 1800 };
        return { ...mkResponse(200, token), ok: true };
      }
      apiCalls += 1;
      return apiCalls === 1 ? mkResponse(401, 'unauthorized') : mkResponse(200, { result: { ok: true } });
    };
    const res = await snRequestWithConfig(OAUTH_CONFIG, 'GET', 'api/sn_cicd/progress/p', undefined, 5000, NO_RETRY);
    assert.equal(res.status, 200);
    assert.equal(apiCalls, 2);
  });
});
