// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin that compiles Sass to CSS. The piped `content` is compiled, not
 * the file on disk, since an earlier plugin may have rewritten it; the file's
 * URL is still given so relative `@use`/`@import` resolve from its directory
 * and errors point at the real file.
 */
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { Sync } from "@syncrona/types";
import sass from "sass";

/** `.sass` files use the indented syntax; everything else is SCSS. */
function syntaxOf(filePath: string): sass.Syntax {
  return extname(filePath) === ".sass" ? "indented" : "scss";
}

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  _options: unknown
): Promise<Sync.PluginResults> => {
  const { css } = sass.compileString(content, {
    syntax: syntaxOf(context.filePath),
    url: pathToFileURL(context.filePath)
  });
  return { success: true, output: css };
};
