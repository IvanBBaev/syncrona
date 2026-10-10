// SPDX-License-Identifier: GPL-3.0-or-later
// A process killed mid-append leaves metrics.jsonl ending in a partial line with no
// newline. The next append wrote its JSON straight onto that fragment, so the new sample
// shared one unparseable line with the torn one and was dropped on every later load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendMetricEvent, loadMetricEvents } = require('../dist/metricsStore.js');

test('a sample appended after a torn trailing line is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-torn-'));
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const first = { tool: 'a', ok: true, latencyMs: 1, timestamp: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(file, `${JSON.stringify(first)}\n{"tool":"b","ok":tr`, 'utf-8');

    const next = { tool: 'c', ok: false, latencyMs: 7, timestamp: '2026-01-01T00:00:01.000Z' };
    appendMetricEvent(dir, file, next);

    assert.deepEqual(
      loadMetricEvents(dir, file).map((event) => event.tool),
      ['a', 'c']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an append to a newline-terminated or empty file adds no blank line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-torn-'));
  try {
    const file = path.join(dir, 'metrics.jsonl');
    fs.writeFileSync(file, '', 'utf-8');
    const event = { tool: 'a', ok: true, latencyMs: 1, timestamp: '2026-01-01T00:00:00.000Z' };
    appendMetricEvent(dir, file, event);
    appendMetricEvent(dir, file, event);
    assert.equal(
      fs.readFileSync(file, 'utf-8'),
      `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
