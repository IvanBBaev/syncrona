// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @syncrona/fluent — the optional Fluent tier behind `syncrona fluent`.
 *
 * Core loads this module lazily and only ever talks to it through the
 * `SN.FluentModule` port declared in `@syncrona/types`
 * (`createFluentEngine` + `createFluentAuthResolver`). The ServiceNow SDK is an
 * optional peer dependency, loaded on the first engine call, never at import.
 *
 * Like `@syncrona/mirror`, this package MUST NOT depend on the `syncrona` core
 * CLI (enforced by the `fluent-no-core` dependency-cruiser rule).
 *
 * The native compiler (`compileFluentProject`) builds a subset of the SDK core
 * APIs without the SDK; it needs only `typescript`, loaded on the first compile.
 * `nativeBuild` turns its records into the SDK's install layout, so build,
 * pack and install run end to end without the SDK.
 */
export * from "./engine";
export * from "./auth";
export * from "./uiSession";
export * from "./recordXml";
export * from "./zip";
export * from "./build";
export * from "./pack";
export * from "./install";
export {
  compileFluentProject,
  SUPPORTED_FLUENT_APIS,
  type CompileFluentOptions,
  type CompileFluentResult,
} from "./compiler/compile";
export {
  FluentCompileError,
  type FluentDiagnostic,
  type FluentDiagnosticSeverity,
  type SourceLocation,
} from "./compiler/diagnostics";
export type { GuidGenerator } from "./compiler/keys";
export type {
  InstallCategory,
  RecordUpdateField,
  RecordUpdateModel,
} from "./compiler/record";
export {
  defaultTypeScriptLoader,
  FluentTypeScriptMissingError,
  type TypeScriptLoader,
} from "./compiler/typescript";
