const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { snRequestWithConfig } = require('../dist/servicenowCore.js');

// G1: the MCP server authenticates with OAuth 2.0 Bearer when an OAuth client is
// configured (SN_OAUTH_CLIENT_ID/SECRET), and falls back to Basic otherwise.
// instanceToBaseUrl preserves an http:// prefix, so we can drive the real fetch
// path against a local mock instance.

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

test('uses OAuth Bearer (and hits the token endpoint) when a client is configured', async () => {
  const seen = [];
  let tokenHits = 0;
  const { server, base } = await startServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url.endsWith('oauth_token.do')) {
      tokenHits += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'tok-1', refresh_token: 'r-1', expires_in: 1800 }));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = {
      instance: base, // http:// preserved by instanceToBaseUrl
      user: 'u',
      password: 'p',
      clientId: 'cid-bearer',
      clientSecret: 'secret',
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    assert.ok(tokenHits >= 1, 'token endpoint should be hit');
    const apiCall = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.ok(apiCall, 'api call recorded');
    assert.equal(apiCall.auth, 'Bearer tok-1');
    assert.ok(!seen.some((s) => s.url.includes('/api/') && s.auth.startsWith('Basic ')));
  } finally {
    await close(server);
  }
});

test('falls back to Basic auth when no OAuth client is configured', async () => {
  const seen = [];
  const { server, base } = await startServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });

  try {
    const config = { instance: base, user: 'u', password: 'p' }; // no clientId/secret
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    const apiCall = seen.find((s) => s.url.includes('/api/now/table/incident'));
    assert.ok(apiCall.auth.startsWith('Basic '), 'should use Basic auth');
    assert.ok(!seen.some((s) => s.url.endsWith('oauth_token.do')), 'token endpoint not hit');
  } finally {
    await close(server);
  }
});

test('refreshes the token once on a 401 and retries', async () => {
  const seen = [];
  let tokenHits = 0;
  let apiHits = 0;
  const { server, base } = await startServer((req, res) => {
    if (req.url.endsWith('oauth_token.do')) {
      tokenHits += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({ access_token: `tok-${tokenHits}`, refresh_token: 'r-1', expires_in: 1800 })
      );
    }
    apiHits += 1;
    seen.push(req.headers.authorization || '');
    if (apiHits === 1) {
      res.statusCode = 401;
      return res.end('unauthorized');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [{ ok: true }] }));
  });

  try {
    const config = {
      instance: base,
      user: 'u',
      password: 'p',
      clientId: 'cid-401',
      clientSecret: 'secret',
    };
    const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
    assert.equal(out.status, 200);
    assert.equal(apiHits, 2, 'API hit twice (401 then retry)');
    assert.equal(tokenHits, 2, 'token acquired then refreshed');
    assert.equal(seen[0], 'Bearer tok-1');
    assert.equal(seen[1], 'Bearer tok-2');
  } finally {
    await close(server);
  }
});
