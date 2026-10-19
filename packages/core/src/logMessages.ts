// SPDX-License-Identifier: GPL-3.0-or-later
// Console presentation for the push / build / watch flows. Every function here
// only formats and writes; none of them decides anything.
import { Sync } from "@syncrona/types";
import { logger } from "./Logger.js";
import chalk from "chalk";

const RULE = "-".repeat(60);

const heading = (text: string): string => chalk.bold.blue(text);

export function scopeCheckMessage(scopeCheck: Sync.ScopeCheckResult): void {
  const session = chalk.blue(scopeCheck.sessionScope);
  const project = chalk.blue(scopeCheck.manifestScope);
  logger.error(
    `The session scope is ${session}, but this project is bound to the ${project} scope. ` +
      "Switch the session to that scope in ServiceNow and run the command again."
  );
}

export function devModeLog(): void {
  const stopHint = chalk.red("Ctrl-C stops it");
  logger.info(`Dev mode started — watching for file changes (${stopHint}).\n`);
}

/** Per-file report printed by watch mode after each push. */
export function logFilePush(context: Sync.FileContext, res: Sync.PushResult): void {
  const status = res.success
    ? chalk.green("Pushed")
    : chalk.red("Failed to push");
  const rows: Array<[string, string]> = [
    ["When", new Date().toLocaleTimeString()],
    ["Table", context.tableName],
    ["Record", context.name],
    ["Field", context.targetField],
    ["Status", status],
  ];

  logger.info(chalk.underline("File Push Summary"));
  for (const [name, value] of rows) {
    logger.info(`${heading(`${name}:\t`)}${value}`);
  }
  if (!res.success) {
    logger.error(res.message);
  }
  logger.info("");
}

type OperationResult = Sync.PushResult | Sync.BuildResult;

// Totals go through the raw winston logger (no blanket colour), the failure
// banner through the facade's red error channel, and the individual failure
// messages raw again so their own formatting survives.
function reportOperation(results: OperationResult[], operation: string): void {
  const sink = logger.getInternalLogger();
  const failures = results.filter((result) => !result.success);
  const succeeded = results.length - failures.length;

  sink.info(`${heading("Total Records:")} ${results.length}`);
  sink.info(`${heading(`Successful ${operation}:`)} ${chalk.bold.green(String(succeeded))}`);
  sink.info(`${heading(`Failed ${operation}:`)} ${chalk.bold.red(String(failures.length))}`);

  if (failures.length > 0) {
    logger.error(RULE);
    logger.error(chalk.bold.red("Error Summary"));
    logger.error(RULE);
    // A lone failure is printed bare; numbering only helps when there are several.
    const lines =
      failures.length === 1
        ? [failures[0].message]
        : failures.map((failure, index) => `${index + 1}. ${failure.message}`);
    lines.forEach((line) => sink.error(line));
  }
}

export const logPushResults = (results: Sync.PushResult[]): void =>
  reportOperation(results, "Pushes");

export const logBuildResults = (results: Sync.BuildResult[]): void =>
  reportOperation(results, "Builds");
