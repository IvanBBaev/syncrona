// SPDX-License-Identifier: GPL-3.0-or-later
// The tool name in a metric event is whatever the MCP client sent. A name that
// collides with an Object.prototype key must be counted as an ordinary tool and
// must never write the counters onto Object.prototype.
const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeMetrics } = require('../dist/analysis/metrics.js');

test('summarizeMetrics counts prototype-named tools without polluting Object.prototype', () => {
  const events = ['__proto__', 'constructor', 'toString', '__proto__'].map((tool, index) => ({
    tool,
    ok: index !== 1,
    latencyMs: 10 * (index + 1),
    timestamp: `2026-01-01T00:00:0${index}Z`,
  }));
  const summary = summarizeMetrics(events);
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'total'), false);
    assert.equal(({}).total, undefined);
    assert.deepEqual(Object.keys(summary.tools).sort(), ['__proto__', 'constructor', 'toString']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(summary.tools, '__proto__').value, {
      total: 2,
      ok: 2,
      error: 0,
      avgLatencyMs: 25,
    });
    assert.equal(summary.tools.constructor.error, 1);
    assert.equal(summary.tools.toString.avgLatencyMs, 30);
  } finally {
    for (const key of ['total', 'ok', 'error', 'avgLatencyMs']) {
      delete Object.prototype[key];
      delete Function.prototype[key];
      delete Object[key];
    }
  }
});
