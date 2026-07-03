// SPDX-License-Identifier: GPL-3.0-or-later
import {Sync} from "@syncro-now-ai/types";
import * as babel from "@babel/core";
export async function run(
  context: Sync.FileContext,
  content: string,
  options: babel.InputOptions
): Promise<Sync.PluginResults> {
  let output = "";
  options = Object.assign(options, {
    filename: `${context.targetField}${context.ext}`
  });
  const res = await babel.transformAsync(content, options || {});
  if (res && res.code) {
    output = res.code;
  } else {
    return {
      output: "",
      success: false
    };
  }
  return {
    output,
    success: true
  };
}
