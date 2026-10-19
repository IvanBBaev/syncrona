// SPDX-License-Identifier: GPL-3.0-or-later
export type ToolMetricEvent = {
  tool: string;
  ok: boolean;
  latencyMs: number;
  timestamp: string;
  correlationId?: string;
};

// A latency that is not a finite number (missing, a string, NaN) carries no
// timing information; averaging it in would turn the whole aggregate into NaN.
function isFiniteLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function computeMetricTrend(
  previousWindow: Record<string, unknown>,
  currentWindow: Record<string, unknown>
): Record<string, unknown> {
  const prevFailure = typeof previousWindow.failureRatio === "number" ? previousWindow.failureRatio : 0;
  const curFailure = typeof currentWindow.failureRatio === "number" ? currentWindow.failureRatio : 0;
  const prevLatency = typeof previousWindow.avgLatencyMs === "number" ? previousWindow.avgLatencyMs : 0;
  const curLatency = typeof currentWindow.avgLatencyMs === "number" ? currentWindow.avgLatencyMs : 0;

  return {
    failureRatioDelta: curFailure - prevFailure,
    avgLatencyDeltaMs: curLatency - prevLatency,
  };
}

export function pruneMetricsOlderThan(
  events: ToolMetricEvent[],
  cutoffIso: string
): ToolMetricEvent[] {
  const cutoff = Date.parse(cutoffIso);
  if (Number.isNaN(cutoff)) {
    return [...events];
  }

  return events.filter((ev) => {
    const ts = Date.parse(ev.timestamp);
    return !Number.isNaN(ts) && ts >= cutoff;
  });
}

export function summarizeMetricsWindows(
  events: ToolMetricEvent[],
  windowSize: number = 20
): Array<Record<string, unknown>> {
  const size = Math.max(windowSize, 1);
  const windows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < events.length; i += size) {
    const slice = events.slice(i, i + size);
    const total = slice.length;
    const ok = slice.filter((e) => e.ok).length;
    const error = total - ok;
    const latencies = slice.map((e) => e.latencyMs).filter(isFiniteLatency);
    const avgLatencyMs =
      latencies.length === 0 ? 0 : latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;

    windows.push({
      start: slice[0]?.timestamp || "",
      end: slice[slice.length - 1]?.timestamp || "",
      total,
      ok,
      error,
      failureRatio: total === 0 ? 0 : error / total,
      avgLatencyMs,
    });
  }

  return windows;
}

export function summarizeMetrics(events: ToolMetricEvent[]): Record<string, unknown> {
  // Keyed by Map, not a plain object: the tool name is whatever the client sent,
  // and `__proto__` / `constructor` as a plain-object key would resolve to a
  // prototype and have the counters below written onto Object.prototype.
  const byTool = new Map<string, { total: number; ok: number; error: number; avgLatencyMs: number }>();
  const latencySamples = new Map<string, number>();

  for (const ev of events) {
    let item = byTool.get(ev.tool);
    if (!item) {
      item = { total: 0, ok: 0, error: 0, avgLatencyMs: 0 };
      byTool.set(ev.tool, item);
    }
    item.total += 1;
    if (ev.ok) {
      item.ok += 1;
    } else {
      item.error += 1;
    }
    if (isFiniteLatency(ev.latencyMs)) {
      const samples = (latencySamples.get(ev.tool) ?? 0) + 1;
      latencySamples.set(ev.tool, samples);
      item.avgLatencyMs = ((item.avgLatencyMs * (samples - 1)) + ev.latencyMs) / samples;
    }
  }

  return {
    // Object.fromEntries defines own properties, so a `__proto__` entry stays data.
    tools: Object.fromEntries(byTool),
    timeline: events.slice(-50),
    windows: summarizeMetricsWindows(events.slice(-200), 20),
  };
}
