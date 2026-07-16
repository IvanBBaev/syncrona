// SPDX-License-Identifier: GPL-3.0-or-later
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { Sync } from "@syncrona/types";
import sass from "sass";
const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  content: string,
  _options: unknown
): Promise<Sync.PluginResults> {
  // Compile the `content` handed down the plugin pipeline, not the raw bytes on
  // disk. In a transform-then-compile chain an earlier plugin may have rewritten
  // the source, and `sass.compile(context.filePath)` would re-read the stale
  // on-disk copy instead. Passing `url` as the file: URL keeps the two things
  // `compile` gave us for free: the default filesystem importer still resolves
  // relative `@use`/`@import` against the file's directory, and error/source-map
  // locations still point at the real path. Syntax follows the extension the way
  // `compile` auto-detected it (`.sass` is the indented syntax; else SCSS).
  const syntax = extname(context.filePath) === ".sass" ? "indented" : "scss";
  const res = sass.compileString(content, {
    syntax,
    url: pathToFileURL(context.filePath)
  });
  return {
    output: res.css,
    success: true
  };
};

export { run };
