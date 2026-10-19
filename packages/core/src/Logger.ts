// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import path from "path";
import { getSyncronaDir } from "@syncrona/credential-store";
import chalk from "chalk";
import winston, { format, transports } from "winston";

// G7: opt-in local diagnostic log. Off by default (privacy); enable with
// SYNCRONA_DIAGNOSTIC_LOG=1 to append CLI output to ~/.syncrona/logs/cli.log
// for support/diagnostics. It inherits the same content the console shows (the
// codebase masks credentials), with rotation to bound size.
export function isDiagnosticLogEnabled(): boolean {
  const raw = String(process.env.SYNCRONA_DIAGNOSTIC_LOG || "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no";
}

// The level set winston actually runs with: createLogger without an explicit
// `levels` option uses winston.config.npm.levels. Derived, never hand-listed, so
// the CLI's accepted values cannot drift behind a winston level-set change.
export const LOG_LEVELS: string[] = Object.keys(winston.config.npm.levels);

const FALLBACK_LEVEL = "info";

// Diagnostics (warn/error) go to stderr so stdout carries only real command
// output; pipeable commands such as `syncrona completion` stay clean.
const DIAGNOSTIC_LEVELS = ["warn", "error"];

const DIAGNOSTIC_LOG_MAX_BYTES = 1_000_000;
const DIAGNOSTIC_LOG_MAX_FILES = 3;

// winston drops EVERY line — errors included — when handed a level it does not
// know: its write guard compares `levels[configured] >= levels[message]`, and an
// unknown level resolves to `undefined`, which loses every comparison. A typo
// like `--log-level warning` would therefore mute the whole command instead of
// making it louder. The CLI rejects bad values up front via yargs `choices`, but
// Logger is also driven programmatically, so clamp defensively here as well.
function normalizeLogLevel(level: string): string {
  return LOG_LEVELS.includes(level) ? level : FALLBACK_LEVEL;
}

function diagnosticFileTransport(): winston.transport | null {
  if (!isDiagnosticLogEnabled()) {
    return null;
  }
  try {
    // The log carries whatever the console showed (instance URLs, record
    // names, user names), so it is private to the user, like the credential
    // store: the directories this creates are 0700 and the file is 0600.
    const dir = path.join(getSyncronaDir(), "logs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new transports.File({
      filename: path.join(dir, "cli.log"),
      options: { flags: "a", mode: 0o600 },
      maxsize: DIAGNOSTIC_LOG_MAX_BYTES,
      maxFiles: DIAGNOSTIC_LOG_MAX_FILES,
      format: format.combine(
        format.uncolorize(),
        format.timestamp(),
        format.printf((entry) => `${entry.timestamp} ${entry.level} ${entry.message}`)
      ),
    });
  } catch (_) {
    // Diagnostic logging is best-effort — never block the CLI on it.
    return null;
  }
}

// Builds a winston instance for one level. The console prints the bare message
// (colour is applied by the caller); `everythingToStderr` moves every level off
// stdout for commands whose stdout is a machine protocol channel.
function buildWinston(level: string, everythingToStderr: boolean): winston.Logger {
  const consoleSink = new transports.Console({
    stderrLevels: everythingToStderr ? [...LOG_LEVELS] : DIAGNOSTIC_LEVELS,
  });
  const fileSink = diagnosticFileTransport();
  return winston.createLogger({
    level,
    format: format.printf((entry) => String(entry.message)),
    transports: fileSink ? [consoleSink, fileSink] : [consoleSink],
  });
}

type Paint = (text: string) => string;

/**
 * The CLI-wide logger: a thin, colour-aware facade over a winston instance that
 * is rebuilt whenever the level or the stream routing changes.
 */
class CliLogger {
  private sink: winston.Logger;
  // Sticky: a command whose stdout may become an MCP stdio protocol channel
  // (e.g. `syncrona mcp`) needs every console line on stderr, permanently.
  private stderrOnly = false;

  constructor() {
    this.sink = buildWinston(FALLBACK_LEVEL, this.stderrOnly);
  }

  setLogLevel(level: string): void {
    const effective = normalizeLogLevel(level);
    this.sink = buildWinston(effective, this.stderrOnly);
    if (effective !== level) {
      this.warn(
        `Unknown log level "${level}" — falling back to "${effective}". Valid levels: ${LOG_LEVELS.join(", ")}.`
      );
    }
  }

  getLogLevel(): string {
    return this.sink.level;
  }

  // Route every console level to stderr from now on. The flag is sticky and
  // every rebuild consults it, so later setLogLevel() calls keep the routing.
  routeAllToStderr(): void {
    this.stderrOnly = true;
    this.setLogLevel(this.getLogLevel());
  }

  // True once routeAllToStderr() has engaged, i.e. stdout is a machine protocol
  // channel (MCP stdio / shell-completion). Consumers that hand a raw `console`
  // to evaluated user code (e.g. the sync.config.js loader) use this to route
  // that console to stderr too, so config-side stdout writes can't corrupt it.
  isRoutedToStderr(): boolean {
    return this.stderrOnly;
  }

  info(text: string): void {
    this.emit("info", text, chalk.blue);
  }

  success(text: string): void {
    this.emit("info", text, chalk.green);
  }

  warn(text: string): void {
    this.emit("warn", text, chalk.yellow);
  }

  error(text: string): void {
    this.emit("error", text, chalk.red);
  }

  verbose(text: string): void {
    this.emit("verbose", text);
  }

  debug(text: string): void {
    this.emit("debug", text);
  }

  silly(text: string): void {
    this.emit("silly", text);
  }

  getInternalLogger(): winston.Logger {
    return this.sink;
  }

  // Calls the level method (not winston's generic `log`) so tests that spy on
  // `getInternalLogger().verbose` and friends observe the forwarded line.
  private emit(
    level: "info" | "warn" | "error" | "verbose" | "debug" | "silly",
    text: string,
    paint?: Paint
  ): void {
    this.sink[level](paint ? paint(text) : text);
  }
}

const cliLogger = new CliLogger();
export { cliLogger as logger };
