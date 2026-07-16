// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { ESLint } from "eslint";

const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  content: string,
): Promise<Sync.PluginResults> {
  const output = content;
  const linter = new ESLint({});
  // Lint the in-memory `content` handed down the plugin pipeline, not the raw
  // bytes on disk. In a transform-then-lint chain an earlier plugin may have
  // rewritten the source, and re-reading context.filePath would validate the
  // stale on-disk copy instead. The filePath is still supplied so ESLint
  // resolves the right config/overrides for the file. Mirrors how the
  // prettier and typescript plugins operate on `content`.
  const results = await linter.lintText(content, {
    filePath: context.filePath,
  });

  const isSuccess = results.every((r) => r.errorCount === 0);
  if (!isSuccess) {
    // Surface the lint report through the plugin contract (the thrown error)
    // instead of writing to stdout: in MCP stdio mode stdout is the protocol
    // channel, so printing there corrupts the stream. Mirrors how the
    // typescript-plugin reports diagnostics.
    const formatter = await linter.loadFormatter();
    const format_result = formatter.format(results);
    const format_result_string = typeof format_result === 'string' ? format_result : await format_result;
    throw new Error(`ESLint errors in the code\n${format_result_string}`);
  }
  return {
    success: isSuccess,
    output
  };
};

export { run };