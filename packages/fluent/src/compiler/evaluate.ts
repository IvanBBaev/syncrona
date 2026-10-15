// SPDX-License-Identifier: GPL-3.0-or-later
//
// A static evaluator for Fluent sources. Fluent files are declarative: calls
// of the `@servicenow/sdk/core` APIs whose arguments are literals, `Now.ID`,
// `Now.ref`, `Now.include` and references to other calls through `const`
// bindings (also imported from other project files). The evaluator turns them
// into plain values without running any code; anything outside that subset is
// a compile error naming the construct, never a silent guess.

import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import { FluentCompileError, type DiagnosticSink, type SourceLocation } from "./diagnostics";

export const SDK_CORE_MODULE = "@servicenow/sdk/core";

/** A call of an SDK core API, e.g. `Role({ name: 'x_app.user' })`. */
export interface FluentCall {
  kind: "call";
  api: string;
  args: FluentValue[];
  loc: SourceLocation;
}

export type FluentValue =
  | { kind: "string"; value: string; loc: SourceLocation }
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
  | FluentCall;

export type FluentObject = Extract<FluentValue, { kind: "object" }>;

interface Binding {
  state: "unevaluated" | "evaluating" | "done" | "failed";
  node?: TS.Expression;
  /** For an import: the module and the exported name. */
  from?: { module: string; name: string };
  value?: FluentValue;
  error?: unknown;
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
  private readonly modules = new Map<string, ModuleScope>();

  constructor(
    private readonly ts: typeof TS,
    private readonly sink: DiagnosticSink,
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
        if (module === SDK_CORE_MODULE) scope.apis.set(el.name.text, imported);
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
        scope.bindings.set(decl.name.text, { state: "unevaluated", node: decl.initializer });
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
    const binding = scope.bindings.get(name);
    if (!binding) {
      if (scope.apis.has(name)) this.fail(at, `'${name}' is an SDK API; call it instead of referencing it.`);
      this.fail(at, `Cannot resolve '${name}'.`);
    }
    if (binding.state === "done") return binding.value as FluentValue;
    if (binding.state === "failed") throw binding.error;
    if (binding.state === "evaluating") this.fail(at, `'${name}' refers to itself.`);
    binding.state = "evaluating";
    try {
      binding.value = binding.from ? this.evaluateImport(scope, binding.from, at) : this.evaluate(scope, binding.node as TS.Expression);
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
      this.fail(at, `Cannot evaluate '${from.name}' imported from '${from.module}'; only project files and ${SDK_CORE_MODULE} can be imported.`);
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
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return this.evaluate(scope, node.expression);
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
      return this.evaluateBinding(scope, node.text, node);
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
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : this.literalString(scope, node.argumentExpression);
      if (this.isNowMember(node.expression, "ID")) return { kind: "nowId", key: String(key), loc };
      this.fail(node, "Only `Now.ID[...]` member access is supported in Fluent sources.");
    }
    if (ts.isCallExpression(node)) return this.evaluateCall(scope, node);
    this.fail(node, `Unsupported expression in a Fluent source: ${ts.SyntaxKind[node.kind]}.`);
  }

  private literalString(scope: ModuleScope, node: TS.Expression): string | number {
    const value = this.evaluate(scope, node);
    if (value.kind === "string" || value.kind === "number") return value.value;
    this.fail(node, "Expected a string literal.");
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
      return { kind: "string", value: fs.readFileSync(target, "utf8"), loc };
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
    const api = ts.isIdentifier(callee) ? scope.apis.get(callee.text) : undefined;
    if (!api) this.fail(node, `Only calls of ${SDK_CORE_MODULE} APIs, Now.include() and Now.ref() are supported in Fluent sources.`);
    const call: FluentCall = { kind: "call", api, args: args(), loc };
    this.calls.push(call);
    return call;
  }
}
