// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import sass from "sass";
const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  _content: string,
  _options: unknown
): Promise<Sync.PluginResults> {
  const res = sass.compile(context.filePath);
  return {
    output: res.css,
    success: true
  };
};

export { run };
