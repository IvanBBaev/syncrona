// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
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
      const reg = rule?.match;
      // sync.config.js is user-authored, so `match` may not actually be a
      // RegExp at runtime (e.g. a string slipped in). Skip malformed rules with
      // a clear warning instead of throwing `reg.test is not a function`.
      if (!(reg instanceof RegExp)) {
        logger.warn(
          `Skipping plugin rule with a non-RegExp 'match' (got ${typeof reg}). Use a regular expression, e.g. match: /\\.ts$/.`
        );
        continue;
      }
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
      let plugin: Sync.Plugin;
      try {
        plugin = await import(pluginPath);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Build plugin "${pConfig.name}" could not be loaded from ${pluginPath}. ` +
            `Is it installed? Run 'npm install ${pConfig.name}'. (${message})`
        );
      }
      if (typeof plugin?.run !== "function") {
        throw new Error(
          `Build plugin "${pConfig.name}" does not export a run(context, content, options) function.`
        );
      }
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
