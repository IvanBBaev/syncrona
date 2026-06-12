export type ToolMetricEvent = {
  tool: string;
  ok: boolean;
  latencyMs: number;
  timestamp: string;
  correlationId?: string;
};

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
    const avgLatencyMs =
      total === 0 ? 0 : slice.reduce((sum, e) => sum + e.latencyMs, 0) / total;

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
  const byTool: Record<string, { total: number; ok: number; error: number; avgLatencyMs: number }> = {};

  for (const ev of events) {
    if (!byTool[ev.tool]) {
      byTool[ev.tool] = { total: 0, ok: 0, error: 0, avgLatencyMs: 0 };
    }
    const item = byTool[ev.tool];
    item.total += 1;
    if (ev.ok) {
      item.ok += 1;
    } else {
      item.error += 1;
    }
    item.avgLatencyMs = ((item.avgLatencyMs * (item.total - 1)) + ev.latencyMs) / item.total;
  }

  return {
    tools: byTool,
    timeline: events.slice(-50),
    windows: summarizeMetricsWindows(events.slice(-200), 20),
  };
}
