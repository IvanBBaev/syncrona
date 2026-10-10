// SPDX-License-Identifier: GPL-3.0-or-later
// The health endpoint's close() is awaited by the graceful shutdown AFTER the drain, so
// it is the last thing between SIGTERM and process exit. http.Server#close only stops
// accepting: it waits for every open connection to end, and since Node 19 it drops idle
// keep-alive sockets but NOT a socket in the middle of a request. A client that sends a
// partial request and goes quiet therefore held close() open until the server's header
// timeout fired, stalling the exit past any drain bound.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { startHealthHttpServer } = require('../dist/healthServer.js');

const config = { enabled: true, port: 0, host: '127.0.0.1', path: '/healthz' };

test('close() resolves while a client holds a partial request open', async () => {
  const health = await startHealthHttpServer(config, () => ({ status: 'ok' }), () => {});
  const socket = net.connect(health.port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  // Headers never terminated: the connection is mid-request, not idle.
  socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
  await new Promise((resolve) => setTimeout(resolve, 100));

  let timer;
  const outcome = await Promise.race([
    health.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('stalled'), 2000);
    }),
  ]);
  clearTimeout(timer);
  socket.destroy();
  if (outcome === 'stalled') {
    health.server.closeAllConnections();
  }
  assert.equal(outcome, 'closed');
});

test('close() still lets a completed health request get its response first', async () => {
  const health = await startHealthHttpServer(config, () => ({ status: 'ok' }), () => {});
  const response = await fetch(health.url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  await health.close();
  assert.equal(health.server.listening, false);
});
