'use strict';
// SN_MAX_RPS lowers the MCP server's request-rate cap (it can never raise it
// above the shared MAX_REQUESTS_PER_SECOND). The interval is resolved per
// request, so these tests set the env before each call.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { snRequestWithConfig, clearTokenManagerCache } = require('../dist/servicenowCore.js');

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

function withMaxRps(value, fn) {
  const original = process.env.SN_MAX_RPS;
  process.env.SN_MAX_RPS = value;
  return fn().finally(() => {
    if (original === undefined) {
      delete process.env.SN_MAX_RPS;
    } else {
      process.env.SN_MAX_RPS = original;
    }
  });
}

test('SN_MAX_RPS=2 spaces consecutive requests by about 500ms', async () => {
  clearTokenManagerCache();
  const arrivals = [];
  const { server, base } = await startServer((req, res) => {
    arrivals.push(Date.now());
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });
  const config = { instance: base, user: 'u', password: 'p' };
  try {
    await withMaxRps('2', async () => {
      for (let i = 0; i < 3; i += 1) {
        const out = await snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000);
        assert.equal(out.status, 200);
      }
    });
    assert.equal(arrivals.length, 3);
    // Two 500ms gaps. Arrivals are stamped server-side, after connection setup,
    // so the first one can land late; 900ms still sits far above the default
    // cap's ~100ms spread.
    assert.ok(arrivals[2] - arrivals[0] >= 900, `spread was ${arrivals[2] - arrivals[0]}ms`);
  } finally {
    await close(server);
  }
});

test('an invalid SN_MAX_RPS rejects the request before anything is sent', async () => {
  clearTokenManagerCache();
  let hits = 0;
  const { server, base } = await startServer((req, res) => {
    hits += 1;
    res.end('{}');
  });
  const config = { instance: base, user: 'u', password: 'p' };
  try {
    for (const bad of ['0', '21', 'fast']) {
      await withMaxRps(bad, () =>
        assert.rejects(
          snRequestWithConfig(config, 'GET', 'api/now/table/incident', undefined, 5000),
          /SN_MAX_RPS must be a whole number from 1 to 20/
        )
      );
    }
    assert.equal(hits, 0);
  } finally {
    await close(server);
  }
});
