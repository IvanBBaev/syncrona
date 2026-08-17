// SPDX-License-Identifier: GPL-3.0-or-later
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import path from "path";

export type PersistedToolMetricEvent = {
  tool: string;
  ok: boolean;
  latencyMs: number;
  timestamp: string;
  correlationId?: string;
};

const DEFAULT_METRICS_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_METRICS_MAX_BACKUPS = 5;

// Delete the oldest rotated metrics backups so the directory stays bounded.
// Without this, every rotation leaves a timestamped file behind forever.
//
// Every fs call here is best-effort, and the two INNER catches are load-bearing rather
// than decorative (REV-213 pins both):
//   - an entry the OS refuses to `stat` is scored mtime 0, so it sorts to the END of the
//     newest-first order and is retired FIRST. Scoring it as newest instead would let one
//     broken entry hold a retention slot forever and the directory would grow unbounded,
//     which is the single thing this function exists to prevent.
//   - an entry that cannot be `unlink`ed is stepped over so the rest of the prune still
//     runs. Aborting on the first failure would let one stuck entry disable retention
//     permanently, and would propagate into `appendMetricEvent` and drop the sample.
//
// The OUTER catch is the opposite case and is deliberately left uncovered: defensive, not
// reachable by any input. `path.dirname/extname/basename`, the filter/map/sort and
// `Array.slice` cannot throw for a string argument, so `readdirSync(dir)` is the only
// statement it can ever receive from — and the sole caller reaches here immediately after
// `renameSync(metricsFile, ...)` succeeded, which already proves `dir` is a writable
// directory. What is left is genuinely ambient (the directory removed between the rename
// and the listing, EMFILE/ENFILE under fd pressure, a read bit stripped concurrently), so
// a test could only simulate one of those rather than pin a contract.
function pruneRotatedMetricsFiles(
  metricsFile: string,
  maxBackups: number
): void {
  try {
    const dir = path.dirname(metricsFile);
    const ext = path.extname(metricsFile);
    const base = path.basename(metricsFile, ext);
    const prefix = `${base}.`;
    const active = `${base}${ext}`;
    const rotated = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext) && name !== active)
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch (_) {
          mtimeMs = 0;
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of rotated.slice(maxBackups)) {
      try {
        unlinkSync(stale.full);
      } catch (_) {
        // best-effort prune
      }
    }
  } catch (_) {
    // Unreachable by input (see the header note); never let cleanup break a write.
  }
}

// `metrics.jsonl` -> `metrics.<stamp>.jsonl`, the name a size rotation retires the file
// under. Structurally identical to `toRotatedAuditPath`/`toCorruptAuditPath` in audit.ts,
// and closed here for the same reason (REV-213 follows REV-205): the retired file is named
// after the instant it was retired, so retiring the same file twice inside one millisecond
// produces the same name twice, and the `renameSync` below the call would land the second
// rotation on top of the first — discarding samples nothing else holds a copy of. The
// `while` loop is the only thing between that collision and the loss.
//
// `now` is a parameter rather than an embedded `new Date()` because with the clock inside,
// whether the collision arm ran was decided by machine speed rather than by any assertion:
// the only thing reaching it was `appendMetricEvent(dir, file, e, 1, 1)` called four times
// in a row by the prune test, which collides on an idle host and does not under load. That
// is exactly the shape that made `dist/audit.js` report two different percentages for one
// unchanged tree. Production still calls the one-argument form; only tests pass an instant.
export function toRotatedMetricsPath(metricsFile: string, now: Date = new Date()): string {
  const dir = path.dirname(metricsFile);
  const ext = path.extname(metricsFile);
  const base = path.basename(metricsFile, ext);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
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
  maxBytes: number = DEFAULT_METRICS_MAX_BYTES,
  maxBackups: number = DEFAULT_METRICS_MAX_BACKUPS
): void {
  try {
    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    if (existsSync(metricsFile) && statSync(metricsFile).size >= maxBytes) {
      renameSync(metricsFile, toRotatedMetricsPath(metricsFile));
      pruneRotatedMetricsFiles(metricsFile, maxBackups);
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
