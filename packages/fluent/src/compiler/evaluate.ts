// SPDX-License-Identifier: GPL-3.0-or-later
//
// A static evaluator for Fluent sources. Fluent files are declarative: calls
// of the `@servicenow/sdk/core` APIs whose arguments are literals, `Now.ID`,
// `Now.ref`, `Now.include`, `Now.attach`, the global `Duration()` / `Time()` helpers,
// references to other calls through `const` bindings (also imported from other
// project files), their variables (`item.variables.name`), template literals and
// Test()'s steps function, a list of `atf.<category>.<step>()` calls whose options
// may refer to earlier steps' outputs, and PlaybookDefinition()'s `wfa.playbook.*`
// helpers with their functions (`const` locals and one `return`). The evaluator turns them into plain values
// without running any code; anything outside that subset is a compile error naming the
// construct, never a silent guess.

import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import { FluentCompileError, type DiagnosticSink, type SourceLocation } from "./diagnostics";
import { SDK_CONSTANTS } from "./sdkConstants";

export const SDK_CORE_MODULE = "@servicenow/sdk/core";
export const SDK_AUTOMATION_MODULE = "@servicenow/sdk/automation";

/** The automation exports referenced through member chains (`ActivityDefinitions.Core.Instruction`). */
const AUTOMATION_NAMESPACES = new Set(["wfa", "PlaybookTriggerTypes", "ActivityDefinitions"]);

/** A call of an SDK core API, e.g. `Role({ name: 'x_app.user' })`. */
export interface FluentCall {
  kind: "call";
  api: string;
  args: FluentValue[];
  loc: SourceLocation;
  /** The top-level `const` the call initializes directly, if any. */
  binding?: { name: string; exported: boolean };
}

export type FluentValue =
  /**
   * `cast` marks a string written with a type assertion (`'name' as any`),
   * `include` one read from a file by `Now.include()`.
   */
  | { kind: "string"; value: string; loc: SourceLocation; cast?: true; include?: true }
  | { kind: "number"; value: number; loc: SourceLocation }
  | { kind: "boolean"; value: boolean; loc: SourceLocation }
  | { kind: "null"; loc: SourceLocation }
  | { kind: "undefined"; loc: SourceLocation }
  | { kind: "array"; items: FluentValue[]; loc: SourceLocation }
  | { kind: "object"; props: Map<string, FluentValue>; loc: SourceLocation }
  /** `Now.ID['key']` */
  | { kind: "nowId"; key: string; loc: SourceLocation }
  /** `Now.ref(table, guid?, keys?)` */
  | { kind: "ref"; table: string; guid?: string; keys?: Map<string, FluentValue>; loc: SourceLocation }
  /** `Now.attach(path)`: the absolute path of an image file inside the project. */
  | { kind: "attach"; file: string; loc: SourceLocation }
  /** `item.variables.name`: a variable of the call `item` is bound to, by its name. */
  | { kind: "variable"; owner: FluentCall; name: string; loc: SourceLocation }
  /** A template literal with substitutions: `head${spans[0].value}spans[0].text…`. */
  | { kind: "template"; head: string; spans: { value: FluentValue; text: string }[]; loc: SourceLocation }
  | FluentHelper
  /** Test()'s steps function, `(atf) => { atf.server.log({...}) }`. */
  | { kind: "steps"; steps: FluentStep[]; loc: SourceLocation }
  | FluentStepOutput
  /** A template literal inside a step whose substitutions are step outputs. */
  | { kind: "stepTemplate"; head: string; spans: { output: FluentStepOutput; literal: string }[]; loc: SourceLocation }
  /** A member chain of an automation namespace, `ActivityDefinitions.Core.Instruction` (name, then path). */
  | { kind: "sdkRef"; name: string; path: string[]; loc: SourceLocation }
  | FluentAutomation
  /** A function of an automation call, by the value it returns. */
  | { kind: "function"; body: FluentValue; loc: SourceLocation }
  | FluentCall;

/** A call of a `wfa` helper, e.g. `wfa.playbook.lane({...})` (path `['playbook', 'lane']`). */
export interface FluentAutomation {
  kind: "automation";
  path: string[];
  args: FluentValue[];
  loc: SourceLocation;
}

/** The locals of one function being evaluated: its parameters and `const` declarations. */
interface LocalFrame {
  params: Set<string>;
  values: Map<string, FluentValue>;
}

/** One `atf.<category>.<step>(...)` call of a steps function. */
export interface FluentStep {
  /** The callee's names after its root: `['server', 'log']`. */
  path: string[];
  args: FluentValue[];
  loc: SourceLocation;
}

/** An earlier step's output, `inserted.record_id`. */
export interface FluentStepOutput {
  kind: "stepOutput";
  step: FluentStep;
  /** The property path after the step local: `['record_id']`. */
  path: string[];
  loc: SourceLocation;
}

/** A call of the SDK's global `Duration()` or `Time()` data helper. */
export interface FluentHelper {
  kind: "helper";
  name: "Duration" | "Time";
  /** The picked numeric fields (`days`, `hours`, `minutes`, `seconds`). */
  fields: Partial<Record<HelperField, number>>;
  /** The IANA zone given as `Time()`'s second argument. */
  timeZone?: string;
  loc: SourceLocation;
}

type HelperField = "days" | "hours" | "minutes" | "seconds";

/** The image types `Now.attach()` accepts, as the SDK's typings spell them. */
export const ATTACH_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp", ".gif", ".ico", ".svg"];

const HELPER_FIELDS: Record<FluentHelper["name"], readonly HelperField[]> = {
  Duration: ["days", "hours", "minutes", "seconds"],
  Time: ["hours", "minutes", "seconds"],
};

/** Whether `zone` is an IANA time zone the runtime knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type FluentObject = Extract<FluentValue, { kind: "object" }>;

/** A top-level `Now.del(table, sysId)` or `Now.del(table, keys)` statement. */
export interface FluentDeletion {
  table: string;
  /** The sys_id, or the coalesce keys of the record. */
  target: string | Map<string, FluentValue>;
  loc: SourceLocation;
}

interface Binding {
  state: "unevaluated" | "evaluating" | "done" | "failed";
  node?: TS.Expression;
  /** For an import: the module and the exported name. */
  from?: { module: string; name: string };
  value?: FluentValue;
  error?: unknown;
  exported?: boolean;
}

interface ModuleScope {
  file: string;
  source: TS.SourceFile;
  bindings: Map<string, Binding>;
  /** Local name → SDK core API name. */
  apis: Map<string, string>;
  exports: Set<string>;
  /** Top-level `const` names and expression statements, in source order. */
  roots: (string | TS.Expression)[];
}

export class FluentEvaluator {
  /** Every API call, in the order evaluation first reached it. */
  readonly calls: FluentCall[] = [];
  /** Every `Now.del()` statement, in source order. */
  readonly deletions: FluentDeletion[] = [];
  private readonly modules = new Map<string, ModuleScope>();
  /** The step locals in scope while a steps function is evaluated. */
  private stepLocals: Map<string, FluentStep> | undefined;
  /** The locals of the automation functions being evaluated, innermost last. */
  private frames: LocalFrame[] = [];
  /** Whether the arguments of an automation call are being evaluated, where functions are allowed. */
  private inAutomation = false;

  constructor(
    private readonly ts: typeof TS,
    private readonly sink: DiagnosticSink,
    /** `Now.attach()` refuses files outside it. */
    private readonly projectDir: string,
  ) {}

  private loc(node: TS.Node): SourceLocation {
    const source = node.getSourceFile();
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { file: source.fileName, line: line + 1, column: character + 1 };
  }

  private fail(node: TS.Node, message: string): never {
    throw new FluentCompileError(message, this.loc(node));
  }

  /** Evaluate every top-level statement of a file; errors become diagnostics. */
  evaluateFile(file: string): void {
    const scope = this.load(file);
    for (const root of scope.roots) {
      try {
        if (typeof root === "string") this.evaluateBinding(scope, root, scope.source);
        else if (this.ts.isCallExpression(root) && this.isNowMember(root.expression, "del")) this.deletions.push(this.evaluateDeletion(scope, root));
        else this.evaluate(scope, root);
      } catch (e) {
        this.report(e);
      }
    }
  }

  private report(e: unknown): void {
    if (!(e instanceof FluentCompileError)) throw e;
    this.sink.report("error", e.message, e.location);
  }

  private load(file: string): ModuleScope {
    const cached = this.modules.get(file);
    if (cached) return cached;
    const ts = this.ts;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const scope: ModuleScope = { file, source, bindings: new Map(), apis: new Map(), exports: new Set(), roots: [] };
    this.modules.set(file, scope);

    for (const statement of source.statements) {
      try {
        this.declare(scope, statement);
      } catch (e) {
        this.report(e);
      }
    }
    return scope;
  }

  private declare(scope: ModuleScope, statement: TS.Statement): void {
    const ts = this.ts;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) return;
      const module = (statement.moduleSpecifier as TS.StringLiteral).text;
      const named = clause.namedBindings;
      if (clause.name || !named || !ts.isNamedImports(named)) this.fail(statement, "Only named imports are supported in Fluent sources.");
      for (const el of named.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (module === SDK_CORE_MODULE || module === SDK_AUTOMATION_MODULE) scope.apis.set(el.name.text, imported);
        else scope.bindings.set(el.name.text, { state: "unevaluated", from: { module, name: imported } });
      }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        this.fail(statement, "Only `const` declarations are supported in Fluent sources.");
      }
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) this.fail(decl.name, "Destructuring declarations are not supported in Fluent sources.");
        if (!decl.initializer) this.fail(decl, `'${decl.name.text}' has no initializer.`);
        scope.bindings.set(decl.name.text, { state: "unevaluated", node: decl.initializer, exported });
        scope.roots.push(decl.name.text);
        if (exported) scope.exports.add(decl.name.text);
      }
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      scope.roots.push(statement.expression);
      return;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return;
    this.fail(statement, `Unsupported statement in a Fluent source: ${ts.SyntaxKind[statement.kind]}.`);
  }

  private evaluateBinding(scope: ModuleScope, name: string, at: TS.Node): FluentValue {
    if (this.stepLocals?.has(name)) this.fail(at, `'${name}' is a step; reference one of its outputs instead (${name}.<output>).`);
    // A binding is evaluated outside any steps or automation function, whoever reaches it first.
    const { stepLocals, frames, inAutomation } = this;
    this.stepLocals = undefined;
    this.frames = [];
    this.inAutomation = false;
    try {
      return this.evaluateModuleBinding(scope, name, at);
    } finally {
      this.stepLocals = stepLocals;
      this.frames = frames;
      this.inAutomation = inAutomation;
    }
  }

  private evaluateModuleBinding(scope: ModuleScope, name: string, at: TS.Node): FluentValue {
    const binding = scope.bindings.get(name);
    if (!binding) {
      // `default_view` is the platform's default UI view, as `Now.ref()` would name it.
      if (scope.apis.get(name) === "default_view") {
        const loc = this.loc(at);
        return { kind: "ref", table: "sys_ui_view", guid: "Default view", keys: new Map([["name", { kind: "string", value: "NULL", loc }]]), loc };
      }
      if (scope.apis.has(name)) this.fail(at, `'${name}' is an SDK API; call it instead of referencing it.`);
      this.fail(at, `Cannot resolve '${name}'.`);
    }
    if (binding.state === "done") return binding.value as FluentValue;
    if (binding.state === "failed") throw binding.error;
    if (binding.state === "evaluating") this.fail(at, `'${name}' refers to itself.`);
    binding.state = "evaluating";
    try {
      binding.value = binding.from ? this.evaluateImport(scope, binding.from, at) : this.evaluate(scope, binding.node as TS.Expression);
      if (binding.value.kind === "call" && binding.node && this.ts.isCallExpression(binding.node)) {
        binding.value.binding = { name, exported: binding.exported === true };
      }
      binding.state = "done";
      return binding.value;
    } catch (e) {
      binding.state = "failed";
      binding.error = e;
      throw e;
    }
  }

  private evaluateImport(scope: ModuleScope, from: NonNullable<Binding["from"]>, at: TS.Node): FluentValue {
    if (!from.module.startsWith(".")) {
      this.fail(at, `Cannot evaluate '${from.name}' imported from '${from.module}'; only project files, ${SDK_CORE_MODULE} and ${SDK_AUTOMATION_MODULE} can be imported.`);
    }
    const base = path.resolve(path.dirname(scope.file), from.module);
    const candidates = [base, `${base}.ts`, base.replace(/\.js$/, ".ts")];
    const file = candidates.find((c) => c.endsWith(".ts") && fs.existsSync(c));
    if (!file) this.fail(at, `Cannot find module '${from.module}'.`);
    const target = this.load(file);
    if (!target.exports.has(from.name)) this.fail(at, `'${from.module}' has no exported const '${from.name}'.`);
    return this.evaluateBinding(target, from.name, at);
  }

  private evaluate(scope: ModuleScope, node: TS.Expression): FluentValue {
    const ts = this.ts;
    const loc = this.loc(node);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return this.evaluate(scope, node.expression);
    }
    if (ts.isAsExpression(node)) {
      const value = this.evaluate(scope, node.expression);
      return value.kind === "string" ? { ...value, cast: true } : value;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text, loc };
    if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text), loc };
    if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
      if (node.operator === ts.SyntaxKind.MinusToken) return { kind: "number", value: -Number(node.operand.text), loc };
      if (node.operator === ts.SyntaxKind.PlusToken) return { kind: "number", value: Number(node.operand.text), loc };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true, loc };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false, loc };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "null", loc };
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return { kind: "undefined", loc };
      return this.local(node) ?? this.evaluateBinding(scope, node.text, node);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return {
        kind: "array",
        items: node.elements.map((e) => {
          if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) this.fail(e, "Spread elements and holes are not supported in Fluent arrays.");
          return this.evaluate(scope, e);
        }),
        loc,
      };
    }
    if (ts.isObjectLiteralExpression(node)) return this.evaluateObject(scope, node);
    if (ts.isTemplateExpression(node) && this.stepLocals) return this.evaluateTemplate(scope, node);
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans.map((span) => ({ value: this.evaluate(scope, span.expression), text: span.literal.text }));
      return { kind: "template", head: node.head.text, spans, loc };
    }
    const output = this.stepOutput(node);
    if (output) return output;
    const ref = this.automationRef(scope, node);
    if (ref) return ref;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && this.inAutomation) return this.evaluateFunction(scope, node);
    const variable = this.variableReference(scope, node);
    if (variable) return variable;
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : this.literalString(scope, node.argumentExpression);
      if (this.isNowMember(node.expression, "ID")) return { kind: "nowId", key: String(key), loc };
      const constants = this.sdkConstants(scope, node.expression);
      if (constants) {
        const value = Object.hasOwn(constants.values, key) ? constants.values[key] : undefined;
        if (value === undefined) this.fail(node, `'${constants.name}.${key}' is not a known ${constants.name} value.`);
        return { kind: "string", value, loc };
      }
      if (this.stepLocals) this.fail(node, "Invalid expression, expecting a reference to an ATF step");
      this.fail(node, "Only `Now.ID[...]` member access is supported in Fluent sources.");
    }
    if (ts.isCallExpression(node)) return this.evaluateCall(scope, node);
    this.fail(node, `Unsupported expression in a Fluent source: ${ts.SyntaxKind[node.kind]}.`);
  }

  /** `binding.variables.name` on a `const` bound to an API call (a catalog item or variable set). */
  private variableReference(scope: ModuleScope, node: TS.Expression): FluentValue | undefined {
    const ts = this.ts;
    if (!ts.isPropertyAccessExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const { expression: owner, name } = node.expression;
    if (name.text !== "variables" || !ts.isIdentifier(owner) || !scope.bindings.has(owner.text)) return undefined;
    const value = this.evaluateBinding(scope, owner.text, owner);
    return value.kind === "call" ? { kind: "variable", owner: value, name: node.name.text, loc: this.loc(node) } : undefined;
  }

  /** Test()'s steps function: each statement is one step call, optionally stored in a `const`. */
  private evaluateSteps(scope: ModuleScope, node: TS.ArrowFunction | TS.FunctionExpression): FluentValue {
    const ts = this.ts;
    if (this.stepLocals) this.fail(node, "A steps function cannot be nested in a step.");
    if (!ts.isBlock(node.body)) this.fail(node, "A steps function must have a block body: (atf) => { ... }.");
    const steps: FluentStep[] = [];
    const locals = new Map<string, FluentStep>();
    this.stepLocals = locals;
    try {
      for (const statement of node.body.statements) {
        let call: TS.CallExpression;
        let binding: string | undefined;
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          call = statement.expression;
        } else if (ts.isVariableStatement(statement)) {
          const [decl, ...rest] = statement.declarationList.declarations;
          if (rest.length > 0 || !ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) {
            this.fail(statement, "A step's result must be stored as `const name = atf.<category>.<step>({...})`, one per statement.");
          }
          call = decl.initializer;
          binding = decl.name.text;
        } else {
          this.fail(statement, `Unsupported statement in a steps function: ${ts.SyntaxKind[statement.kind]}; only atf.<category>.<step>() calls are supported.`);
        }
        const step: FluentStep = { path: this.stepPath(call.expression), args: call.arguments.map((a) => this.evaluate(scope, a)), loc: this.loc(call) };
        steps.push(step);
        if (binding !== undefined) locals.set(binding, step);
      }
    } finally {
      this.stepLocals = undefined;
    }
    return { kind: "steps", steps, loc: this.loc(node) };
  }

  /** The names of a step callee after its root (`atf.server.log` → server, log). */
  private stepPath(node: TS.Expression): string[] {
    const ts = this.ts;
    if (ts.isIdentifier(node)) return [];
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return [...this.stepPath(node.expression), node.name.text];
    this.fail(node, "A step must be called as atf.<category>.<step>({...}).");
  }

  /** `step.a.b` where `step` is an earlier step's local, inside a steps function. */
  private stepOutput(node: TS.Expression): FluentStepOutput | undefined {
    const ts = this.ts;
    if (!this.stepLocals) return undefined;
    const path: string[] = [];
    let root: TS.Expression = node;
    while (ts.isPropertyAccessExpression(root) && ts.isIdentifier(root.name)) {
      path.unshift(root.name.text);
      root = root.expression;
    }
    const step = path.length > 0 && ts.isIdentifier(root) ? this.stepLocals.get(root.text) : undefined;
    return step && { kind: "stepOutput", step, path, loc: this.loc(node) };
  }

  /** `` `id=${inserted.record_id}` ``: a template whose substitutions are step outputs. */
  private evaluateTemplate(scope: ModuleScope, node: TS.TemplateExpression): FluentValue {
    const spans = node.templateSpans.map((span) => {
      const output = this.evaluate(scope, span.expression);
      if (output.kind !== "stepOutput") this.fail(span.expression, "Invalid expression, expecting a reference to an ATF step");
      return { output, literal: span.literal.text };
    });
    return { kind: "stepTemplate", head: node.head.text, spans, loc: this.loc(node) };
  }

  private literalString(scope: ModuleScope, node: TS.Expression): string | number {
    const value = this.evaluate(scope, node);
    if (value.kind === "string" || value.kind === "number") return value.value;
    this.fail(node, "Expected a string literal.");
  }

  /** The SDK constant map (`AnnotationType`, `Formatter`) an identifier imports, if any. */
  private sdkConstants(scope: ModuleScope, node: TS.Expression): { name: string; values: Readonly<Record<string, string>> } | undefined {
    if (!this.ts.isIdentifier(node) || scope.bindings.has(node.text)) return undefined;
    const name = scope.apis.get(node.text);
    return name !== undefined && Object.hasOwn(SDK_CONSTANTS, name) ? { name, values: SDK_CONSTANTS[name]! } : undefined;
  }

  private isNowMember(node: TS.Expression, member: string): boolean {
    const ts = this.ts;
    return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Now" && node.name.text === member;
  }

  private evaluateObject(scope: ModuleScope, node: TS.ObjectLiteralExpression): FluentObject {
    const ts = this.ts;
    const props = new Map<string, FluentValue>();
    for (const p of node.properties) {
      if (ts.isShorthandPropertyAssignment(p)) {
        props.set(p.name.text, this.evaluateBinding(scope, p.name.text, p.name));
        continue;
      }
      if (!ts.isPropertyAssignment(p)) this.fail(p, "Only plain properties are supported in Fluent objects (no spreads, methods or accessors).");
      const name = p.name;
      if (!(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) {
        this.fail(name, "Computed property names are not supported in Fluent objects.");
      }
      props.set(name.text, this.evaluate(scope, p.initializer));
    }
    return { kind: "object", props, loc: this.loc(node) };
  }

  private evaluateDeletion(scope: ModuleScope, node: TS.CallExpression): FluentDeletion {
    const [table, target] = node.arguments.map((a) => this.evaluate(scope, a));
    if (table?.kind !== "string") this.fail(node, "The first argument to Now.del() must be a table name.");
    if (node.arguments.length !== 2 || (target.kind !== "string" && target.kind !== "object")) {
      this.fail(node, "The second argument to Now.del() must be a sys_id GUID or a coalesce keys object.");
    }
    return { table: table.value, target: target.kind === "string" ? target.value : target.props, loc: this.loc(node) };
  }

  private evaluateCall(scope: ModuleScope, node: TS.CallExpression): FluentValue {
    const ts = this.ts;
    const loc = this.loc(node);
    const callee = node.expression;
    const args = () => node.arguments.map((a) => this.evaluate(scope, a));
    if (this.isNowMember(callee, "include")) {
      const [arg] = args();
      if (node.arguments.length !== 1 || arg.kind !== "string") this.fail(node, "Now.include() takes one string path.");
      const target = path.resolve(path.dirname(scope.file), arg.value);
      if (!fs.existsSync(target)) this.fail(node, `Now.include(): file not found: ${arg.value}`);
      return { kind: "string", value: fs.readFileSync(target, "utf8"), loc, include: true };
    }
    if (this.isNowMember(callee, "ref")) {
      const [table, second, third] = args();
      if (table?.kind !== "string") this.fail(node, "Now.ref() needs a table name as its first argument.");
      if (second?.kind === "object" && third === undefined) return { kind: "ref", table: table.value, keys: second.props, loc };
      if (second?.kind === "string" && (third === undefined || third.kind === "object")) {
        return { kind: "ref", table: table.value, guid: second.value, keys: third?.props, loc };
      }
      this.fail(node, "Now.ref() takes (table, keys) or (table, guid, keys?).");
    }
    if (this.isNowMember(callee, "attach")) return this.evaluateAttach(scope, node);
    if (this.isNowMember(callee, "del")) this.fail(node, "Now.del() is a top-level statement; it cannot be used inside another definition.");
    if (ts.isIdentifier(callee) && Object.hasOwn(HELPER_FIELDS, callee.text) && !scope.bindings.has(callee.text) && !scope.apis.has(callee.text)) {
      return this.evaluateHelper(node, callee.text as FluentHelper["name"], args());
    }
    const helper = this.automationRef(scope, callee);
    if (helper) {
      if (helper.name !== "wfa") this.fail(node, `'${helper.name}' is not a function.`);
      return { kind: "automation", path: helper.path, args: this.automationArgs(scope, node), loc };
    }
    const api = ts.isIdentifier(callee) ? scope.apis.get(callee.text) : undefined;
    if (!api) this.fail(node, `Only calls of ${SDK_CORE_MODULE} APIs, Now.include(), Now.ref(), Now.attach() and Now.del() are supported in Fluent sources.`);
    // Test()'s second argument is its steps function, the one place a function is allowed.
    const values =
      api === "PlaybookDefinition"
        ? this.automationArgs(scope, node)
        : node.arguments.map((a, i) =>
            api === "Test" && i === 1 && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ? this.evaluateSteps(scope, a) : this.evaluate(scope, a),
          );
    const call: FluentCall = { kind: "call", api, args: values, loc };
    this.calls.push(call);
    return call;
  }

  /** The arguments of an automation call, where functions are allowed. */
  private automationArgs(scope: ModuleScope, node: TS.CallExpression): FluentValue[] {
    const outer = this.inAutomation;
    this.inAutomation = true;
    try {
      return node.arguments.map((a) => this.evaluate(scope, a));
    } finally {
      this.inAutomation = outer;
    }
  }

  /** `a.b.c` rooted at an imported automation namespace (`wfa`, `ActivityDefinitions`, …). */
  private automationRef(scope: ModuleScope, node: TS.Expression): Extract<FluentValue, { kind: "sdkRef" }> | undefined {
    const ts = this.ts;
    const path: string[] = [];
    let root: TS.Expression = node;
    while (ts.isPropertyAccessExpression(root) && ts.isIdentifier(root.name)) {
      path.unshift(root.name.text);
      root = root.expression;
    }
    if (path.length === 0 || !ts.isIdentifier(root) || scope.bindings.has(root.text) || this.isLocal(root.text)) return undefined;
    const name = scope.apis.get(root.text);
    return name !== undefined && AUTOMATION_NAMESPACES.has(name) ? { kind: "sdkRef", name, path, loc: this.loc(node) } : undefined;
  }

  private isLocal(name: string): boolean {
    return this.frames.some((f) => f.params.has(name) || f.values.has(name));
  }

  /** The value of a function local, innermost first; a parameter cannot be evaluated statically. */
  private local(node: TS.Identifier): FluentValue | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame.params.has(node.text)) this.fail(node, `Referencing the parameter '${node.text}' is not supported by the native compiler yet.`);
      const value = frame.values.get(node.text);
      if (value) return value;
    }
    return undefined;
  }

  /** A function of an automation call: an expression body, or `const` declarations and one `return`. */
  private evaluateFunction(scope: ModuleScope, node: TS.ArrowFunction | TS.FunctionExpression): FluentValue {
    const ts = this.ts;
    const frame: LocalFrame = { params: new Set(), values: new Map() };
    for (const p of node.parameters) {
      if (!ts.isIdentifier(p.name)) this.fail(p, "Destructured parameters are not supported in Fluent functions.");
      frame.params.add(p.name.text);
    }
    this.frames.push(frame);
    try {
      if (!ts.isBlock(node.body)) return { kind: "function", body: this.evaluate(scope, node.body), loc: this.loc(node) };
      const statements = node.body.statements;
      for (const [index, statement] of statements.entries()) {
        if (ts.isReturnStatement(statement) && statement.expression && index === statements.length - 1) {
          return { kind: "function", body: this.evaluate(scope, statement.expression), loc: this.loc(node) };
        }
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) {
          this.fail(statement, "A Fluent function may only declare `const` locals and end with `return <value>`.");
        }
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) this.fail(decl, "A Fluent function local must be `const name = <value>`.");
          frame.values.set(decl.name.text, this.evaluate(scope, decl.initializer));
        }
      }
      this.fail(node, "A Fluent function must end with `return <value>`.");
    } finally {
      this.frames.pop();
    }
  }

  /** `Now.attach(path)`, checked as the SDK checks it; the path is relative to the source file. */
  private evaluateAttach(scope: ModuleScope, node: TS.CallExpression): FluentValue {
    const at = node.arguments[0] ?? node;
    const arg = node.arguments[0] && this.evaluate(scope, node.arguments[0]);
    if (arg?.kind !== "string") this.fail(at, "Now.attach() must have a string argument");
    const relative = arg.value;
    if (!/^\.\.?\/.*$/.test(relative.trim()) && relative.includes("/")) this.fail(at, "Now.attach() argument must be a relative path");
    const ext = path.extname(relative);
    // The SDK's typings take the extensions in lower or upper case only.
    if (!ATTACH_EXTENSIONS.includes(ext.toLowerCase()) || (ext !== ext.toLowerCase() && ext !== ext.toUpperCase())) {
      this.fail(at, `Now.attach() takes an image file: ${ATTACH_EXTENSIONS.join(", ")}.`);
    }
    const file = path.resolve(path.dirname(scope.file), relative);
    if (path.relative(this.projectDir, file).startsWith("..")) this.fail(at, `File path is not within project: ${file}`);
    if (!fs.existsSync(file)) this.fail(at, "File not found");
    return { kind: "attach", file, loc: this.loc(node) };
  }

  /** `Duration({...})` / `Time({...}, zone?)`, checked as the SDK's data plugin checks them. */
  private evaluateHelper(node: TS.CallExpression, name: FluentHelper["name"], args: FluentValue[]): FluentHelper {
    const [data, zone] = args;
    const names = HELPER_FIELDS[name];
    if (data?.kind !== "object" || args.length > (name === "Time" ? 2 : 1)) {
      this.fail(node, name === "Time" ? "Time() takes an object of hours, minutes and seconds, and an optional time zone." : "Duration() takes an object of days, hours, minutes and seconds.");
    }
    const defined = names.filter((n) => data.props.has(n) && data.props.get(n)!.kind !== "undefined");
    if (defined.length === 0) {
      this.fail(node, `${name} must have at least one field defined (${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]})`);
    }
    const negative = defined.flatMap((n) => {
      const v = data.props.get(n)!;
      return v.kind === "number" && v.value < 0 ? [`${n} must be >= 0, got ${v.value}`] : [];
    });
    if (negative.length > 0) this.fail(node, `Invalid ${name.toLowerCase()} values: ${negative.join(", ")}`);
    const fields: FluentHelper["fields"] = {};
    for (const n of defined) {
      const v = data.props.get(n)!;
      if (v.kind !== "number") this.fail(node, `fields in ${name} object can only contain numbers, got ${v.kind}`);
      fields[n] = v.value;
    }
    const helper: FluentHelper = { kind: "helper", name, fields, loc: this.loc(node) };
    if (zone === undefined || zone.kind === "undefined") return helper;
    if (zone.kind !== "string") this.fail(node, "Second argument (timezone) must be a string literal");
    if (!isValidTimeZone(zone.value)) {
      this.fail(node, `Invalid IANA timezone: '${zone.value}'. Use a valid timezone like 'America/New_York', 'Europe/London', or 'UTC'.`);
    }
    return { ...helper, timeZone: zone.value };
  }
}
