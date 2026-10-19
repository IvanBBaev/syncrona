// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Build plugin for `.ts` sources: type-checks the piped content against the
 * project's tsconfig.json and, unless told otherwise, transpiles it to the
 * JavaScript ServiceNow runs.
 *
 * Effective compiler options are assembled in layers:
 *   1. the nearest tsconfig.json, parsed with its `extends` chain resolved;
 *   2. the plugin rule's `compilerOptions`, which win over the tsconfig;
 *   3. pinned defaults for whatever both left unset (target, module,
 *      moduleResolution), so the emit does not drift between TypeScript majors.
 * One option set drives both the type check and the emit.
 */
import * as path from "node:path";
import { Sync } from "@syncrona/types";
import * as ts from "typescript";

interface TypeScriptPluginOptions {
  /** tsconfig-style options: JSON spellings (`"ES2021"`) or enum numbers. */
  compilerOptions?: ts.CompilerOptions;
  /** `false` only type-checks and hands the source on unchanged. */
  transpile?: boolean;
}

/**
 * "No inputs were found in config file". It concerns the file list a tsconfig
 * selects, which this plugin never uses: it compiles the one file it was given.
 */
const EMPTY_FILE_SELECTION = 18003;

/** ECMAScript level current ServiceNow releases execute. */
const PINNED_TARGET = ts.ScriptTarget.ES2021;

class DiagnosticError extends Error {
  constructor(diagnostics: readonly ts.Diagnostic[]) {
    super(describeDiagnostics(diagnostics));
  }
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const source = diagnostic.file;
  if (!source) {
    return text;
  }
  const at = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  return `${source.fileName} (${at.line + 1},${at.character + 1}): ${text}`;
}

function describeDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map(describeDiagnostic).join("\n");
}

interface ProjectSettings {
  /** Directory relative paths in options resolve against. */
  root: string;
  options: ts.CompilerOptions;
}

/**
 * Loads the tsconfig.json governing `filePath`. Reading the raw JSON alone
 * would skip `extends` and leave string enums the compiler API rejects, so the
 * file goes through the full parser, and any problem it reports is fatal.
 */
function loadProjectSettings(filePath: string): ProjectSettings {
  const tsconfig = ts.findConfigFile(filePath, ts.sys.fileExists, "tsconfig.json");
  if (!tsconfig) {
    return { root: path.dirname(filePath), options: {} };
  }
  const root = path.dirname(tsconfig);
  const raw = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (raw.error) {
    throw new DiagnosticError([raw.error]);
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, root, undefined, tsconfig);
  const problems = parsed.errors.filter(problem => problem.code !== EMPTY_FILE_SELECTION);
  if (problems.length > 0) {
    throw new DiagnosticError(problems);
  }
  return { root, options: parsed.options };
}

/**
 * Normalizes the plugin rule's options one key at a time. The JSON converter
 * accepts the tsconfig spelling (`target: "ES2021"`) but refuses an enum
 * number (`target: ts.ScriptTarget.ES2021`); both are documented, so a number
 * the converter refuses is taken as already converted. Anything else it
 * refuses is a misconfiguration and stops the build.
 */
function normalizeRuleOptions(
  supplied: ts.CompilerOptions | undefined,
  root: string
): ts.CompilerOptions {
  const normalized: ts.CompilerOptions = {};
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const { options, errors } = ts.convertCompilerOptionsFromJson({ [name]: value }, root);
    if (errors.length === 0) {
      Object.assign(normalized, options);
    } else if (typeof value === "number") {
      normalized[name] = value;
    } else {
      throw new DiagnosticError(errors);
    }
  }
  return normalized;
}

/**
 * The `module` TypeScript 5 would have picked: an explicit numeric value, or
 * one following the target (ES2015 from an ES2015+ target, CommonJS below
 * that, with ES3 treated like no target at all).
 */
function defaultModuleFor(options: ts.CompilerOptions): ts.ModuleKind {
  if (typeof options.module === "number") {
    return options.module;
  }
  const { target } = options;
  if (target !== undefined && typeof target !== "number") {
    // Both sources are normalized first, so this would be an internal bug;
    // comparing a string with the enum would quietly choose CommonJS.
    throw new Error(
      `Invalid TypeScript compilerOptions: "target" must be a ts.ScriptTarget value, got ${JSON.stringify(target)}.`
    );
  }
  const effective = target === undefined || target === ts.ScriptTarget.ES3 ? ts.ScriptTarget.ES5 : target;
  return effective >= ts.ScriptTarget.ES2015 ? ts.ModuleKind.ES2015 : ts.ModuleKind.CommonJS;
}

function isWithin(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}

/**
 * Whether TypeScript would fall back to Classic resolution, which never looks
 * in node_modules. CommonJS, Preserve and the whole Node16..NodeNext band
 * (compared as a range, so a newer node kind counts too) imply something else.
 */
function fallsBackToClassic(options: ts.CompilerOptions): boolean {
  const kind = defaultModuleFor(options);
  if (kind === ts.ModuleKind.CommonJS || kind === ts.ModuleKind.Preserve) {
    return false;
  }
  return !isWithin(kind, ts.ModuleKind.Node16, ts.ModuleKind.NodeNext);
}

/**
 * Fills the options both layers left unset with values that keep the output
 * stable: TypeScript 6 moved the default target to the newest level and
 * deprecated ES5. Bundler resolution replaces Classic only for ES module
 * kinds; amd, umd and system reject it, and an explicit choice is never
 * overridden.
 */
function applyPinnedDefaults(options: ts.CompilerOptions): void {
  options.target ??= PINNED_TARGET;
  options.module ??= defaultModuleFor(options);
  if (
    options.moduleResolution === undefined &&
    fallsBackToClassic(options) &&
    isWithin(options.module, ts.ModuleKind.ES2015, ts.ModuleKind.ESNext)
  ) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }
}

/**
 * Compiler host that serves `source` for `fileName` and defers every other
 * read (lib files, node_modules) to the default host. An earlier plugin may
 * have rewritten the file, so the bytes on disk are not what will ship.
 */
function hostWithOverlay(
  options: ts.CompilerOptions,
  fileName: string,
  source: string
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const canonical = (name: string) => host.getCanonicalFileName(path.resolve(name));
  const overlaid = canonical(fileName);
  const isOverlaid = (name: string) => canonical(name) === overlaid;

  const { getSourceFile, readFile, fileExists } = host;
  host.getSourceFile = (name, version, onError, createNew) =>
    isOverlaid(name)
      ? ts.createSourceFile(name, source, version, true)
      : getSourceFile.call(host, name, version, onError, createNew);
  host.readFile = name => (isOverlaid(name) ? source : readFile.call(host, name));
  host.fileExists = name => isOverlaid(name) || fileExists.call(host, name);
  return host;
}

/** Collects every diagnostic for `source`; `noEmit` is switched on in `options`. */
function collectDiagnostics(
  fileName: string,
  source: string,
  options: ts.CompilerOptions
): ts.Diagnostic[] {
  options.noEmit = true;
  const program = ts.createProgram([fileName], options, hostWithOverlay(options, fileName, source));
  const emitted = program.emit();
  return [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
}

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  options: unknown
): Promise<Sync.PluginResults> => {
  // sync.config.js is not type-checked: a rule without `options` passes undefined.
  const settings = (options ?? {}) as TypeScriptPluginOptions;
  const project = loadProjectSettings(context.filePath);
  const compilerOptions: ts.CompilerOptions = {
    ...project.options,
    rootDir: undefined,
    ...normalizeRuleOptions(settings.compilerOptions, project.root)
  };
  applyPinnedDefaults(compilerOptions);
  // Read before anything below changes the options.
  const strictnessUnset =
    compilerOptions.strict === undefined && compilerOptions.alwaysStrict === undefined;

  const problems = collectDiagnostics(context.filePath, content, compilerOptions);
  if (problems.length > 0) {
    throw new DiagnosticError(problems);
  }

  const transpile = !Object.hasOwn(settings, "transpile") || settings.transpile === true;
  if (!transpile) {
    return { success: true, output: content };
  }
  if (strictnessUnset) {
    // TypeScript 6 enables alwaysStrict by default, which would prepend a
    // "use strict" prologue and change sloppy-mode ServiceNow code. Only
    // transpileModule accepts turning it off; createProgram calls it deprecated.
    compilerOptions.alwaysStrict = false;
  }
  const { outputText } = ts.transpileModule(content, { compilerOptions });
  return { success: true, output: outputText };
};
