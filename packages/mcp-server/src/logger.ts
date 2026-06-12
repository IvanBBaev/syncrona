/**
 * stderr-only structured logger for the stdio MCP server.
 *
 * The MCP server speaks JSON-RPC over stdout, so log output MUST never be
 * written to stdout (that would corrupt the protocol stream). Every message is
 * written to stderr instead, which is safe for stdio transports.
 *
 * Configuration (read once at module load, overridable via configureLogger):
 *   - Level:  SYNCRONA_LOG_LEVEL = debug | info | warn | error | silent (default: info)
 *   - Format: SYNCRONA_LOG_FORMAT = text | json (default: text)
 *             or the CLI flag --log-format=json | --log-format json
 *
 * Structured fields (correlationId, tool, durationMs, ...) are appended as
 * key=value pairs in text mode, or merged into the JSON record in json mode.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";
export type LogFields = Record<string, unknown>;

type EmittableLevel = Exclude<LogLevel, "silent">;

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const DEFAULT_LEVEL: LogLevel = "info";
const DEFAULT_FORMAT: LogFormat = "text";

export function parseLogLevel(value: string | undefined | null): LogLevel {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }
  return DEFAULT_LEVEL;
}

export function parseLogFormat(
  value: string | undefined | null,
  argv: readonly string[] = []
): LogFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--log-format" && index + 1 < argv.length) {
      const next = String(argv[index + 1]).trim().toLowerCase();
      if (next === "json" || next === "text") {
        return next;
      }
    }
    const inlineMatch = /^--log-format=(.+)$/.exec(arg);
    if (inlineMatch) {
      const candidate = inlineMatch[1].trim().toLowerCase();
      if (candidate === "json" || candidate === "text") {
        return candidate;
      }
    }
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "json" || normalized === "text") {
    return normalized;
  }
  return DEFAULT_FORMAT;
}

let activeLevel: LogLevel = parseLogLevel(process.env.SYNCRONA_LOG_LEVEL);
let activeFormat: LogFormat = parseLogFormat(process.env.SYNCRONA_LOG_FORMAT, process.argv);

export function configureLogger(options: { level?: LogLevel; format?: LogFormat } = {}): void {
  if (options.level) {
    activeLevel = options.level;
  }
  if (options.format) {
    activeFormat = options.format;
  }
}

export function getLoggerConfig(): { level: LogLevel; format: LogFormat } {
  return { level: activeLevel, format: activeFormat };
}

function shouldLog(level: EmittableLevel): boolean {
  return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[activeLevel];
}

function renderFieldValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function formatTextFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${renderFieldValue(value)}`);
  }
  return parts.join(" ");
}

function emit(level: EmittableLevel, message: string, fields?: LogFields): void {
  if (!shouldLog(level)) {
    return;
  }
  const time = new Date().toISOString();
  if (activeFormat === "json") {
    const record: Record<string, unknown> = { level, time, message };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          record[key] = value;
        }
      }
    }
    process.stderr.write(`${JSON.stringify(record)}\n`);
    return;
  }
  const suffix = fields ? formatTextFields(fields) : "";
  process.stderr.write(`${time} ${level.toUpperCase()} ${message}${suffix ? ` ${suffix}` : ""}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => emit("debug", message, fields),
  info: (message: string, fields?: LogFields): void => emit("info", message, fields),
  warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
  error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};
