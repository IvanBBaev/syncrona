// SPDX-License-Identifier: GPL-3.0-or-later
//
// The native compiler parses Fluent sources with the TypeScript compiler API.
// `typescript` is an optional peer dependency, loaded on the first compile:
// from the Fluent project first (a Fluent project always has it), then from
// this package's own location. The loader returns `object` so the package's
// public declarations do not depend on TypeScript's types.

import path from "node:path";
import { createRequire } from "node:module";

/** Loads the `typescript` module for a project directory. */
export type TypeScriptLoader = (projectDir: string) => object;

export class FluentTypeScriptMissingError extends Error {
  readonly code = "FLUENT_TYPESCRIPT_MISSING";
  constructor() {
    super(
      "The native Fluent compiler needs the `typescript` package. Install it in the Fluent project (npm install --save-dev typescript).",
    );
    this.name = "FluentTypeScriptMissingError";
  }
}

function tryRequire(fromFile: string): object | undefined {
  try {
    return createRequire(fromFile)("typescript") as object;
  } catch {
    return undefined;
  }
}

/** Resolve `typescript` from the project, then from `fallbackFrom` (this module by default). */
export function defaultTypeScriptLoader(projectDir: string, fallbackFrom: string = __filename): object {
  const ts = tryRequire(path.join(projectDir, "package.json")) ?? tryRequire(fallbackFrom);
  if (!ts) throw new FluentTypeScriptMissingError();
  return ts;
}
