// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { Sync } from "@syncrona/types";
import * as ts from "typescript";
const run: Sync.PluginFunc = async function(
  context: Sync.FileContext,
  content: string,
  options: unknown
): Promise<Sync.PluginResults> {
  interface TSPluginOptions {
    compilerOptions?: ts.CompilerOptions;
    transpile?: boolean;
  }
  // A plugin rule may be declared without an `options` key and sync.config.js is
  // never typechecked, so the argument really is undefined at runtime.
  const pluginOpts: TSPluginOptions = (options as TSPluginOptions) ?? {};
  //try to load tsconifg.json
  let output = "";
  const configPath = ts.findConfigFile(
    context.filePath,
    ts.sys.fileExists,
    "tsconfig.json"
  );

  // `ts.readConfigFile` yields the *raw JSON* compilerOptions exactly as written
  // in tsconfig.json — string enums (`target: "ES2017"`, `module: "ESNext"`),
  // lib names (`["ES2017", "DOM"]`), etc. The compiler API used below expects the
  // numeric enum shape, and TypeScript 5.5+ throws when handed the raw strings
  // ("target is a string value; tsconfig JSON must be parsed …"). Convert them
  // through the official TypeScript conversion, which also lowercases and expands
  // lib names to their `lib.<name>.d.ts` form for us.
  let rawCompilerOptions: object = {};
  let basePath = path.dirname(context.filePath);
  if (configPath) {
    basePath = path.dirname(configPath);
    const results = ts.readConfigFile(configPath, ts.sys.readFile);
    if (results.config && results.config.compilerOptions) {
      rawCompilerOptions = results.config.compilerOptions;
    }
  }
  const converted = ts.convertCompilerOptionsFromJson(
    rawCompilerOptions,
    basePath
  );
  if (converted.errors.length > 0) {
    throw new Error(processDiagnostics(converted.errors));
  }
  const tsConfig: { compilerOptions: ts.CompilerOptions } = {
    compilerOptions: converted.options
  };
  tsConfig.compilerOptions.rootDir = undefined;
  // TypeScript 6 changed the default emit: the default target is now the
  // newest ECMAScript level, target ES5 is a deprecation error (removed in
  // TS 7), and `alwaysStrict` is on even without `strict`, prepending a
  // "use strict" prologue to script output. Pin an explicit default target
  // instead of riding those shifting defaults: ES2021 — the ECMAScript level
  // current ServiceNow releases support — keeps the output deterministic
  // across compiler majors. A tsconfig.json or plugin-options target still
  // wins.
  if (tsConfig.compilerOptions.target === undefined) {
    tsConfig.compilerOptions.target = ts.ScriptTarget.ES2021;
  }
  // Whether the tsconfig left strictness to the defaults — decided before the
  // plugin options merge below so the emit-time prologue pin can honor both.
  const strictnessIsImplied =
    tsConfig.compilerOptions.alwaysStrict === undefined &&
    tsConfig.compilerOptions.strict === undefined;
  const moduleIsImplied = tsConfig.compilerOptions.module === undefined;
  if (moduleIsImplied) {
    tsConfig.compilerOptions.module = impliedModuleKind(
      tsConfig.compilerOptions
    );
  }
  // Force a node-aware resolution only where TypeScript's own default would be
  // Classic, which cannot see node_modules at all. Overriding unconditionally
  // contradicted a valid tsconfig — `module: "NodeNext"` with `moduleResolution:
  // NodeJs` is error TS5109, raised against a combination the user never wrote.
  // Node10 resolution is an error under TypeScript 6, so the override now uses
  // Bundler — the node_modules-aware kind that is valid for the ES2015+ module
  // values which imply Classic. The remaining Classic-implying kinds (amd, umd,
  // system) reject Bundler (TS5095) and are left on TypeScript's own default.
  const moduleKind = tsConfig.compilerOptions.module;
  if (
    tsConfig.compilerOptions.moduleResolution === undefined &&
    impliesClassicResolution(tsConfig.compilerOptions) &&
    moduleKind !== undefined &&
    moduleKind >= ts.ModuleKind.ES2015 &&
    moduleKind <= ts.ModuleKind.ESNext
  ) {
    tsConfig.compilerOptions.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }
  //check the types of the piped content, if we get errors, throw an error
  const diagnostics = typeCheck(
    context.filePath,
    content,
    tsConfig.compilerOptions
  );
  if (diagnostics.length > 0) {
    const diagnosticSummary = processDiagnostics(diagnostics);
    throw new Error(diagnosticSummary);
  }
  //no errors so we are good to transpile
  //Default to transpile. Can be disabled so we can transpile elsewhere...
  if (
    !Object.prototype.hasOwnProperty.call(pluginOpts, "transpile") ||
    pluginOpts.transpile === true
  ) {
    tsConfig.compilerOptions = Object.assign(
      tsConfig.compilerOptions,
      pluginOpts.compilerOptions
    );
    // TypeScript 6 turned `alwaysStrict` on even without `strict`, prepending
    // a "use strict" prologue this plugin's output never carried — and sloppy
    // ServiceNow code (implicit globals are endemic there) would change
    // behavior at runtime under it. When the user set neither `strict` nor
    // `alwaysStrict` anywhere, suppress the prologue. Scoped to emit only:
    // createProgram rejects alwaysStrict=false as a TS 6 deprecation,
    // transpileModule does not.
    if (
      strictnessIsImplied &&
      !(
        pluginOpts.compilerOptions &&
        (Object.prototype.hasOwnProperty.call(
          pluginOpts.compilerOptions,
          "strict"
        ) ||
          Object.prototype.hasOwnProperty.call(
            pluginOpts.compilerOptions,
            "alwaysStrict"
          ))
      )
    ) {
      tsConfig.compilerOptions.alwaysStrict = false;
    }
    // The module kind pinned above was implied from the pre-merge target. When
    // the plugin options changed the target and still left `module` unset,
    // re-derive it so an ES2015+ target keeps its ESM emit (TypeScript 5's
    // rule, which the plugin preserves).
    if (
      moduleIsImplied &&
      !(
        pluginOpts.compilerOptions &&
        Object.prototype.hasOwnProperty.call(
          pluginOpts.compilerOptions,
          "module"
        )
      )
    ) {
      tsConfig.compilerOptions.module = impliedModuleKind({
        ...tsConfig.compilerOptions,
        module: undefined
      });
    }
    output = ts.transpileModule(content, {
      compilerOptions: tsConfig.compilerOptions
    }).outputText;
    return {
      success: true,
      output
    };
  } else {
    //no transpilation, going to be handled somewhere else
    return {
      success: true,
      output: content
    };
  }

  // Type-check the in-memory `content` as if it were the file at `fileName`.
  // An earlier plugin in the pipeline may have rewritten the source, so a plain
  // `createProgram([fileName])` — which reads from disk — would validate stale
  // bytes that never get emitted. A thin compiler-host overlay serves `content`
  // for the entrypoint and delegates lib.d.ts / node_modules reads to the
  // default host. Mirrors how transpileModule already runs on `content`.
  function typeCheck(
    fileName: string,
    sourceText: string,
    options: ts.CompilerOptions
  ) {
    //don't want to output files
    options.noEmit = true;
    const host = ts.createCompilerHost(options);
    const targetKey = host.getCanonicalFileName(path.resolve(fileName));
    const isTarget = (name: string) =>
      host.getCanonicalFileName(path.resolve(name)) === targetKey;
    const baseGetSourceFile = host.getSourceFile.bind(host);
    const baseReadFile = host.readFile.bind(host);
    const baseFileExists = host.fileExists.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      isTarget(name)
        ? ts.createSourceFile(name, sourceText, languageVersion, true)
        : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
    host.readFile = name => (isTarget(name) ? sourceText : baseReadFile(name));
    host.fileExists = name => (isTarget(name) ? true : baseFileExists(name));
    const program = ts.createProgram([fileName], options, host);
    const emitResult = program.emit();
    const allDiagnostics = ts
      .getPreEmitDiagnostics(program)
      .concat(emitResult.diagnostics);
    return allDiagnostics;
  }

  // Mirrors TypeScript 5's `module` default, which this plugin pins for stable
  // output now that TypeScript 6 changed it: an explicit numeric setting wins,
  // otherwise it follows the target (ES2015 for an ES2015+ target, CommonJS for
  // anything older, ES3 counting as unset).
  function impliedModuleKind(compilerOptions: ts.CompilerOptions): ts.ModuleKind {
    if (typeof compilerOptions.module === "number") {
      return compilerOptions.module;
    }
    const target =
      compilerOptions.target === ts.ScriptTarget.ES3
        ? undefined
        : compilerOptions.target;
    return (target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2015
      ? ts.ModuleKind.ES2015
      : ts.ModuleKind.CommonJS;
  }

  // True when TypeScript would default `moduleResolution` to Classic. CommonJS
  // implies Node10, Preserve implies Bundler, and the Node16..NodeNext band each
  // imply their own node-aware kind; every other `module` falls back to Classic.
  // The band is compared as a range so a `module` added by a newer TypeScript
  // (the peer range is >=5) is not mistaken for a Classic default.
  function impliesClassicResolution(compilerOptions: ts.CompilerOptions) {
    const moduleKind = impliedModuleKind(compilerOptions);
    if (
      moduleKind === ts.ModuleKind.CommonJS ||
      moduleKind === ts.ModuleKind.Preserve
    ) {
      return false;
    }
    return !(
      moduleKind >= ts.ModuleKind.Node16 && moduleKind <= ts.ModuleKind.NodeNext
    );
  }

  function processDiagnostics(diagnostics: ts.Diagnostic[]) {
    return diagnostics
      .map(diagnostic => {
        if (diagnostic.file) {
          const {
            line,
            character
          } = diagnostic.file.getLineAndCharacterOfPosition(
            diagnostic.start!
          );
          const message = ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n"
          );
          return `${diagnostic.file.fileName} (${line + 1},${character +
            1}): ${message}`;
        } else {
          return ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n"
          );
        }
      })
      .join("\n");
  }
};

export { run };
