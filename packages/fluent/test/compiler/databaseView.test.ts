// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const view = (name: string, tables = "[]") => `DatabaseView({ name: '${name}', tables: ${tables} })\n`;

describe("DatabaseView()", () => {
  it("writes the SDK's defaults for a view and its tables", () => {
    const result = compile(view("x_snc_bprobe_v", "[{ $id: 't1', table: 'incident' }, { $id: 't2', table: 'sys_user', order: 200, fields: [] }]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_db_view")).toEqual([expect.objectContaining({ name: "x_snc_bprobe_v", label: "", plural: "", description: "" })]);
    expect(only(result, "sys_db_view_table")).toEqual([
      expect.objectContaining({ table: "incident", active: "true", left_join: "false", order: "100", where_clause: "", variable_prefix: undefined }),
      expect.objectContaining({ table: "sys_user", order: "200" }),
    ]);
    expect(only(result, "sys_db_view_table_field")).toEqual([]);
  });

  it("writes a view without tables", () => {
    const result = compile("DatabaseView({ name: 'x_snc_bprobe_v' })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_db_view")).toHaveLength(1);
    expect(only(result, "sys_db_view_table")).toEqual([]);
  });

  it("refuses a name the platform would rewrite", () => {
    expect(messages(compile(view("x_snc_bprobe_My View")))).toEqual([
      "Database view name 'x_snc_bprobe_My View' must already be normalized to 'x_snc_bprobe_my_view' (lowercase, non-alphanumeric characters replaced with '_') — the platform rewrites the name on save, which would cause the next build to create a duplicate view instead of updating this one.",
    ]);
  });

  it("requires the scope prefix, 'u_' in global and nothing in a ServiceNow scope", () => {
    expect(messages(compile(view("other_v")))).toEqual([
      "Database view name 'other_v' must start with the scope prefix 'x_snc_bprobe_' to match the current application scope.",
    ]);
    expect(messages(compile(view("other_v"), {}, { scope: "global" }))).toEqual([
      "Database view name 'other_v' must start with the custom prefix 'u_' in the global scope.",
    ]);
    expect(messages(compile(view("u_v"), {}, { scope: "global" }))).toEqual([]);
    expect(messages(compile(view("other_v"), {}, { scope: "sn_probe" }))).toEqual([]);
    expect(messages(compile(view("")))).toEqual([]);
  });

  it("reports invalid and duplicate variable prefixes, and hints at duplicate orders", () => {
    const long = "p".repeat(31);
    const result = compile(
      view(
        "x_snc_bprobe_v",
        `[{ $id: 't1', table: 'a', variablePrefix: 'a_b' }, { $id: 't2', table: 'b', variablePrefix: '${long}', order: 200 }, { $id: 't3', table: 'c', variablePrefix: 'a_b', order: 300 }, { $id: 't4', table: 'd', variablePrefix: '', order: 300 }, { $id: 't5', table: 'e', variablePrefix: '', order: 400 }]`,
      ),
    );
    expect(messages(result)).toEqual([
      "Variable prefix 'a_b' cannot contain an underscore.",
      `Variable prefix '${long}' must be 30 characters or fewer.`,
      "Variable prefix 'a_b' cannot contain an underscore.",
      "Variable prefix 'a_b' is used by more than one table in this view. Each joined table must use a unique prefix.",
    ]);
    expect(messages(result, "hint")).toEqual(['View "x_snc_bprobe_v" has more than one table with order 300.']);
  });

  it.each([
    ["DatabaseView({ tables: [] })\n", "DatabaseView(): 'name' is required."],
    [view("x_snc_bprobe_v", "[{ $id: 't1' }]"), "DatabaseView(): 'tables[0].table' is required."],
    [view("x_snc_bprobe_v", "[{ $id: 't1', table: 'a', fields: [{ $id: 'f1' }] }]"), "DatabaseView(): 'tables[0].fields[0].field' is required."],
    [view("x_snc_bprobe_v", "[{ $id: 't1', table: 'a', join: true }]"), "DatabaseView() has no property 'tables[0].join'."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
