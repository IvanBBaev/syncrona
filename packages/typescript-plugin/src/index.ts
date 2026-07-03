// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
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

  let tsConfig: { compilerOptions: ts.CompilerOptions };
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
  tsConfig.compilerOptions.rootDir = undefined;
  tsConfig.compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeJs;
  tsConfig.compilerOptions.lib = tsConfig.compilerOptions.lib
    ? tsConfig.compilerOptions.lib.map(cur => `lib.${cur}.d.ts`)
    : undefined;
  //check the types, if we get errors, throw an error
  const diagnostics = typeCheck(
    [context.filePath],
    tsConfig.compilerOptions || {}
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

  function typeCheck(fileNames: string[], options: ts.CompilerOptions) {
    //don't want to output files
    options.noEmit = true;
    const program = ts.createProgram(fileNames, options);
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
