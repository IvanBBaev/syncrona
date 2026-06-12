import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import path from "path";

export type PersistedToolMetricEvent = {
  tool: string;
  ok: boolean;
  latencyMs: number;
  timestamp: string;
  correlationId?: string;
};

const DEFAULT_METRICS_MAX_BYTES = 5 * 1024 * 1024;

function toRotatedMetricsPath(metricsFile: string): string {
  const dir = path.dirname(metricsFile);
  const ext = path.extname(metricsFile);
  const base = path.basename(metricsFile, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(dir, `${base}.${stamp}${ext}`);
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(dir, `${base}.${stamp}.${suffix}${ext}`);
  }
  return candidate;
}

function parseMetricLine(line: string): PersistedToolMetricEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const tool = typeof parsed.tool === "string" ? parsed.tool : "";
    const ok = parsed.ok === true;
    const latencyMs = typeof parsed.latencyMs === "number" ? Math.max(parsed.latencyMs, 0) : 0;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    const correlationId = typeof parsed.correlationId === "string" ? parsed.correlationId : "";
    if (!tool || !timestamp) {
      return null;
    }
    const event: PersistedToolMetricEvent = {
      tool,
      ok,
      latencyMs,
      timestamp,
    };
    if (correlationId.trim()) {
      event.correlationId = correlationId.trim();
    }
    return event;
  } catch (_) {
    return null;
  }
}

export function appendMetricEvent(
  metricsDir: string,
  metricsFile: string,
  event: PersistedToolMetricEvent,
  maxBytes: number = DEFAULT_METRICS_MAX_BYTES
): void {
  try {
    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    if (existsSync(metricsFile) && statSync(metricsFile).size >= maxBytes) {
      renameSync(metricsFile, toRotatedMetricsPath(metricsFile));
    }

    appendFileSync(metricsFile, `${JSON.stringify(event)}\n`, "utf-8");
  } catch (_) {
    // Best-effort persistence to keep runtime behavior stable.
  }
}

export function loadMetricEvents(
  metricsDir: string,
  metricsFile: string,
  maxItems: number = 500
): PersistedToolMetricEvent[] {
  try {
    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    if (!existsSync(metricsFile)) {
      return [];
    }

    const raw = readFileSync(metricsFile, "utf-8");
    const parsed = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseMetricLine)
      .filter((item): item is PersistedToolMetricEvent => item !== null);

    const safeLimit = Math.min(Math.max(maxItems, 1), 5000);
    if (parsed.length <= safeLimit) {
      return parsed;
    }

    return parsed.slice(parsed.length - safeLimit);
  } catch (_) {
    return [];
  }
}
