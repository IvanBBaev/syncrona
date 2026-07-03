// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
import prettier from "prettier";
const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  content: string,
  options: prettier.Options
): Promise<Sync.PluginResults> {
  let output = "";
  const prettierConfig = await prettier.resolveConfig(context.filePath);
  let opts: prettier.Options = { filepath: context.filePath };
  if (prettierConfig) {
    opts = Object.assign(opts, prettierConfig);
  }
  opts = Object.assign(opts, options);
  if (content) {
    output = await prettier.format(content, opts);
  }
  return {
    success: true,
    output
  };
};

export { run };
