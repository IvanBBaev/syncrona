// SPDX-License-Identifier: GPL-3.0-or-later
import {Sync} from "@syncrona/types";
import * as babel from "@babel/core";
export async function run(
  context: Sync.FileContext,
  content: string,
  options: babel.InputOptions
): Promise<Sync.PluginResults> {
  // Build a fresh options object instead of mutating the caller's: the same
  // options are handed to every file in a build, so writing `filename` back into
  // the shared object leaks one file's identity into the next. `options` may be
  // undefined, so the empty-object base also removes the dead `|| {}` guard that
  // sat *after* the old in-place Object.assign (which would already have thrown).
  const babelOptions = Object.assign({}, options, {
    filename: `${context.targetField}${context.ext}`
  });
  const res = await babel.transformAsync(content, babelOptions);
  // A null result means Babel produced nothing (e.g. an ignored file) — a real
  // failure. But `res.code === ""` is a legitimate success: an empty or
  // comment-only source transforms to empty output and must not fail the build.
  if (res && typeof res.code === "string") {
    return {
      output: res.code,
      success: true
    };
  }
  return {
    output: "",
    success: false
  };
}
