import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config";
import { logger } from "./Logger";
import fs from "fs";
import path from "path";
const fsp = fs.promises;

class PluginManager {
  pluginRules: Sync.PluginRule[];
  constructor() {
    this.pluginRules = [];
  }

  async loadPluginConfig() {
    const conf = ConfigManager.getConfig();
    if (conf && conf.rules) {
      this.pluginRules = conf.rules;
    }
  }

  determinePlugins(context: Sync.FileContext): Sync.PluginConfig[] {
    let plugins: Sync.PluginConfig[] = [];
    for (const rule of this.pluginRules) {
      const reg = rule.match;
      if (reg.test(context.filePath)) {
        plugins = rule.plugins;
        //only match first rule
        break;
      }
    }
    return plugins;
  }

  async runPlugins(
    plugins: Sync.PluginConfig[],
    context: Sync.FileContext,
    content: string
  ): Promise<Sync.TransformResults> {
    let output = content;
    for (const pConfig of plugins) {
      const pluginPath = path.join(
        ConfigManager.getRootDir(),
        "node_modules",
        pConfig.name
      );
      const plugin: Sync.Plugin = await import(pluginPath);
      const results = await plugin.run(context, output, pConfig.options);
      if (!results.success) {
        return {
          success: false,
          content: "",
        };
      }
      output = results.output;
    }
    return {
      success: true,
      content: output,
    };
  }

  async processFile(
    context: Sync.FileContext,
    content: string
  ): Promise<string> {
    const plugins = this.determinePlugins(context);
    // DX10: under --log-level debug, show which rule (plugins) each file matched.
    if (plugins.length === 0) {
      logger.debug(`build: ${context.filePath} matched no rule — copied as-is`);
      return content;
    }
    logger.debug(
      `build: ${context.filePath} matched rule → plugins [${plugins.map((p) => p.name).join(", ")}]`
    );
    const pluginResults = await this.runPlugins(plugins, context, content);
    if (!pluginResults.success) {
      throw new Error(
        `Failed to build ${context.tableName}=>${context.sys_id}!`
      );
    }
    return pluginResults.content;
  }

  async getFinalFileContents(context: Sync.FileContext, processFile = true) {
    const { filePath } = context;
    const contents = await fsp.readFile(filePath, "utf-8");
    if (processFile) {
      await this.loadPluginConfig();
      return await this.processFile(context, contents);
    }
    return contents;
  }
}

export default new PluginManager();
