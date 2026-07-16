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
  const pluginOpts = options as TSPluginOptions;
  //try to load tsconifg.json
  let output = "";
  const configPath = ts.findConfigFile(
    context.filePath,
    ts.sys.fileExists,
    "tsconfig.json"
  );

  let tsConfig: { compilerOptions?: ts.CompilerOptions };
  if (configPath) {
    const results = ts.readConfigFile(configPath, ts.sys.readFile);
    if (results.config) {
      tsConfig = results.config;
    } else {
      tsConfig = {
        compilerOptions: {}
      };
    }
  } else {
    tsConfig = {
      compilerOptions: {}
    };
  }
  // A tsconfig.json that has no `compilerOptions` key parses to a config object
  // that lacks it, so default it before we start writing fields into it —
  // otherwise the first assignment below throws "Cannot set properties of
  // undefined (setting 'rootDir')".
  if (!tsConfig.compilerOptions) {
    tsConfig.compilerOptions = {};
  }
  tsConfig.compilerOptions.rootDir = undefined;
  tsConfig.compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeJs;
  tsConfig.compilerOptions.lib = tsConfig.compilerOptions.lib
    ? tsConfig.compilerOptions.lib.map(cur => `lib.${cur}.d.ts`)
    : undefined;
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
    !pluginOpts.hasOwnProperty("transpile") ||
    pluginOpts.transpile === true
  ) {
    tsConfig.compilerOptions = Object.assign(
      tsConfig.compilerOptions,
      pluginOpts.compilerOptions
    );
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
