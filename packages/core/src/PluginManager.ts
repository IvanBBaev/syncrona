// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import fs from "fs";
import path from "path";
import { types } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
    // A relative or absolute plugin path names a file in the project; left
    // as-is, import() would resolve it against this module instead.
    if (pluginName.startsWith(".") || path.isAbsolute(pluginName)) {
      return pathToFileURL(path.resolve(rootDir, pluginName)).href;
    }
    // An ESM-only plugin exposes no "require" condition, so the resolver above
    // cannot see it. Read its "exports" from the project's node_modules: a bare
    // specifier would be resolved from where syncrona is installed, which for a
    // global or npx-cached install is not the project.
    const entry = findEsmPackageEntry(rootDir, pluginName);
    if (entry) return pathToFileURL(entry).href;
    // Last resort: Node's own resolution from this module (a plugin installed
    // next to syncrona itself). If that fails too, runPlugins reports the
    // install hint.
    return pluginName;
  }
}

const ESM_CONDITIONS = new Set(["node", "import", "default"]);

/** The first target an "exports" entry yields under Node's ESM conditions. */
function exportTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const target = exportTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (entry && typeof entry === "object") {
    for (const [condition, value] of Object.entries(entry)) {
      if (!ESM_CONDITIONS.has(condition)) continue;
      const target = exportTarget(value);
      if (target) return target;
    }
  }
  return undefined;
}

/**
 * The entry file of `pluginName` (a package, optionally with a subpath) found
 * in a node_modules directory at or above `rootDir`, read the way Node's ESM
 * resolver reads "exports" (no subpath patterns). A package without "exports"
 * is already resolved through "main" by createRequire.
 */
function findEsmPackageEntry(rootDir: string, pluginName: string): string | undefined {
  const parts = pluginName.split("/");
  const nameLength = pluginName.startsWith("@") ? 2 : 1;
  const packageName = parts.slice(0, nameLength).join("/");
  const subpath = parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : ".";
  let dir = path.resolve(rootDir);
  for (;;) {
    const packageDir = path.join(dir, "node_modules", packageName);
    let manifest: { exports?: unknown } | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
    } catch {
      manifest = undefined;
    }
    if (manifest) {
      const { exports } = manifest;
      const isSubpathMap =
        !!exports &&
        typeof exports === "object" &&
        !Array.isArray(exports) &&
        Object.keys(exports).some((key) => key.startsWith("."));
      const target = isSubpathMap
        ? exportTarget((exports as Record<string, unknown>)[subpath])
        : subpath === "."
          ? exportTarget(exports)
          : undefined;
      return target ? path.resolve(packageDir, target) : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
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

function isPluginResults(value: unknown): value is Sync.PluginResults {
  if (typeof value !== "object" || value === null) return false;
  const { success, output } = value as Record<string, unknown>;
  if (typeof success !== "boolean") return false;
  return !success || typeof output === "string";
}

/**
 * The plugin list a rule contributes for `filePath`: `null` when the rule does
 * not apply (or is malformed and skipped with a warning), otherwise its plugins.
 *
 * sync.config.js is user-authored, so neither property is trusted at runtime:
 * - `match` must be a RegExp. config.ts evaluates the file with
 *   vm.runInNewContext, so a regex literal comes from another realm and
 *   `instanceof RegExp` is false; util.types.isRegExp is realm-agnostic.
 * - `plugins` must be an array (#19). An empty array is legitimate ("copy
 *   matched files as-is"); anything else is skipped like a bad `match`, so the
 *   remaining rules still get their chance instead of the build dying deep in
 *   processFile on `plugins.length`.
 */
function pluginsForRule(rule: Sync.PluginRule, filePath: string): Sync.PluginConfig[] | null {
  const pattern: unknown = rule?.match;
  if (!types.isRegExp(pattern)) {
    logger.warn(
      `Skipping plugin rule with a non-RegExp 'match' (got ${typeof pattern}). Use a regular expression, e.g. match: /\\.ts$/.`
    );
    return null;
  }
  if (!matchesFilePath(pattern, filePath)) return null;
  const declared: unknown = rule.plugins;
  if (Array.isArray(declared)) return declared as Sync.PluginConfig[];
  const got = declared === null ? "null" : typeof declared;
  logger.warn(
    `Skipping plugin rule matching ${filePath}: its 'plugins' must be an array (got ${got}). Use e.g. plugins: [{ name: "@syncrona/plugin-js" }], or [] to copy matched files as-is.`
  );
  return null;
}

/** Imports a configured plugin and checks it exposes `run(context, content, options)`. */
async function loadPlugin(name: string): Promise<Sync.Plugin> {
  const specifier = resolvePluginSpecifier(name);
  let candidate: (Sync.Plugin & { default?: Sync.Plugin }) | undefined;
  try {
    candidate = await import(specifier);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Build plugin "${name}" could not be loaded from ${specifier}. ` +
        `Is it installed? Run 'npm install ${name}'. (${reason})`
    );
  }
  // Node's ESM/CJS interop surfaces a CommonJS plugin (`module.exports = { run }`)
  // as the namespace's `default`; named re-exports are only best-effort. Take
  // the named `run` when present and fall back to `default`.
  const plugin = typeof candidate?.run === "function" ? candidate : (candidate?.default ?? candidate);
  if (typeof plugin?.run !== "function") {
    throw new Error(
      `Build plugin "${name}" does not export a run(context, content, options) function.`
    );
  }
  return plugin;
}

const FAILED_TRANSFORM: Sync.TransformResults = { success: false, content: "" };

/** Resolves sync.config.js build rules to plugins and runs them over file contents. */
class PluginManager {
  pluginRules: Sync.PluginRule[] = [];

  async loadPluginConfig() {
    const rules = ConfigManager.getConfig()?.rules;
    if (rules) this.pluginRules = rules;
  }

  /** The plugins of the first applicable rule; an empty list when none applies. */
  determinePlugins(context: Sync.FileContext): Sync.PluginConfig[] {
    for (const rule of this.pluginRules) {
      const plugins = pluginsForRule(rule, context.filePath);
      if (plugins) return plugins;
    }
    return [];
  }

  /**
   * Chains the plugins: each one receives the previous one's output. The first
   * plugin that reports failure stops the chain.
   */
  async runPlugins(
    plugins: Sync.PluginConfig[],
    context: Sync.FileContext,
    content: string
  ): Promise<Sync.TransformResults> {
    let current = content;
    for (const { name, options } of plugins) {
      const plugin = await loadPlugin(name);
      const outcome: unknown = await plugin.run(context, current, options);
      // Third-party code: a missing return would otherwise surface as a bare
      // TypeError, and a success without string output would push "undefined".
      if (!isPluginResults(outcome)) {
        throw new Error(
          `Build plugin "${name}" returned an invalid result for ${context.filePath}: ` +
            "expected { success: boolean, output: string }."
        );
      }
      if (!outcome.success) return FAILED_TRANSFORM;
      current = outcome.output;
    }
    return { success: true, content: current };
  }

  async processFile(context: Sync.FileContext, content: string): Promise<string> {
    const { filePath, tableName, sys_id } = context;
    const plugins = this.determinePlugins(context);
    // DX10: --log-level debug shows which rule each file matched.
    if (plugins.length === 0) {
      logger.debug(`build: ${filePath} matched no rule — copied as-is`);
      return content;
    }
    logger.debug(
      `build: ${filePath} matched rule → plugins [${plugins.map((p) => p.name).join(", ")}]`
    );
    const transformed = await this.runPlugins(plugins, context, content);
    if (transformed.success) return transformed.content;
    throw new Error(`Failed to build ${tableName}=>${sys_id}!`);
  }

  /** The file's text, run through the build plugins unless `processFile` is false. */
  async getFinalFileContents(context: Sync.FileContext, processFile = true) {
    // SDK-F2: a context expanded from a data-model document carries its text in
    // memory; its filePath names a per-record sidecar that is absent on disk.
    const raw =
      typeof context.fileContents === "string"
        ? context.fileContents
        : await fs.promises.readFile(context.filePath, "utf-8");
    if (!processFile) return raw;
    await this.loadPluginConfig();
    return this.processFile(context, raw);
  }
}

export default new PluginManager();
