// SPDX-License-Identifier: GPL-3.0-or-later
// A metric event whose latencyMs is not a finite number must not turn the
// latency aggregates into NaN; it is left out of the average.
const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeMetrics, summarizeMetricsWindows } = require('../dist/analysis/metrics.js');

const events = [
  { tool: 'sn_query', ok: true, latencyMs: 100, timestamp: '2026-01-01T00:00:00Z' },
  { tool: 'sn_query', ok: false, latencyMs: 'slow', timestamp: '2026-01-01T00:00:01Z' },
  { tool: 'sn_query', ok: true, latencyMs: Number.NaN, timestamp: '2026-01-01T00:00:02Z' },
  { tool: 'sn_query', ok: true, latencyMs: 300, timestamp: '2026-01-01T00:00:03Z' },
];

test('per-tool average latency ignores non-finite values', () => {
  const summary = summarizeMetrics(events);
  const item = summary.tools.sn_query;
  assert.equal(item.total, 4);
  assert.equal(item.error, 1);
  assert.equal(item.avgLatencyMs, 200);
});

test('window average latency ignores non-finite values', () => {
  const [window] = summarizeMetricsWindows(events, 20);
  assert.equal(window.total, 4);
  assert.equal(window.avgLatencyMs, 200);
});

test('a window with no finite latency averages to zero', () => {
  const [window] = summarizeMetricsWindows([events[1]], 20);
  assert.equal(window.avgLatencyMs, 0);
});
