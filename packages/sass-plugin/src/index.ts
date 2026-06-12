import { Sync } from "@syncrona/types";
import sass from "sass";
const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  content: string,
  options: any
): Promise<Sync.PluginResults> {
  try {
    const res = sass.compile(context.filePath);
    return {
      output: res.css,
      success: true
    };
  } catch (e) {
    throw e;
  }
};

export { run };
