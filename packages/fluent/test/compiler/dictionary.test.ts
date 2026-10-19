// SPDX-License-Identifier: GPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DICTIONARY_TYPES_FILE, parseDictionaryTypes } from "../../src/compiler/dictionary";
import { compile, messages } from "./helpers";

// fixtures/dictionary/tables.d.ts is real `syncrona fluent types --native`
// output: `task`, `x_snc_bprobe_child extends task` (redeclaring `state`, so
// it extends `Omit<task, "state">`) and `x_snc_bprobe_orphan`, whose parent
// `x_missing` could not be read.
const TYPES = fs.readFileSync(path.join(__dirname, "../fixtures/dictionary/tables.d.ts"), "utf8");
const WITH_TYPES = { [DICTIONARY_TYPES_FILE]: TYPES };
const T = "x_snc_bprobe_t";
const table = (name: string, schema: string, options = "") =>
  `export const ${name} = Table({ name: '${name}', schema: { ${schema} }${options} })\n`;
const warnings = (source: string, files: Record<string, string> = {}) => messages(compile(source, files), "warning");

describe("parseDictionaryTypes", () => {
  it("reads the tables, their own columns and their parents from fluent types --native output", () => {
    const dictionary = parseDictionaryTypes(ts, TYPES, "tables.d.ts");
    expect([...dictionary.keys()]).toEqual(["task", "x_snc_bprobe_child", "x_snc_bprobe_orphan"]);
    expect(dictionary.get("task")).toEqual({ columns: new Set(["number", "state", "sys_id"]) });
    expect(dictionary.get("x_snc_bprobe_child")).toEqual({
      superClass: "task",
      columns: new Set(["state", "u-dash", "x_snc_bprobe_note"]),
    });
    expect(dictionary.get("x_snc_bprobe_orphan")).toEqual({ superClass: "x_missing", columns: new Set() });
  });

  it("skips Tables entries and members it cannot read", () => {
    const text = `
      declare const sym: unique symbol;
      export interface a { plain: string; [key: string]: unknown; [sym]: string; method(): void; }
      export interface b extends a {}
      export interface Tables {
        a: a;
        "b": b;
        missing: missing;
        untyped;
        literal: string;
        call(): a;
        [k: string]: a;
        [sym]: a;
      }
    `;
    expect(parseDictionaryTypes(ts, text, "t.d.ts")).toEqual(
      new Map([
        ["a", { columns: new Set(["plain"]) }],
        ["b", { superClass: "a", columns: new Set() }],
      ]),
    );
  });

  it("refuses a file without a Tables interface", () => {
    expect(() => parseDictionaryTypes(ts, "export interface task {}\n", "t.d.ts")).toThrow(
      "it has no 'Tables' interface; regenerate it with `syncrona fluent types --native`.",
    );
  });
});

describe("build validation against the dictionary", () => {
  it("checks the columns of the project's own tables without dictionary types", () => {
    const source = [
      table(T, "x_snc_bprobe_note: StringColumn({})"),
      `Acl({ $id: 'a1', type: 'record', operation: 'read', table: '${T}', field: 'x_snc_bprobe_note', roles: ['admin'] })`,
      `Acl({ $id: 'a2', type: 'record', operation: 'read', table: '${T}', field: 'sys_created_on', roles: ['admin'] })`,
      `Acl({ $id: 'a3', type: 'record', operation: 'read', table: '${T}', field: '*', roles: ['admin'] })`,
      `Acl({ $id: 'a4', type: 'record', operation: 'read', table: '${T}', roles: ['admin'] })`,
      `Acl({ $id: 'a5', type: 'record', operation: 'read', table: '${T}', field: 'x_snc_bprobe_typo', roles: ['admin'] })`,
      `ClientScript({ $id: 'c1', name: 'C', table: '${T}', type: 'onChange', field: 'nope' })`,
      `ClientScript({ $id: 'c2', name: 'C2', type: 'onLoad' })`,
      // Tables the project does not define could live on the instance.
      `BusinessRule({ $id: 'b1', name: 'B', table: 'incident' })`,
      `Acl({ $id: 'a6', type: 'record', operation: 'read', table: 'incident', field: 'nope', roles: ['admin'] })`,
    ].join("\n");
    const result = compile(source);
    expect(result.ok).toBe(true);
    expect(messages(result, "warning")).toEqual([
      `Acl(): table '${T}' has no column 'x_snc_bprobe_typo' in this project.`,
      `ClientScript(): table '${T}' has no column 'nope' in this project.`,
    ]);
    const [acl, clientScript] = result.diagnostics;
    expect(acl).toMatchObject({ severity: "warning", line: 8 });
    expect(clientScript).toMatchObject({ severity: "warning", line: 9 });
  });

  it("skips the columns of a table whose parent is unknown", () => {
    const source = [
      table(T, "x_snc_bprobe_note: StringColumn({})", ", extends: 'task'"),
      `Acl({ $id: 'a1', type: 'record', operation: 'read', table: '${T}', field: 'anything', roles: ['admin'] })`,
    ].join("\n");
    expect(warnings(source)).toEqual([]);
  });

  it("checks tables and columns against the dictionary types", () => {
    const source = [
      table(T, "x_snc_bprobe_ref: ReferenceColumn({ referenceTable: 'x_snc_bprobe_nope' })", ", extends: 'x_snc_bprobe_child'"),
      table("x_snc_bprobe_u", "x_snc_bprobe_ref: ReferenceColumn({ referenceTable: 'task' })", ", extends: 'x_snc_bprobe_gone'"),
      `BusinessRule({ $id: 'b1', name: 'B', table: 'incident' })`,
      `BusinessRule({ $id: 'b2', name: 'B2', table: '${T}' })`,
      `UiAction({ $id: 'u1', name: 'U', table: 'global' })`,
      `UiAction({ $id: 'u2', name: 'U2', table: 'x_snc_bprobe_child' })`,
      // Inherited (task), redeclared, quoted, own and project-declared columns.
      ...["number", "state", "u-dash", "x_snc_bprobe_note", "x_snc_bprobe_ref", "sys_id", "bogus"].map(
        (field, i) => `Acl({ $id: 'f${i}', type: 'record', operation: 'read', table: '${T}', field: '${field}', roles: ['admin'] })`,
      ),
      // The orphan's parent could not be read, so its columns are not checked.
      `Acl({ $id: 'o1', type: 'record', operation: 'read', table: 'x_snc_bprobe_orphan', field: 'anything', roles: ['admin'] })`,
      // Only record ACLs name a table.
      `Acl({ $id: 'r1', type: 'rest_endpoint', operation: 'execute', name: 'x_snc_bprobe_api', roles: ['admin'] })`,
    ].join("\n");
    const result = compile(source, WITH_TYPES);
    expect(result.ok).toBe(true);
    const where = ` in this project or in the dictionary types (${DICTIONARY_TYPES_FILE}).`;
    expect(messages(result, "warning")).toEqual([
      `ReferenceColumn(): table 'x_snc_bprobe_nope' is not defined${where}`,
      `Table(): table 'x_snc_bprobe_gone' is not defined${where}`,
      `BusinessRule(): table 'incident' is not defined${where}`,
      `Acl(): table '${T}' has no column 'bogus'${where}`,
    ]);
  });

  it("checks the table of a Record() and the columns its data sets", () => {
    const source = [
      `Record({ $id: 'r1', table: 'x_snc_bprobe_child', data: { number: 'N1', x_snc_bprobe_note: 'n', bogus: 1 } })`,
      // An unknown table is reported once, however many columns the data sets.
      `Record({ $id: 'r2', table: 'x_snc_bprobe_nope', data: { a: 1, b: 2 } })`,
      `Record({ $id: 'r3', table: 'x_snc_bprobe_nope', data: {} })`,
    ].join("\n");
    const where = ` in this project or in the dictionary types (${DICTIONARY_TYPES_FILE}).`;
    expect(warnings(source, WITH_TYPES)).toEqual([
      `Record(): table 'x_snc_bprobe_child' has no column 'bogus'${where}`,
      `Record(): table 'x_snc_bprobe_nope' is not defined${where}`,
      `Record(): table 'x_snc_bprobe_nope' is not defined${where}`,
    ]);
  });

  it("checks the table of a TableCheck()", () => {
    const check = (id: string, name: string) =>
      `TableCheck({ $id: '${id}', name: 'C', category: 'security', priority: '2', shortDescription: 'S', table: '${name}' })`;
    const source = [check("c1", "x_snc_bprobe_child"), check("c2", "x_snc_bprobe_nope")].join("\n");
    const where = ` in this project or in the dictionary types (${DICTIONARY_TYPES_FILE}).`;
    expect(warnings(source, WITH_TYPES)).toEqual([`TableCheck(): table 'x_snc_bprobe_nope' is not defined${where}`]);
  });

  it("adds every Table() of the same name to one table", () => {
    const files = {
      "src/fluent/b.now.ts": `import { Table, StringColumn } from '@servicenow/sdk/core'\n${table(T, "x_snc_bprobe_b: StringColumn({})")}`,
    };
    const source = [
      table(T, "x_snc_bprobe_a: StringColumn({})"),
      `Acl({ $id: 'a1', type: 'record', operation: 'read', table: '${T}', field: 'x_snc_bprobe_b', roles: ['admin'] })`,
    ].join("\n");
    expect(warnings(source, files)).toEqual([]);
  });

  it("skips dictionary types it cannot read, with a warning", () => {
    const result = compile(`BusinessRule({ $id: 'b1', name: 'B', table: 'incident' })`, {
      [DICTIONARY_TYPES_FILE]: "export interface task {}\n",
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        message:
          "Dictionary types are skipped: it has no 'Tables' interface; regenerate it with `syncrona fluent types --native`.",
        line: 1,
        column: 1,
      }),
    ]);
    expect(result.diagnostics[0].file.endsWith(DICTIONARY_TYPES_FILE)).toBe(true);
  });
});
