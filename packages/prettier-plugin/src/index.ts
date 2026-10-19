// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin that formats a file with Prettier. Settings come from three
 * places, later ones winning: the file path (which selects the parser), the
 * project's Prettier configuration for that file, and the rule's options.
 */
import { Sync } from "@syncrona/types";
import prettier from "prettier";

async function formattingOptions(
  filePath: string,
  ruleOptions: prettier.Options | undefined
): Promise<prettier.Options> {
  const projectConfig = (await prettier.resolveConfig(filePath)) ?? {};
  return { filepath: filePath, ...projectConfig, ...ruleOptions };
}

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  options?: prettier.Options
): Promise<Sync.PluginResults> => {
  const settings = await formattingOptions(context.filePath, options);
  // An empty file stays empty; Prettier is not consulted for it.
  const output = content ? await prettier.format(content, settings) : "";
  return { success: true, output };
};
