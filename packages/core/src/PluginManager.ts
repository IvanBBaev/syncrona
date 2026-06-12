import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config";
import fs from "fs";
import path from "path";
const fsp = fs.promises;

class PluginManager {
  pluginRules: Sync.PluginRule[];
  constructor() {
    this.pluginRules = [];
  }

  async loadPluginConfig() {
    let conf = ConfigManager.getConfig();
    if (conf && conf.rules) {
      this.pluginRules = conf.rules;
    }
  }

  determinePlugins(context: Sync.FileContext): Sync.PluginConfig[] {
    let plugins: Sync.PluginConfig[] = [];
    for (let rule of this.pluginRules) {
      let reg = rule.match;
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
    try {
      let output = content;
      for (let pConfig of plugins) {
        let pluginPath = path.join(
          ConfigManager.getRootDir(),
          "node_modules",
          pConfig.name
        );
        let plugin: Sync.Plugin = await import(pluginPath);
        let results = await plugin.run(context, output, pConfig.options);
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
    } catch (e) {
      throw e;
    }
  }

  async processFile(
    context: Sync.FileContext,
    content: string
  ): Promise<string> {
    const plugins = this.determinePlugins(context);
    if (plugins.length > 0) {
      try {
        const pluginResults = await this.runPlugins(plugins, context, content);
        if (pluginResults.success) {
          return pluginResults.content;
        } else {
          throw new Error(
            `Failed to build ${context.tableName}=>${context.sys_id}!`
          );
        }
      } catch (e) {
        throw e;
      }
    } else {
      return content;
    }
  }

  async getFinalFileContents(context: Sync.FileContext, processFile = true) {
    const { filePath } = context;
    try {
      const contents = await fsp.readFile(filePath, "utf-8");
      if (processFile) {
        await this.loadPluginConfig();
        return await this.processFile(context, contents);
      }
      return contents;
    } catch (e) {
      throw e;
    }
  }
}

export default new PluginManager();
