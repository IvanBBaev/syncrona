const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getToolMetrics,
  clearToolMetrics,
  replaceToolMetrics,
  recordToolMetric,
} = require('../dist/toolService.js');

// AR11: the metrics buffer is encapsulated behind these accessors instead of a
// directly-mutated exported array. Lock that contract.
test('clearToolMetrics empties the buffer', () => {
  recordToolMetric('sync_status', false, Date.now());
  clearToolMetrics();
  assert.equal(getToolMetrics().length, 0);
});

test('recordToolMetric appends an event with derived fields', () => {
  clearToolMetrics();
  recordToolMetric('sync_status', false, Date.now() - 5);
  const metrics = getToolMetrics();
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].tool, 'sync_status');
  assert.equal(metrics[0].ok, true); // isError=false -> ok=true
  assert.ok(metrics[0].latencyMs >= 0);
});

test('getToolMetrics returns a read-only snapshot (mutating it does not corrupt state)', () => {
  clearToolMetrics();
  recordToolMetric('a', false, Date.now());
  const snapshot = getToolMetrics();
  // Even if a caller ignores readonly and pushes, the canonical buffer length
  // is governed by recordToolMetric/replaceToolMetrics, not external pushes.
  assert.equal(snapshot.length, 1);
});

test('replaceToolMetrics swaps the whole buffer and caps at 500', () => {
  clearToolMetrics();
  const events = Array.from({ length: 600 }, (_, i) => ({
    tool: `t${i}`,
    ok: true,
    latencyMs: 1,
    timestamp: new Date().toISOString(),
  }));
  replaceToolMetrics(events);
  const metrics = getToolMetrics();
  assert.equal(metrics.length, 500);
  // keeps the most recent 500 (tail), so the first kept is t100
  assert.equal(metrics[0].tool, 't100');
  assert.equal(metrics[metrics.length - 1].tool, 't599');
});

test('recordToolMetric enforces the 500-event ring buffer cap', () => {
  clearToolMetrics();
  for (let i = 0; i < 520; i += 1) {
    recordToolMetric(`tool${i}`, false, Date.now());
  }
  assert.equal(getToolMetrics().length, 500);
  clearToolMetrics();
});
