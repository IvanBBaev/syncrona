// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin that runs Babel over a file with the rule's options (presets,
 * plugins, and so on). Babel is told the file is named after the record field
 * it fills (`script.js`), which is what file-name-based config matching sees.
 */
import { Sync } from "@syncrona/types";
import * as babel from "@babel/core";

export async function run(
  context: Sync.FileContext,
  content: string,
  options: babel.InputOptions
): Promise<Sync.PluginResults> {
  // The same options object serves every file of a build, so it is copied
  // rather than given this file's name; a rule without options passes undefined.
  const fileOptions: babel.InputOptions = {
    ...options,
    filename: `${context.targetField}${context.ext}`
  };
  const result = await babel.transformAsync(content, fileOptions);
  // No result at all (an ignored file) fails; empty code is a valid result.
  const code = result?.code;
  return typeof code === "string"
    ? { success: true, output: code }
    : { success: false, output: "" };
}
