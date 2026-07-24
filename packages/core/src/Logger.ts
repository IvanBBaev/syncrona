// SPDX-License-Identifier: GPL-3.0-or-later
import winston, { format, transports } from "winston";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { getSyncronaDir } from "@syncrona/credential-store";

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

// winston drops EVERY line — errors included — when handed a level it does not
// know: its write guard compares `levels[configured] >= levels[message]`, and an
// unknown level resolves to `undefined`, which loses every comparison. A typo
// like `--log-level warning` would therefore mute the whole command instead of
// making it louder. The CLI rejects bad values up front via yargs `choices`, but
// Logger is also driven programmatically, so clamp defensively here as well.
function normalizeLogLevel(level: string): string {
  return LOG_LEVELS.includes(level) ? level : "info";
}

function diagnosticFileTransport(): winston.transport | null {
  if (!isDiagnosticLogEnabled()) {
    return null;
  }
  try {
    const dir = path.join(getSyncronaDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    return new transports.File({
      filename: path.join(dir, "cli.log"),
      maxsize: 1_000_000,
      maxFiles: 3,
      format: format.combine(
        format.uncolorize(),
        format.timestamp(),
        format.printf((info) => `${info.timestamp} ${info.level} ${info.message}`)
      ),
    });
  } catch (_) {
    // Diagnostic logging is best-effort — never block the CLI on it.
    return null;
  }
}

class SyncLogger {
  private logger: winston.Logger;
  // Sticky: a command whose stdout may become an MCP stdio protocol channel
  // (e.g. `syncrona mcp`) needs every console line on stderr, permanently.
  private allToStderr = false;
  constructor() {
    this.logger = winston.createLogger(this.genLoggerOpts());
  }
  setLogLevel(level: string) {
    const normalized = normalizeLogLevel(level);
    this.logger = winston.createLogger(this.genLoggerOpts(normalized));
    if (normalized !== level) {
      this.warn(
        `Unknown log level "${level}" — falling back to "${normalized}". Valid levels: ${LOG_LEVELS.join(", ")}.`
      );
    }
  }

  getLogLevel() {
    return this.logger.level;
  }

  // Route every console level to stderr from now on. The flag is sticky and
  // genLoggerOpts() consults it, so later setLogLevel() rebuilds keep the routing.
  routeAllToStderr() {
    this.allToStderr = true;
    this.setLogLevel(this.getLogLevel());
  }

  // True once routeAllToStderr() has engaged, i.e. stdout is a machine protocol
  // channel (MCP stdio / shell-completion). Consumers that hand a raw `console`
  // to evaluated user code (e.g. the sync.config.js loader) use this to route
  // that console to stderr too, so config-side stdout writes can't corrupt it.
  isRoutedToStderr(): boolean {
    return this.allToStderr;
  }

  private genLoggerOpts(level: string = "info"): winston.LoggerOptions {
    // POSIX stream convention: warn/error are diagnostics and go to stderr, so
    // stdout carries only real command output (pipeable commands like
    // `syncrona completion` must not be polluted — winston's Console transport
    // sends every level to stdout by default). Lives here so setLogLevel(),
    // which rebuilds the logger from these options, keeps the routing.
    // With allToStderr set, EVERY configured level goes to stderr; derive the
    // list from the level set winston actually runs with (createLogger without
    // a `levels` option uses winston.config.npm.levels) — never hand-maintain it.
    const stderrLevels = this.allToStderr
      ? Object.keys(winston.config.npm.levels)
      : ["warn", "error"];
    const loggerTransports: winston.transport[] = [
      new transports.Console({ stderrLevels }),
    ];
    const fileTransport = diagnosticFileTransport();
    if (fileTransport) {
      loggerTransports.push(fileTransport);
    }
    return {
      format: format.printf(info => {
        return `${info.message}`;
      }),
      level,
      transports: loggerTransports
    };
  }

  info(text: string) {
    this.logger.info(chalk.blue(text));
  }

  error(text: string) {
    this.logger.error(chalk.red(text));
  }

  warn(text: string) {
    this.logger.warn(chalk.yellow(text));
  }

  success(text: string) {
    this.logger.info(chalk.green(text));
  }

  verbose(text: string) {
    this.logger.verbose(text);
  }

  debug(text: string) {
    this.logger.debug(text);
  }

  silly(text: string) {
    this.logger.silly(text);
  }

  getInternalLogger() {
    return this.logger;
  }
}
const loggerInst = new SyncLogger();
export { loggerInst as logger };
