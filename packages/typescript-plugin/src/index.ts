// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { Sync } from "@syncrona/types";
import * as ts from "typescript";

// TypeScript's "No inputs were found in config file …" diagnostic. It only
// describes the *file set* a tsconfig selects; this plugin compiles the single
// in-memory file it was handed and never reads `ParsedCommandLine.fileNames`,
// so an empty selection must not fail the build.
const NO_INPUTS_FOUND_DIAGNOSTIC_CODE = 18003;

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

  // `ts.readConfigFile` yields the *raw JSON* of the leaf tsconfig.json alone:
  // string enums (`target: "ES2017"`, `module: "ESNext"`), lib names
  // (`["ES2017", "DOM"]`) — which the compiler API below rejects outright
  // (TypeScript 5.5+ throws "target is a string value; tsconfig JSON must be
  // parsed …") — and, worse, it does not follow `extends`. A project whose
  // tsconfig.json is `{ "extends": "./tsconfig.base.json" }` — the standard
  // monorepo layout — therefore compiled and type-checked as if it had no
  // options at all, so `strict` never gated the push and `module` never reached
  // the emit. `results.error` was dropped too, letting an unparsable tsconfig
  // fall back to empty options instead of failing. `ts.parseJsonConfigFileContent`
  // resolves the `extends` chain, converts the JSON to the numeric enum shape
  // (expanding lib names to their `lib.<name>.d.ts` form) and reports real
  // diagnostics, which are now fatal.
  let basePath = path.dirname(context.filePath);
  let baseCompilerOptions: ts.CompilerOptions = {};
  if (configPath) {
    basePath = path.dirname(configPath);
    const results = ts.readConfigFile(configPath, ts.sys.readFile);
    if (results.error) {
      throw new Error(processDiagnostics([results.error]));
    }
    const parsed = ts.parseJsonConfigFileContent(
      results.config ?? {},
      ts.sys,
      basePath,
      undefined,
      configPath
    );
    const configErrors = parsed.errors.filter(
      diagnostic => diagnostic.code !== NO_INPUTS_FOUND_DIAGNOSTIC_CODE
    );
    if (configErrors.length > 0) {
      throw new Error(processDiagnostics(configErrors));
    }
    baseCompilerOptions = parsed.options;
  }
  const tsConfig: { compilerOptions: ts.CompilerOptions } = {
    compilerOptions: { ...baseCompilerOptions }
  };
  tsConfig.compilerOptions.rootDir = undefined;
  // The plugin's own compilerOptions used to be merged in *after* the type check
  // below, so they only ever reached the emit: every documented knob whose
  // purpose is to configure or relax checking (`strict`, `noImplicitAny`,
  // `skipLibCheck`, `lib`, `paths`) was silently inert, and because a plugin
  // throw fails the push there was no way to unblock one with the documented
  // escape hatch. Merge once, here, so a single effective option set drives both
  // the check and the emit — and so the target/module defaults pinned below are
  // derived from the options the user actually asked for.
  Object.assign(
    tsConfig.compilerOptions,
    convertPluginCompilerOptions(pluginOpts.compilerOptions, basePath)
  );
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
  // Whether strictness was left to the defaults — by the tsconfig and by the
  // plugin options alike, both of which are already merged in above.
  const strictnessIsImplied =
    tsConfig.compilerOptions.alwaysStrict === undefined &&
    tsConfig.compilerOptions.strict === undefined;
  if (tsConfig.compilerOptions.module === undefined) {
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
    // TypeScript 6 turned `alwaysStrict` on even without `strict`, prepending
    // a "use strict" prologue this plugin's output never carried — and sloppy
    // ServiceNow code (implicit globals are endemic there) would change
    // behavior at runtime under it. When the user set neither `strict` nor
    // `alwaysStrict` anywhere, suppress the prologue. Scoped to emit only:
    // createProgram rejects alwaysStrict=false as a TS 6 deprecation,
    // transpileModule does not.
    if (strictnessIsImplied) {
      tsConfig.compilerOptions.alwaysStrict = false;
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

  // Plugin `compilerOptions` from sync.config.js are raw JSON as well — the
  // README documents them as "Same as `compilerOptions` in a `tsconfig.json`
  // file", where the string spelling (`target: "ES2021"`) is the normal one —
  // yet they used to be `Object.assign`-ed in unconverted. A string never
  // compares meaningfully against the numeric ScriptTarget enum
  // (`"ES2021" >= ts.ScriptTarget.ES2015` is false), so the implied module kind
  // silently dropped to CommonJS and the emit gained `exports.` references that
  // cannot run in ServiceNow's Rhino engine — while the build reported success.
  // Conversion runs per key because an already-numeric enum
  // (`target: ts.ScriptTarget.ES2021`) is also a supported spelling here, and
  // the JSON converter rejects that shape by design.
  function convertPluginCompilerOptions(
    raw: ts.CompilerOptions | undefined,
    optionsBasePath: string
  ): ts.CompilerOptions {
    const result: ts.CompilerOptions = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      const converted = ts.convertCompilerOptionsFromJson(
        { [key]: value },
        optionsBasePath
      );
      if (converted.errors.length === 0) {
        Object.assign(result, converted.options);
      } else if (typeof value === "number") {
        //already a parsed enum value, pass it through untouched
        result[key] = value;
      } else {
        //a genuine misconfiguration, surface it instead of emitting bad output
        throw new Error(processDiagnostics(converted.errors));
      }
    }
    return result;
  }

  // Mirrors TypeScript 5's `module` default, which this plugin pins for stable
  // output now that TypeScript 6 changed it: an explicit numeric setting wins,
  // otherwise it follows the target (ES2015 for an ES2015+ target, CommonJS for
  // anything older, ES3 counting as unset).
  function impliedModuleKind(compilerOptions: ts.CompilerOptions): ts.ModuleKind {
    if (typeof compilerOptions.module === "number") {
      return compilerOptions.module;
    }
    // A non-numeric target reaching this point would compare false against every
    // ScriptTarget below and quietly yield CommonJS. Both option sources are
    // converted before they get here, so this can only be a bug — say so instead
    // of emitting a module kind nobody asked for.
    if (
      compilerOptions.target !== undefined &&
      typeof compilerOptions.target !== "number"
    ) {
      throw new Error(
        `Invalid TypeScript compilerOptions: "target" must be a ts.ScriptTarget value, got ${JSON.stringify(
          compilerOptions.target
        )}.`
      );
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
