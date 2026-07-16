// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { createFsFromVolume, Volume } from "memfs";
import webpack from "webpack";
import path from "path";
import fs from "fs";
interface webpackPluginOpts {
  configGenerator?: (context: Sync.FileContext) => webpack.Configuration;
  webpackConfig?: webpack.Configuration;
}
const run: Sync.PluginFunc = async function (
  context: Sync.FileContext,
  content: string,
  options: webpackPluginOpts
): Promise<Sync.PluginResults> {
  const memFS = createFsFromVolume(new Volume());
  let wpOptions: webpack.Configuration = {};
  const configFile = await loadWebpackConfig();
  //First, try to load configuration file
  if (configFile) {
    Object.assign(wpOptions, configFile);
  }
  //Second, load from the options
  if (options.webpackConfig) {
    Object.assign(wpOptions, options.webpackConfig);
  }
  //Third, load from configGenerator function
  if (options.configGenerator) {
    wpOptions = Object.assign(wpOptions, options.configGenerator(context));
  }
  //override necessary parameters
  wpOptions.entry = context.filePath;
  wpOptions.output = {
    path: "/",
    filename: "bundle.js",
  };
  const compiler = webpack(wpOptions);
  // memory-fs predates webpack 5's stricter OutputFileSystem typings (PathLike
  // mkdir args); the runtime shape is still compatible, so bridge the types.
  compiler.outputFileSystem = memFS as unknown as typeof compiler.outputFileSystem;
  // This plugin runs inside a chain (PluginManager.runPlugins): an earlier
  // plugin may have transformed the file — TS→JS, import stripping, minify —
  // and threaded the result to us as `content`. Webpack must bundle THOSE
  // bytes, not silently re-open the untransformed file from disk. Overlay
  // `content` for the entry onto the real input filesystem so the entry reads
  // the transformed source while its relative dependencies still resolve from
  // disk.
  overlayEntryContent(compiler, context.filePath, content);
  const compilePromise = new Promise<string>((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) {
        reject(err);
        return;
      }
      if (stats && stats.hasErrors()) {
        console.error(stats.toString("normal"));
        reject(new Error("Webpack failed to create the bundle."));
        return;
      }
      resolve(memFS.readFileSync("/bundle.js", "utf-8") as string);
    });
  });
  try {
    const output = await compilePromise;
    return {
      output,
      success: true,
    };
  } catch (e) {
    throw new Error(`${e}`);
  } finally {
    // Webpack 5 requires close() after run() to flush caches and release
    // resources (worker pools, file handles, persistent cache). One compiler is
    // created per matched file, so skipping this leaks resources across a
    // multi-file build. Best-effort: a close error must not mask the result.
    await new Promise<void>((resolve) => {
      compiler.close(() => resolve());
    });
  }
  function getWebpackConfigPath() {
    const pathChunks = context.filePath.split(path.sep);
    pathChunks.pop();
    pathChunks.push("webpack.config.js");
    return path.sep + path.join(...pathChunks);
  }
  async function loadWebpackConfig() {
    const configPath = getWebpackConfigPath();
    try {
      const config: webpack.Configuration = (await import(configPath)).default;
      return config;
    } catch (e) {
      if (isConfigAbsent(e, configPath)) {
        // No webpack.config.js next to the entry — the common case; fall back to
        // the options/generator/default configuration.
        return false;
      }
      // A config file exists but failed to load (syntax error, a throwing top
      // level, or a require of a missing dependency). Silently building with the
      // default config would emit a subtly wrong bundle, so surface the failure.
      throw e;
    }
  }
};

// Serve the plugin-chain `content` for the entry file while delegating every
// other read to the real filesystem, so webpack bundles the transformed bytes
// but still resolves the entry's relative dependencies from disk.
function overlayEntryContent(
  compiler: webpack.Compiler,
  entryPath: string,
  content: string
): void {
  const inputFS = compiler.inputFileSystem;
  if (!inputFS) {
    return;
  }
  const entryResolved = path.resolve(entryPath);
  let entryReal = entryResolved;
  try {
    // Webpack resolves symlinks before reading (resolve.symlinks defaults to
    // true), so the path it hands readFile is the realpath — match against it.
    entryReal = fs.realpathSync(entryResolved);
  } catch {
    // Entry not on disk (or unreadable) — fall back to the resolved path.
  }
  const isEntryPath = (candidate: unknown): boolean => {
    if (typeof candidate !== "string") {
      return false;
    }
    const resolved = path.resolve(candidate);
    if (resolved === entryResolved || resolved === entryReal) {
      return true;
    }
    try {
      return fs.realpathSync(resolved) === entryReal;
    } catch {
      return false;
    }
  };
  const entryBuffer = Buffer.from(content, "utf8");
  const encodingOf = (opts: unknown): BufferEncoding | undefined => {
    if (typeof opts === "string") {
      return opts as BufferEncoding;
    }
    if (opts && typeof opts === "object") {
      return (opts as { encoding?: BufferEncoding }).encoding ?? undefined;
    }
    return undefined;
  };

  const originalReadFile = inputFS.readFile.bind(inputFS);
  inputFS.readFile = ((...args: unknown[]) => {
    if (isEntryPath(args[0])) {
      const callback = args[args.length - 1] as (
        err: NodeJS.ErrnoException | null,
        data?: string | Buffer
      ) => void;
      const encoding = args.length > 2 ? encodingOf(args[1]) : undefined;
      callback(null, encoding ? entryBuffer.toString(encoding) : entryBuffer);
      return;
    }
    return (originalReadFile as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof inputFS.readFile;

  const readFileSyncHost = inputFS as {
    readFileSync?: (...a: unknown[]) => unknown;
  };
  const originalReadFileSync = readFileSyncHost.readFileSync;
  if (typeof originalReadFileSync === "function") {
    const boundReadFileSync = originalReadFileSync.bind(inputFS);
    readFileSyncHost.readFileSync = (...args: unknown[]) => {
      if (isEntryPath(args[0])) {
        const encoding = encodingOf(args[1]);
        return encoding ? entryBuffer.toString(encoding) : entryBuffer;
      }
      return boundReadFileSync(...args);
    };
  }
}

// True only when the config file itself is absent (the normal "no config"
// case). A config that exists but fails to load — syntax error, throwing top
// level, or a require of a missing *dependency* — raises a different error (or
// names a different specifier) and must surface rather than be swallowed.
function isConfigAbsent(error: unknown, configPath: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  const notFound =
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ENOENT";
  if (!notFound) {
    return false;
  }
  const errorPath = (error as { path?: string }).path;
  if (
    typeof errorPath === "string" &&
    path.resolve(errorPath) === path.resolve(configPath)
  ) {
    return true;
  }
  // Compare against the missing *specifier*, not the whole message: a config
  // that requires a missing dependency raises MODULE_NOT_FOUND naming the
  // dependency, yet its "Require stack:" lists the config path — so a naive
  // message.includes(configPath) would wrongly swallow it. The first line names
  // the actual unresolved module.
  const message = String((error as { message?: string }).message ?? "");
  const specifier = message.match(/Cannot find (?:module|package) '([^']+)'/)?.[1];
  if (specifier !== undefined) {
    return (
      specifier === configPath ||
      path.resolve(specifier) === path.resolve(configPath)
    );
  }
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine.includes(configPath);
}

export { run };
