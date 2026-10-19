// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin that bundles a file and its dependencies into one script with
 * webpack, so code split across modules can ship as a single ServiceNow record.
 *
 * Configuration sources, each overriding the previous one key by key:
 *   1. webpack.config.js beside the file (an object, or a possibly async
 *      function of `(env, argv)` as webpack's CLI accepts);
 *   2. the rule's `webpackConfig` option;
 *   3. the object the rule's `configGenerator(context)` returns.
 * `entry` and `output` are always set by the plugin: the bundle is written to
 * an in-memory volume and returned as the plugin output.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Sync } from "@syncrona/types";
import { createFsFromVolume, Volume } from "memfs";
import webpack from "webpack";

interface WebpackPluginOptions {
  configGenerator?: (context: Sync.FileContext) => webpack.Configuration;
  webpackConfig?: webpack.Configuration;
}

const CONFIG_FILE_NAME = "webpack.config.js";
const BUNDLE_DIR = "/";
const BUNDLE_NAME = "bundle.js";

type Callback = (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void;
type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Where the per-directory config lives. Built with `path.join`/`path.dirname`
 * so a Windows entry (`C:\app\x.js` or `C:/app/x.js`) keeps its drive letter.
 */
function configFileBeside(entry: string): string {
  return path.join(path.dirname(entry), CONFIG_FILE_NAME);
}

function errorCode(error: object): unknown {
  return (error as { code?: unknown }).code;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Distinguishes "there is no config file" from "the config file failed to
 * load". The second case, including a config that requires a dependency that
 * is missing, must surface. Such an error names the dependency as the missing
 * module while its require stack mentions the config, so only the reported
 * missing specifier is compared, never the whole message.
 */
function signalsMissingConfig(error: unknown, configFile: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = errorCode(error);
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND" && code !== "ENOENT") {
    return false;
  }
  const reportedPath = (error as { path?: unknown }).path;
  if (typeof reportedPath === "string" && samePath(reportedPath, configFile)) {
    return true;
  }
  const text = `${(error as { message?: unknown }).message ?? ""}`;
  const missing = /Cannot find (?:module|package) '([^']+)'/.exec(text);
  if (missing) {
    return missing[1] === configFile || samePath(missing[1], configFile);
  }
  const [headline = ""] = text.split("\n", 1);
  return headline.includes(configFile);
}

/**
 * Imports the user's config module; `undefined` when there is none. A config
 * file that exists but throws is rethrown: building with defaults would ship
 * a subtly different bundle. The import goes through a file:// URL because a
 * bare `C:\...` path parses as a URL with scheme `c:`.
 */
async function importUserConfig(configFile: string): Promise<unknown> {
  try {
    const loaded: { default?: unknown } = await import(pathToFileURL(configFile).href);
    return loaded.default;
  } catch (error) {
    if (signalsMissingConfig(error, configFile)) {
      return undefined;
    }
    throw error;
  }
}

/** Turns whatever the config module exported into one configuration object. */
async function materializeConfig(exported: unknown): Promise<webpack.Configuration> {
  const value =
    typeof exported === "function" ? await (exported as AnyFunction)(process.env, {}) : exported;
  if (Array.isArray(value)) {
    // One file yields one bundle; picking one of several compilers would be a guess.
    throw new Error(
      "webpack.config.js exports an array (multi-compiler configuration), which is not supported. Provide a single configuration."
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `webpack.config.js must export a configuration object or a function returning one, but resolved to ${typeof value}.`
    );
  }
  return value as webpack.Configuration;
}

async function composeConfig(
  context: Sync.FileContext,
  settings: WebpackPluginOptions
): Promise<webpack.Configuration> {
  const config: webpack.Configuration = {};
  const fromFile = await importUserConfig(configFileBeside(context.filePath));
  if (fromFile) {
    Object.assign(config, await materializeConfig(fromFile));
  }
  if (settings.webpackConfig) {
    Object.assign(config, settings.webpackConfig);
  }
  if (settings.configGenerator) {
    Object.assign(config, settings.configGenerator(context));
  }
  config.entry = context.filePath;
  config.output = { path: BUNDLE_DIR, filename: BUNDLE_NAME };
  return config;
}

function realPathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

/** Matches the entry however webpack spells it: as given, resolved, or symlink-free. */
function entryMatcher(entry: string): (candidate: unknown) => boolean {
  const resolved = path.resolve(entry);
  const real = realPathOrNull(resolved) ?? resolved;
  return candidate => {
    if (typeof candidate !== "string") {
      return false;
    }
    const target = path.resolve(candidate);
    return target === resolved || target === real || realPathOrNull(target) === real;
  };
}

function requestedEncoding(spec: unknown): BufferEncoding | undefined {
  if (typeof spec === "string") {
    return spec as BufferEncoding;
  }
  if (typeof spec === "object" && spec !== null) {
    return (spec as { encoding?: BufferEncoding }).encoding ?? undefined;
  }
  return undefined;
}

/**
 * Makes webpack read `content` for the entry instead of the file on disk.
 * Earlier plugins in the chain may have transformed the source, and those are
 * the bytes to bundle; every other file (the entry's imports) still comes from
 * disk. Both the callback and the synchronous reader are covered.
 */
function serveEntryFromMemory(compiler: webpack.Compiler, entry: string, content: string): void {
  const input = compiler.inputFileSystem as
    | (Record<"readFile", AnyFunction> & { readFileSync?: AnyFunction })
    | null
    | undefined;
  if (!input) {
    return;
  }
  const isEntry = entryMatcher(entry);
  const bytes = Buffer.from(content, "utf8");
  const render = (encoding: BufferEncoding | undefined) =>
    encoding ? bytes.toString(encoding) : bytes;

  const diskRead = input.readFile.bind(input);
  input.readFile = (...args: unknown[]) => {
    if (!isEntry(args[0])) {
      return diskRead(...args);
    }
    // readFile(path, callback) or readFile(path, options, callback).
    const done = args[args.length - 1] as Callback;
    done(null, render(args.length > 2 ? requestedEncoding(args[1]) : undefined));
    return undefined;
  };

  const diskReadSync = input.readFileSync;
  if (typeof diskReadSync === "function") {
    input.readFileSync = (...args: unknown[]) =>
      isEntry(args[0]) ? render(requestedEncoding(args[1])) : diskReadSync.apply(input, args);
  }
}

function compileToString(compiler: webpack.Compiler, readBundle: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    compiler.run((failure, stats) => {
      if (failure) {
        reject(failure);
      } else if (stats?.hasErrors()) {
        // The message is how a plugin reports; stderr would not reach MCP clients.
        const details = stats.toString({ all: false, errors: true });
        reject(new Error(`Webpack failed to create the bundle.\n${details}`));
      } else {
        resolve(readBundle());
      }
    });
  });
}

/** Webpack 5 wants close() after run() to release caches and workers; its errors are ignored. */
function shutDown(compiler: webpack.Compiler): Promise<void> {
  return new Promise(resolve => compiler.close(() => resolve()));
}

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  options?: WebpackPluginOptions
): Promise<Sync.PluginResults> => {
  // A rule written without `options` (as `config add-plugin` prints it) passes undefined.
  const config = await composeConfig(context, options ?? {});
  const volume = createFsFromVolume(new Volume());
  const compiler = webpack(config);
  // memfs satisfies the runtime contract; its typings predate webpack 5's.
  compiler.outputFileSystem = volume as unknown as typeof compiler.outputFileSystem;
  serveEntryFromMemory(compiler, context.filePath, content);
  try {
    const output = await compileToString(compiler, () =>
      String(volume.readFileSync(`${BUNDLE_DIR}${BUNDLE_NAME}`, "utf-8"))
    );
    return { success: true, output };
  } catch (error) {
    throw new Error(`${error}`);
  } finally {
    await shutDown(compiler);
  }
};
