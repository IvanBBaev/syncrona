// SPDX-License-Identifier: GPL-3.0-or-later
//
// What every artefact builder shares: the build context and a typed reader
// over the API call's options object that rejects unknown properties and
// mistyped values instead of dropping them.

import type * as TS from "typescript";
import { FluentCompileError, type FluentDiagnosticSeverity, type SourceLocation } from "../diagnostics";
import type { FluentCall, FluentObject, FluentValue } from "../evaluate";
import type { DictionaryChecks } from "../dictionary";
import { isGUID } from "../keys";
import type { CompiledRecord, InstallCategory, RecordFactory, RecordId } from "../record";

export interface BuildContext {
  ts: typeof TS;
  scope: string;
  scopeId: string;
  factory: RecordFactory;
  report(severity: FluentDiagnosticSeverity, message: string, location: SourceLocation): void;
  /** The record another API call compiles to (compiled on first use). */
  recordOf(call: FluentCall): CompiledRecord;
  /** now.config.json `defaultLanguage`: the language of labels and choices that name none. */
  defaultLanguage: string;
  /** Why Table() cannot compile with this project's now.config.json, if it cannot. */
  tableConfigError?: string;
  /** Why ChoiceSet() cannot compile with this project's now.config.json, if it cannot. */
  choiceSetConfigError?: string;
  /** Writes a file other than a record update, relative to the app's dist directory. */
  emitFile(path: string, content: string): void;
  /** Table and column names to validate against the dictionary once every call is built. */
  dictionary: DictionaryChecks;
  /** Runs `check` over every compiled record once every call is built (the SDK's `inspect`). */
  inspect(check: (records: readonly CompiledRecord[]) => void): void;
}

export type ArtefactBuilder = (options: Options, ctx: BuildContext) => CompiledRecord;

export interface ArtefactSpec {
  /** Option names the API accepts, besides `$id`, `$meta` and `protectionPolicy`. */
  properties: readonly string[];
  /** Deprecated snake_case alias → current name. */
  aliases?: Record<string, string>;
  /** For an API taking a second options object: the errors for a missing first and second object. */
  twoArguments?: { first: string; second: string };
  /** How many arguments the API takes after its options object (Test()'s steps function); none by default. */
  extraArguments?: number;
  /** What the "takes one options object…" error names after the options object; Test()'s steps function by default. */
  extraArgumentsLabel?: string;
  build: ArtefactBuilder;
}

/** The option names (and aliases) an options object, or a nested object within one, accepts. */
export type OptionsShape = Pick<ArtefactSpec, "properties" | "aliases">;

const COMMON = ["$id", "$meta", "$override", "protectionPolicy"];
/** Fields the record update writes itself, which `$override` cannot replace. */
const OVERRIDE_BLOCKLIST = new Set(["sys_id", "sys_scope", "sys_update_name", "sys_domainpath"]);
const INSTALL_METHODS: Record<string, InstallCategory> = {
  demo: "unload.demo",
  "first install": "unload",
  once: "apply_once",
};

/** Whether `scope` is a ServiceNow-owned scope (neither `global` nor a customer `x_` scope). */
export function isSNScope(scope: string): boolean {
  return !scope.startsWith("x_") && scope !== "global";
}

/** Lookup that ignores inherited keys such as `toString`. */
export function lookup<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export class Options {
  readonly installCategory: InstallCategory;

  /** `path` is the dotted prefix of a nested object (`client.`); the top-level object has none. */
  constructor(
    readonly call: FluentCall,
    readonly object: FluentObject,
    private readonly spec: OptionsShape,
    private readonly ctx: BuildContext,
    readonly path = "",
  ) {
    const common = path ? [] : COMMON;
    for (const [key, value] of object.props) {
      const current = spec.aliases && lookup(spec.aliases, key);
      if (current && object.props.has(current)) {
        throw new FluentCompileError(
          `Both '${current}' and its deprecated alias '${key}' are defined. Remove '${key}' and keep '${current}'.`,
          object.props.get(current)!.loc,
        );
      }
      if (current) ctx.report("hint", `The property '${key}' is deprecated, use '${current}' instead.`, value.loc);
      else if (!common.includes(key) && !spec.properties.includes(key)) {
        throw new FluentCompileError(`${call.api}() has no property '${path}${key}'.`, value.loc);
      }
    }
    this.installCategory = path ? "update" : this.readInstallCategory();
  }

  static of(call: FluentCall, spec: ArtefactSpec, ctx: BuildContext): Options {
    const [arg, second] = call.args;
    if (spec.twoArguments) {
      if (arg?.kind !== "object") throw new FluentCompileError(spec.twoArguments.first, call.loc);
      if (call.args.length !== 2 || second.kind !== "object") throw new FluentCompileError(spec.twoArguments.second, call.loc);
      return new Options(call, arg, spec, ctx);
    }
    const extra = spec.extraArguments ?? 0;
    if (call.args.length < 1 || call.args.length > 1 + extra || arg.kind !== "object") {
      const rest = extra === 0 ? "" : (spec.extraArgumentsLabel ?? " and its steps function");
      throw new FluentCompileError(`${call.api}() takes one options object${rest}.`, call.loc);
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
    this.error(`${this.call.api}(): '${this.path}${key}' must be ${kind}.`, this.get(key));
  }

  /** A reader over `value`, an object nested at `path` (`roles[].`), accepting `properties` (and `aliases`). */
  sub(value: FluentValue, path: string, properties: readonly string[], aliases?: Record<string, string>): Options {
    if (value.kind !== "object") this.error(`${this.call.api}(): '${this.path}${path.replace(/\.$/, "")}' must be an object.`, value);
    return new Options(this.call, value, { properties, aliases }, this.ctx, `${this.path}${path}`);
  }

  /** The object at `key`, read with its own `properties`. */
  nested(key: string, properties: readonly string[]): Options | undefined {
    const v = this.get(key);
    return v === undefined ? undefined : this.sub(v, `${key}.`, properties);
  }

  string(key: string): string | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "string") this.expect(key, "a string");
    return v.value;
  }

  requiredString(key: string): string {
    const v = this.string(key);
    if (v === undefined) this.error(`${this.call.api}(): '${this.path}${key}' is required.`);
    return v;
  }

  number(key: string): number | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (v.kind !== "number") this.expect(key, "a number");
    return v.value;
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
      if (item.kind !== "string") this.error(`${this.call.api}(): '${this.path}${key}' must be an array of strings.`, item);
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

  /**
   * Writes `$override` into `record` the way the SDK does: each field verbatim,
   * except the ones the record update writes itself (an error) and the ones
   * the builder already set (ignored with a warning).
   */
  applyOverride(record: CompiledRecord): void {
    const override = this.get("$override");
    if (override === undefined) return;
    if (override.kind !== "object") this.expect("$override", "an object");
    for (const [key, value] of override.props) {
      if (OVERRIDE_BLOCKLIST.has(key)) {
        this.ctx.report(
          "error",
          `$override: '${key}' is managed by the framework and cannot be overridden — remove it or use a supported API property instead.`,
          value.loc,
        );
      } else if (record.fields.get(key) !== undefined) {
        this.ctx.report(
          "warning",
          `$override: '${key}' is already set by the plugin and will be ignored — use the corresponding API property instead.`,
          value.loc,
        );
      } else if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") {
        record.fields.set(key, value.value);
      } else if (value.kind !== "undefined") {
        this.error(`${this.call.api}(): '${this.path}$override.${key}' must be a string, number or boolean.`, value);
      }
    }
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

export interface RoleReference {
  role: RecordId | CompiledRecord;
  /** The role name, when the reference tells it. */
  name?: string;
}

/** A role given by name, sys_id or Role() record, as a sys_user_role reference. */
export function roleReference(o: Options, ctx: BuildContext, value: FluentValue, key: string): RoleReference {
  if (value.kind === "string" && isGUID(value.value)) {
    ctx.report(
      "hint",
      `Unable to determine a role name for sys_id '${value.value}', so 'sys_name' will not be set on this record. Reference the role via Role() if it is defined in this project to populate sys_name.`,
      value.loc,
    );
    return { role: ctx.factory.createReference("sys_user_role", value.value) };
  }
  if (value.kind === "string") {
    return {
      role: ctx.factory.createReference("sys_user_role", undefined, {
        name: value.value,
      }),
      name: value.value,
    };
  }
  if (value.kind === "call") return roleRecord(o, ctx, value, key);
  return o.error(`${o.call.api}(): '${key}' must hold role names, sys_ids or Role() records.`, value);
}

/** The record a Role() call compiles to; any other call is an error. */
export function roleRecord(o: Options, ctx: BuildContext, call: FluentCall, key: string): Required<RoleReference> {
  const role = ctx.recordOf(call);
  if (role.table !== "sys_user_role") o.error(`${o.call.api}(): '${key}' must hold roles.`, call);
  return { role, name: String(role.fields.get("name")) };
}

/** A roles list as the platform stores it: unique role names, comma-separated. */
export function roleNames(o: Options, ctx: BuildContext, items: FluentValue[], key: string): string {
  const names = items.map((item) => {
    if (item.kind === "string") return item.value;
    if (item.kind === "call") return roleRecord(o, ctx, item, key).name;
    return o.error(`${o.call.api}(): '${key}' must hold role names or Role() records.`, item);
  });
  return [...new Set(names)].join(",");
}

/** Whether a browser-side script imports or requires a module, which it cannot. */
export function usesModules(ts: typeof TS, script: string): boolean {
  const source = ts.createSourceFile("client-script.ts", script, ts.ScriptTarget.Latest);
  const visit = (node: TS.Node): boolean =>
    ts.isImportDeclaration(node) ||
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") ||
    ts.forEachChild(node, visit) === true;
  return visit(source);
}
