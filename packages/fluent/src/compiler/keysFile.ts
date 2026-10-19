// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reads and writes `generated/keys.ts`, the declaration file the SDK keeps the
// keys registry in:
//
//   declare global { namespace Now { namespace Internal {
//     interface Keys extends KeysRegistry { explicit: {...}; composite: [...] }
//   } } }
//
// The reader walks the interface's type literals with the TypeScript parser.
// The writer reproduces the SDK's output byte for byte — JSON5 with a 4-space
// indent, formatted by prettier with the SDK's settings (single quotes, no
// semicolons, ES5 trailing commas, 120 columns, 4-space tabs). A project's own
// prettier configuration, which the SDK would apply on top, is not read.

import type * as TS from "typescript";
import type { CompositeKey, ExplicitKey, KeysData, NestedKey, SerializedKeys } from "./keys";

export const KEYS_FILE_NAME = "keys.ts";

export class KeysFileError extends Error {
  constructor(message: string) {
    super(`Keys registry is malformed: ${message}`);
    this.name = "KeysFileError";
  }
}

// --- Reader -------------------------------------------------------------------

type Parsed = string | number | boolean | Parsed[] | { [key: string]: Parsed };

function findModule(ts: typeof TS, statements: readonly TS.Statement[], name: string): TS.ModuleBlock {
  for (const s of statements) {
    if (ts.isModuleDeclaration(s) && s.name.text === name && s.body && ts.isModuleBlock(s.body)) return s.body;
  }
  throw new KeysFileError(`no \`${name}\` namespace`);
}

function parseType(ts: typeof TS, node: TS.TypeNode, where: string): Parsed {
  if (ts.isTypeLiteralNode(node)) {
    const out: Record<string, Parsed> = {};
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) throw new KeysFileError(`unsupported member in ${where}`);
      const name = member.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
      if (key === undefined) throw new KeysFileError(`unsupported property name in ${where}`);
      out[key] = parseType(ts, member.type, `${where}.${key}`);
    }
    return out;
  }
  if (ts.isTupleTypeNode(node)) return node.elements.map((e, i) => parseType(ts, e as TS.TypeNode, `${where}[${i}]`));
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) return lit.text;
    if (ts.isNumericLiteral(lit)) return Number(lit.text);
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return false;
  }
  throw new KeysFileError(`unsupported type at ${where}`);
}

function isRecord(v: Parsed | undefined): v is { [key: string]: Parsed } {
  return typeof v === "object" && !Array.isArray(v);
}

function validateNested(v: Parsed, where: string): SerializedKeys {
  if (!isRecord(v)) throw new KeysFileError(`${where} must be an object`);
  const out: SerializedKeys = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === "string") out[k] = value;
    else if (isRecord(value) && typeof value.id === "string") {
      out[k] = { id: value.id, key: validateNested(value.key, `${where}.${k}.key`) } satisfies NestedKey;
    } else throw new KeysFileError(`${where}.${k} must be a string or { id, key }`);
  }
  return out;
}

function validateEntry(v: Parsed, where: string): ExplicitKey {
  if (!isRecord(v) || typeof v.table !== "string" || typeof v.id !== "string") {
    throw new KeysFileError(`${where} needs a string table and id`);
  }
  if (v.deleted !== undefined && typeof v.deleted !== "boolean") throw new KeysFileError(`${where}.deleted must be a boolean`);
  return { table: v.table, id: v.id, ...(v.deleted !== undefined ? { deleted: v.deleted } : {}) };
}

/** Parse the text of a keys.ts file into registry data. */
export function parseKeysFile(ts: typeof TS, text: string, fileName = KEYS_FILE_NAME): KeysData {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const internal = findModule(ts, findModule(ts, findModule(ts, source.statements, "global").statements, "Now").statements, "Internal");
  const keys = internal.statements.find((s): s is TS.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "Keys");
  if (!keys) throw new KeysFileError("no `Keys` interface");
  const root = parseType(ts, ts.factory.createTypeLiteralNode(keys.members), "Keys") as Record<string, Parsed>;

  const data: KeysData = { explicit: {}, composite: [], deleted: {} };
  if (root.explicit !== undefined) {
    if (!isRecord(root.explicit)) throw new KeysFileError("explicit must be an object");
    for (const [k, v] of Object.entries(root.explicit)) data.explicit[k] = validateEntry(v, `explicit.${k}`);
  }
  if (root.composite !== undefined) {
    if (!Array.isArray(root.composite)) throw new KeysFileError("composite must be a tuple");
    data.composite = root.composite.map((v, i): CompositeKey => {
      const entry = validateEntry(v, `composite[${i}]`);
      return { ...entry, key: validateNested((v as Record<string, Parsed>).key, `composite[${i}].key`) };
    });
  }
  if (root.deleted !== undefined) {
    if (!isRecord(root.deleted)) throw new KeysFileError("deleted must be an object");
    for (const [k, v] of Object.entries(root.deleted)) {
      if (!Array.isArray(v) || v.some((id) => typeof id !== "string")) {
        throw new KeysFileError(`deleted.${k} must be a tuple of strings`);
      }
      data.deleted[k] = v as string[];
    }
  }
  return data;
}

// --- Writer -------------------------------------------------------------------

const PRINT_WIDTH = 120;
const INDENT = "    ";

function isIdentifierName(key: string): boolean {
  // ES identifier parts also allow ZWNJ and ZWJ (ECMA-262 IdentifierPartChar).
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(key);
}

function quote(value: string): string {
  const singles = value.split("'").length - 1;
  const doubles = value.split('"').length - 1;
  const q = singles > doubles ? '"' : "'";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === q || ch === "\\") out += `\\${ch}`;
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\v") out += "\\v";
    else if (ch === "\0") out += "\\0";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (ch === " " || ch === " ") out += `\\u${code.toString(16)}`;
    else out += ch;
  }
  return q + out + q;
}

type Writable = string | number | boolean | Writable[] | { [key: string]: Writable | undefined };

function render(value: Writable, depth: number, prefixWidth: number): string {
  if (typeof value === "string") return quote(value);
  if (typeof value !== "object") return String(value);
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => typeof v !== "object")) {
      const flat = `[${value.map((v) => render(v, depth + 1, 0)).join(", ")}]`;
      if (prefixWidth + flat.length <= PRINT_WIDTH) return flat;
    }
    return `[\n${value.map((v) => `${pad}${render(v, depth + 1, pad.length)},\n`).join("")}${close}]`;
  }
  const entries = Object.entries(value).filter((e): e is [string, Writable] => e[1] !== undefined);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => {
    const head = `${pad}${isIdentifierName(k) ? k : quote(k)}: `;
    return `${head}${render(v, depth + 1, head.length)}\n`;
  });
  return `{\n${lines.join("")}${close}}`;
}

/** The text of a keys.ts file holding `registry`. */
export function writeKeysFile(registry: Partial<KeysData>): string {
  const body = render(registry as Writable, 3, 0);
  return `import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry ${body}
        }
    }
}
`;
}
