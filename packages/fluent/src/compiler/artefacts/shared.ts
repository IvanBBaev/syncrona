// SPDX-License-Identifier: GPL-3.0-or-later
//
// What every artefact builder shares: the build context and a typed reader
// over the API call's options object that rejects unknown properties and
// mistyped values instead of dropping them.

import { FluentCompileError, type FluentDiagnosticSeverity, type SourceLocation } from "../diagnostics";
import type { FluentCall, FluentObject, FluentValue } from "../evaluate";
import type { CompiledRecord, InstallCategory, RecordFactory } from "../record";

export interface BuildContext {
  scope: string;
  scopeId: string;
  factory: RecordFactory;
  report(severity: FluentDiagnosticSeverity, message: string, location: SourceLocation): void;
  /** The record another API call compiles to (compiled on first use). */
  recordOf(call: FluentCall): CompiledRecord;
}

export type ArtefactBuilder = (options: Options, ctx: BuildContext) => CompiledRecord;

export interface ArtefactSpec {
  /** Option names the API accepts, besides `$id`, `$meta` and `protectionPolicy`. */
  properties: readonly string[];
  /** Deprecated snake_case alias → current name. */
  aliases?: Record<string, string>;
  build: ArtefactBuilder;
}

const COMMON = ["$id", "$meta", "protectionPolicy"];
const INSTALL_METHODS: Record<string, InstallCategory> = {
  demo: "unload.demo",
  "first install": "unload",
  once: "apply_once",
};

/** Whether `scope` is a ServiceNow-owned scope (neither `global` nor a customer `x_` scope). */
export function isSNScope(scope: string): boolean {
  return !scope.startsWith("x_") && scope !== "global";
}

export class Options {
  readonly installCategory: InstallCategory;

  constructor(
    readonly call: FluentCall,
    readonly object: FluentObject,
    private readonly spec: ArtefactSpec,
    ctx: BuildContext,
  ) {
    for (const [key, value] of object.props) {
      if (key === "$override") {
        throw new FluentCompileError(`${call.api}(): '$override' is not supported by the native compiler yet.`, value.loc);
      }
      const current = spec.aliases?.[key];
      if (current) ctx.report("hint", `The property '${key}' is deprecated, use '${current}' instead.`, value.loc);
      else if (!COMMON.includes(key) && !spec.properties.includes(key)) {
        throw new FluentCompileError(`${call.api}() has no property '${key}'.`, value.loc);
      }
    }
    this.installCategory = this.readInstallCategory();
  }

  static of(call: FluentCall, spec: ArtefactSpec, ctx: BuildContext): Options {
    const [arg] = call.args;
    if (call.args.length !== 1 || arg.kind !== "object") {
      throw new FluentCompileError(`${call.api}() takes one options object.`, call.loc);
    }
    return new Options(call, arg, spec, ctx);
  }

  /** The value of `key` (or its deprecated alias); `undefined` literals count as absent. */
  get(key: string): FluentValue | undefined {
    const alias = Object.entries(this.spec.aliases ?? {}).find(([, current]) => current === key)?.[0];
    const value = this.object.props.get(key) ?? (alias ? this.object.props.get(alias) : undefined);
    return value?.kind === "undefined" ? undefined : value;
  }

  error(message: string, value?: FluentValue): never {
    throw new FluentCompileError(message, value?.loc ?? this.call.loc);
  }

  private expect(key: string, kind: string): never {
    this.error(`${this.call.api}(): '${key}' must be ${kind}.`, this.get(key));
  }

  string(key: string): string | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "string") this.expect(key, "a string");
    return v.value;
  }

  requiredString(key: string): string {
    const v = this.string(key);
    if (v === undefined) this.error(`${this.call.api}(): '${key}' is required.`);
    return v;
  }

  boolean(key: string): boolean | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "boolean") this.expect(key, "a boolean");
    return v.value;
  }

  /** A string, number or boolean, as its string form. */
  scalar(key: string): string | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "string" && v.kind !== "number" && v.kind !== "boolean") this.expect(key, "a string, number or boolean");
    return String(v.value);
  }

  array(key: string): FluentValue[] | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "array") this.expect(key, "an array");
    return v.items;
  }

  stringArray(key: string): string[] | undefined {
    return this.array(key)?.map((item) => {
      if (item.kind !== "string") this.error(`${this.call.api}(): '${key}' must be an array of strings.`, item);
      return item.value;
    });
  }

  /** `$id`: `Now.ID[...]`, a string or a number. */
  explicitId(): string | number | undefined {
    const v = this.get("$id");
    if (v === undefined) return undefined;
    if (v.kind === "nowId") return v.key;
    if (v.kind === "string" || v.kind === "number") return v.value;
    this.expect("$id", "Now.ID[...], a string or a number");
  }

  protectionPolicy(): string | undefined {
    const v = this.string("protectionPolicy");
    if (v !== undefined && v !== "read" && v !== "protected") this.expect("protectionPolicy", "'read' or 'protected'");
    return v;
  }

  private readInstallCategory(): InstallCategory {
    const meta = this.get("$meta");
    if (meta === undefined) return "update";
    if (meta.kind !== "object") this.expect("$meta", "an object");
    for (const [key, value] of meta.props) {
      if (key === "useEsLatest") this.error(`${this.call.api}(): '$meta.useEsLatest' is not supported by the native compiler yet.`, value);
      if (key !== "installMethod") this.error(`${this.call.api}(): '$meta' has no property '${key}'.`, value);
    }
    const method = meta.props.get("installMethod");
    if (method === undefined) return "update";
    const category = method.kind === "string" ? INSTALL_METHODS[method.value] : undefined;
    if (!category) this.error(`${this.call.api}(): '$meta.installMethod' must be 'demo', 'first install' or 'once'.`, method);
    return category;
  }
}
