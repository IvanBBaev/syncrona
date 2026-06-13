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
  constructor() {
    this.logger = winston.createLogger(this.genLoggerOpts());
  }
  setLogLevel(level: string) {
    this.logger = winston.createLogger(this.genLoggerOpts(level));
  }

  getLogLevel() {
    return this.logger.level;
  }

  private genLoggerOpts(level: string = "info"): winston.LoggerOptions {
    const loggerTransports: winston.transport[] = [new transports.Console()];
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
