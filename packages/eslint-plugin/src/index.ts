// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin that lints a file with ESLint and fails the build on errors.
 *
 * The piped `content` is linted (an earlier plugin may have changed it), with
 * `filePath` passed only so ESLint picks the configuration for that file. With
 * `fix: true` among the rule options the fixed text becomes the output.
 * Problems are reported in the thrown error, never on stdout: in MCP stdio mode
 * stdout carries the protocol.
 */
import { Sync } from "@syncrona/types";
import { ESLint } from "eslint";

async function lintReport(linter: ESLint, results: ESLint.LintResult[]): Promise<string> {
  const formatter = await linter.loadFormatter();
  // Some formatters are synchronous, others return a promise.
  return await formatter.format(results);
}

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  options?: ESLint.Options
): Promise<Sync.PluginResults> => {
  // A copy, so the linter never keeps or changes the rule's shared options;
  // a rule without options passes undefined.
  const linter = new ESLint({ ...options });
  const results = await linter.lintText(content, { filePath: context.filePath });
  if (results.some(result => result.errorCount > 0)) {
    throw new Error(`ESLint errors in the code\n${await lintReport(linter, results)}`);
  }
  // `output` is only set when a fix changed the text, and an ignored file has
  // no result at all; either way the content passes through unchanged.
  return { success: true, output: results[0]?.output ?? content };
};
