// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import fs from "fs";
import path from "path";
import { types } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const fsp = fs.promises;

// REV-140: Node's ESM loader cannot import a DIRECTORY: `import("/proj/node_modules/p")`
// fails with ERR_UNSUPPORTED_DIR_IMPORT (and on Windows a "C:\..." path is not
// even a valid specifier). The old code handed exactly that directory path to
// import(), so every configured build plugin failed to load once the package
// became native ESM. The jest suite never caught it because jest resolves
// dynamic imports with its own CJS-style resolver, which happily does directory
// + package.json "main" lookup. Resolve the package ENTRY FILE the way Node's
// resolver does, from the project root, and import it as a file: URL.
export function resolvePluginSpecifier(pluginName: string): string {
  const rootDir = ConfigManager.getRootDir();
  try {
    const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
    return pathToFileURL(requireFromRoot.resolve(pluginName)).href;
  } catch {
    // An ESM-only plugin exposes no "require" condition, so the resolver above
    // cannot see it. A bare specifier at least lets Node's own ESM resolution
    // try; if that fails too, runPlugins reports the install hint.
    return pluginName;
  }
}

// A `/g` or `/y` match in sync.config.js makes .test() stateful: it resumes from
// the RegExp's own lastIndex and rewinds it on a miss, so the same rule would
// match every other file and silently skip the build transform on the rest.
// Rule matching is a stateless "does this path belong to this rule?" question,
// so test a clone without those flags. Cloning also keeps the user's object
// unmutated, and works cross-realm (source/flags read fine on a vm-realm RegExp).
function matchesFilePath(reg: RegExp, filePath: string): boolean {
  const stateless =
    reg.global || reg.sticky
      ? new RegExp(reg.source, reg.flags.replace(/[gy]/g, ""))
      : reg;
  return stateless.test(filePath);
}

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
      // config.ts loads the config via vm.runInNewContext, so a regex literal in
      // the config file is created with the vm realm's RegExp intrinsic and
      // `instanceof RegExp` is false cross-realm — that would silently disable
      // every build transform. util.types.isRegExp is realm-agnostic.
      if (!types.isRegExp(reg)) {
        logger.warn(
          `Skipping plugin rule with a non-RegExp 'match' (got ${typeof reg}). Use a regular expression, e.g. match: /\\.ts$/.`
        );
        continue;
      }
      if (matchesFilePath(reg, context.filePath)) {
        // #19: `match` used to be the only guarded property. A rule that
        // matched but carried no usable `plugins` list handed `undefined` on to
        // processFile, which died on `plugins.length` — aborting the entire
        // build over one incomplete rule, with a message naming our internals
        // instead of the user's config. An explicitly empty array stays
        // legitimate ("these files match, and are copied as-is"); anything that
        // is not an array is skipped like a malformed `match`, so the rest of
        // the rule list still applies to the file.
        const rulePlugins: unknown = rule.plugins;
        if (!Array.isArray(rulePlugins)) {
          logger.warn(
            `Skipping plugin rule matching ${context.filePath}: its 'plugins' must be an array (got ${
              rulePlugins === null ? "null" : typeof rulePlugins
            }). Use e.g. plugins: [{ name: "@syncrona/plugin-js" }], or [] to copy matched files as-is.`
          );
          continue;
        }
        plugins = rulePlugins as Sync.PluginConfig[];
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
      const pluginPath = resolvePluginSpecifier(pConfig.name);
      let plugin: Sync.Plugin;
      try {
        const loaded = (await import(pluginPath)) as Sync.Plugin & {
          default?: Sync.Plugin;
        };
        // A CommonJS plugin (`module.exports = { run }`) is exposed by Node's
        // ESM/CJS interop as the namespace's `default`; named re-exports are
        // best-effort. Prefer the named export, fall back to default.
        plugin =
          typeof loaded?.run === "function" ? loaded : (loaded?.default ?? loaded);
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
