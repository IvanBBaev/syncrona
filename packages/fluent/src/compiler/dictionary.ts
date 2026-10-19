// SPDX-License-Identifier: GPL-3.0-or-later
//
// Build validation against the dictionary: the table and column names a
// project's Fluent calls refer to are checked against the tables the project
// defines and, when present, the table types `syncrona fluent types --native`
// generated from the instance's sys_dictionary.
//
// The SDK accepts any table or column name (its types widen both to
// `string`), so an unknown name is a warning, never an error:
//
// - a table is checked only when the dictionary types exist, since without
//   them any table the project does not define could still live on the
//   instance;
// - a column is checked only when every table in its table's `extends` chain
//   is known, from the project or the dictionary types. A table the project
//   only adds columns to (one without its scope prefix) is known through the
//   dictionary types alone.

import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import type { FluentDiagnosticSeverity, SourceLocation } from "./diagnostics";

/** Where `syncrona fluent types --native` writes by default, relative to the project. */
export const DICTIONARY_TYPES_FILE = path.join("@types", "syncrona", "tables.d.ts");

/** Columns every table has, which a project's Table() schema never lists. */
const SYSTEM_COLUMNS = [
  "sys_class_name",
  "sys_created_by",
  "sys_created_on",
  "sys_id",
  "sys_mod_count",
  "sys_tags",
  "sys_updated_by",
  "sys_updated_on",
];

export interface DictionaryTable {
  superClass?: string;
  columns: Set<string>;
}

/** Tables by name, as the dictionary types describe them. */
export type Dictionary = Map<string, DictionaryTable>;

function memberName(ts: typeof TS, name: TS.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * Reads the tables of a `fluent types --native` file: the `Tables` interface
 * maps each table name to its interface, an interface's members are the
 * table's own columns, and its heritage (`Parent` or `Omit<Parent, …>`) names
 * the parent. A parent the generator could not read appears only in the doc
 * comment ("Extends `x`, which could not be read").
 */
export function parseDictionaryTypes(ts: typeof TS, text: string, fileName: string): Dictionary {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const interfaces = new Map<string, TS.InterfaceDeclaration>();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
  const tables = interfaces.get("Tables");
  if (!tables) throw new Error("it has no 'Tables' interface; regenerate it with `syncrona fluent types --native`.");
  const nameOf = new Map<string, string>();
  for (const member of tables.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type)) continue;
    const table = memberName(ts, member.name);
    if (table !== undefined) nameOf.set(member.type.typeName.getText(source), table);
  }

  const dictionary: Dictionary = new Map();
  for (const [id, table] of nameOf) {
    const declaration = interfaces.get(id);
    if (!declaration) continue;
    const columns = new Set<string>();
    for (const member of declaration.members) {
      const column = ts.isPropertySignature(member) ? memberName(ts, member.name) : undefined;
      if (column !== undefined) columns.add(column);
    }
    let superClass: string | undefined;
    const heritage = declaration.heritageClauses?.[0].types[0];
    if (heritage) {
      // `extends Parent`, or `extends Omit<Parent, …>` when the table redeclares a parent column.
      superClass = nameOf.get((heritage.typeArguments?.[0] ?? heritage.expression).getText(source));
    } else {
      superClass = /Extends `([^`]+)`/.exec(declaration.getFullText(source).slice(0, declaration.getLeadingTriviaWidth(source)))?.[1];
    }
    dictionary.set(table, { ...(superClass === undefined ? {} : { superClass }), columns });
  }
  return dictionary;
}

interface ProjectTable extends DictionaryTable {
  /** The project creates the table (its name carries the scope prefix), so it knows every own column. */
  owned: boolean;
}

interface Reference {
  api: string;
  table: string;
  location: SourceLocation;
  column?: { name: string; location: SourceLocation };
}

type Report = (severity: FluentDiagnosticSeverity, message: string, location: SourceLocation) => void;

/** Collects what a compile defines and refers to, and checks it once every call is built. */
export class DictionaryChecks {
  private readonly tables = new Map<string, ProjectTable>();
  private readonly references: Reference[] = [];

  /** A Table() of the project. */
  declareTable(name: string, superClass: string | undefined, columns: readonly string[], owned: boolean): void {
    const known = this.tables.get(name);
    if (known) {
      for (const column of columns) known.columns.add(column);
      return;
    }
    this.tables.set(name, { ...(superClass === undefined ? {} : { superClass }), columns: new Set(columns), owned });
  }

  /** A table name an API call refers to, with the column it names, if any. */
  refer(api: string, table: string, location: SourceLocation, column?: { name: string; location: SourceLocation }): void {
    this.references.push({ api, table, location, ...(column === undefined ? {} : { column }) });
  }

  check(dictionary: Dictionary | undefined, report: Report): void {
    const source = dictionary ? ` or in the dictionary types (${DICTIONARY_TYPES_FILE})` : "";
    const known = (table: string) => this.tables.has(table) || dictionary?.has(table) === true;
    // A call that names several columns of one table reports an unknown table once.
    const reported = new Set<string>();
    for (const ref of this.references) {
      // UI actions on `global` apply to every table.
      if (ref.table === "global") continue;
      if (!known(ref.table)) {
        const at = `${ref.api} ${ref.table} ${ref.location.file}:${ref.location.line}:${ref.location.column}`;
        if (dictionary && !reported.has(at)) {
          reported.add(at);
          report("warning", `${ref.api}(): table '${ref.table}' is not defined in this project${source}.`, ref.location);
        }
        continue;
      }
      if (ref.column === undefined) continue;
      const columns = this.columnsOf(ref.table, dictionary);
      if (columns && !columns.has(ref.column.name)) {
        report(
          "warning",
          `${ref.api}(): table '${ref.table}' has no column '${ref.column.name}' in this project${source}.`,
          ref.column.location,
        );
      }
    }
  }

  /** Every column of a table, own and inherited, or undefined when part of its `extends` chain is unknown. */
  private columnsOf(table: string, dictionary: Dictionary | undefined): Set<string> | undefined {
    const columns = new Set(SYSTEM_COLUMNS);
    const seen = new Set<string>();
    let at: string | undefined = table;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const project = this.tables.get(at);
      const entry: DictionaryTable | undefined = dictionary?.get(at);
      if (!entry && !project?.owned) return undefined;
      for (const column of [...(project?.columns ?? []), ...(entry?.columns ?? [])]) columns.add(column);
      at = project?.superClass ?? entry?.superClass;
    }
    return columns;
  }
}

/**
 * Reads the project's dictionary types, if it has them. A file that cannot be
 * read is reported and skipped: validation is a check, never a reason to fail.
 */
export function readDictionary(ts: typeof TS, projectDir: string, report: Report): Dictionary | undefined {
  const file = path.join(projectDir, DICTIONARY_TYPES_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parseDictionaryTypes(ts, fs.readFileSync(file, "utf8"), file);
  } catch (e) {
    report("warning", `Dictionary types are skipped: ${(e as Error).message}`, { file, line: 1, column: 1 });
    return undefined;
  }
}
