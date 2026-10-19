// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const policy = (options: string) => `DataPolicy({ $id: Now.ID['dp'], table: 'x_snc_bprobe_t', ${options} })\n`;

describe("DataPolicy()", () => {
  it("writes the SDK's defaults without a table or rules", () => {
    const result = compile("DataPolicy({ $id: Now.ID['dp'] })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_data_policy2")).toEqual([
      expect.objectContaining({ model_table: "", short_description: "", active: "true", enforce_ui: "true", inherit: "false" }),
    ]);
    expect(only(result, "sys_data_policy_rule")).toEqual([]);
  });

  it("writes a rule per field, on the policy table unless it names one", () => {
    const result = compile(
      policy("rules: { a: { $id: 'r1', mandatory: true, table: 'x_snc_bprobe_t' }, b: { $id: 'r2', readOnly: false, table: 'x_snc_bprobe_u' }, c: { $id: 'r3', mandatory: 'ignore' } }"),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_data_policy_rule").map(({ table, field, mandatory, disabled }) => ({ table, field, mandatory, disabled }))).toEqual([
      { table: "x_snc_bprobe_t", field: "a", mandatory: "true", disabled: "ignore" },
      { table: "x_snc_bprobe_u", field: "b", mandatory: "ignore", disabled: "false" },
      { table: "x_snc_bprobe_t", field: "c", mandatory: "ignore", disabled: "ignore" },
    ]);
  });

  it("writes rules of a policy without a table", () => {
    const result = compile("DataPolicy({ $id: Now.ID['dp'], rules: { a: { $id: 'r1', mandatory: true, table: 'x_snc_bprobe_t' }, b: { $id: 'r2' } } })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_data_policy_rule").map((r) => r.table)).toEqual(["x_snc_bprobe_t", ""]);
  });

  it("skips a rule that is not an object, as the SDK does", () => {
    const result = compile(policy("rules: { a: true, b: { $id: 'r2' } }"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_data_policy_rule").map((r) => r.field)).toEqual(["b"]);
  });

  it("reports the SDK's rule errors and skips those rules", () => {
    const result = compile(
      policy("rules: { a: { $id: 'r1', mandatory: true, readOnly: true }, b: { $id: 'r2', mandatory: true, table: 'task' }, c: { $id: 'r3', readOnly: true, table: 'task' } }"),
    );
    expect(messages(result)).toEqual([
      "Rule for field 'a': mandatory and readOnly cannot both be true - these are mutually exclusive",
      "Rule for field 'b': cannot set mandatory=true for table 'task' which is outside the current scope 'x_snc_bprobe'. For tables in a different scope than the data policy record, you cannot make a field mandatory.",
    ]);
    expect(only(result, "sys_data_policy_rule").map((r) => r.field)).toEqual(["c"]);
  });

  it("refuses a table outside a scoped app, but not in a global one", () => {
    const source = "DataPolicy({ $id: Now.ID['dp'], table: 'incident', rules: { a: { $id: 'r1', mandatory: true, table: 'task' } } })\n";
    expect(messages(compile(source))).toEqual([
      "'table' property should start with scope prefix 'x_snc_bprobe_'. Data Policies in scoped apps can only be created for tables within the same scope.",
      "Rule for field 'a': cannot set mandatory=true for table 'task' which is outside the current scope 'x_snc_bprobe'. For tables in a different scope than the data policy record, you cannot make a field mandatory.",
    ]);
    const global = compile(source, {}, { scope: "global" });
    expect(messages(global)).toEqual([]);
    expect(only(global, "sys_data_policy_rule")).toHaveLength(1);
  });

  it.each([
    [policy("rules: []"), "DataPolicy(): 'rules' must be an object."],
    [policy("rules: { a: { $id: 'r1', mandatory: 'yes' } }"), "DataPolicy(): 'rules.a.mandatory' must be a boolean or 'ignore'."],
    [policy("rules: { a: { $id: 'r1', readOnly: 1 } }"), "DataPolicy(): 'rules.a.readOnly' must be a boolean or 'ignore'."],
    [policy("rules: { a: { $id: 'r1', visible: true } }"), "DataPolicy() has no property 'rules.a.visible'."],
    [policy("active: 'yes'"), "DataPolicy(): 'active' must be a boolean."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
