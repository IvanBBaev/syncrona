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
 */
export * from "./engine";
export * from "./auth";
export * from "./uiSession";
