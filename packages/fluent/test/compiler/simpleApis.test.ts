// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const csp = (options: string) =>
  `CrossScopePrivilege({ $id: Now.ID['c'], status: 'allowed', targetName: 'T', targetScope: 'global', ${options} })\n`;
const policy = (options = "") => `UiPolicy({ $id: Now.ID['p'], shortDescription: 'P', ${options} })\n`;
// Any record stands in for the view: the UI policy only references it.
const VIEW = "const view = Record({ $id: Now.ID['v'], table: 'sys_app_category', data: { name: 'ess' } })\n";
const REL = "const rel = Record({ $id: Now.ID['r'], table: 'sys_relationship', data: { name: 'R' } })\n";

describe("CrossScopePrivilege()", () => {
  it("writes the privilege with the source and target scopes", () => {
    const result = compile(csp("operation: 'execute', targetType: 'scriptable'"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_scope_privilege")).toEqual([
      expect.objectContaining({
        operation: "execute",
        status: "allowed",
        target_name: "T",
        target_scope: "global",
        target_type: "scriptable",
        source_scope: "db22ea00d7ff49d9b5d64061202ea510",
      }),
    ]);
  });

  it("accepts the deprecated snake_case names with a hint", () => {
    const result = compile(
      "CrossScopePrivilege({ $id: Now.ID['c'], operation: 'read', status: 'denied', target_name: 'T', target_scope: 'global', target_type: 'sys_db_object' })\n",
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([
      "The property 'target_name' is deprecated, use 'targetName' instead.",
      "The property 'target_scope' is deprecated, use 'targetScope' instead.",
      "The property 'target_type' is deprecated, use 'targetType' instead.",
    ]);
    expect(only(result, "sys_scope_privilege")[0]).toMatchObject({ target_name: "T", target_type: "sys_db_object" });
  });

  it.each([
    ["operation: 'toString', targetType: 'sys_db_object'", "CrossScopePrivilege(): 'operation' must be one of execute, create, read, write, delete."],
    ["operation: 'read', targetType: 'sys_db_object', status: 'maybe'", "CrossScopePrivilege(): 'status' must be one of requested, allowed, denied."],
    ["operation: 'read', targetType: 'scriptable'", "CrossScopePrivilege(): 'targetType' must be sys_db_object when 'operation' is 'read'."],
    ["operation: 'execute', targetType: 'sys_db_object'", "CrossScopePrivilege(): 'targetType' must be sys_script_include or scriptable when 'operation' is 'execute'."],
  ])("rejects %s", (options, message) => {
    const source = options.includes("status:")
      ? `CrossScopePrivilege({ $id: Now.ID['c'], targetName: 'T', targetScope: 'global', ${options} })\n`
      : csp(options);
    expect(messages(compile(source))).toEqual([message]);
  });
});

describe("UserPreference()", () => {
  it("writes only the options given", () => {
    const result = compile(
      "UserPreference({ $id: Now.ID['a'], name: 'a', type: 'string', value: 'v' })\n" +
        "UserPreference({ $id: Now.ID['b'], name: 'b', type: 'integer', value: 3, description: 'D', system: false })\n",
    );
    expect(messages(result)).toEqual([]);
    const [a, b] = only(result, "sys_user_preference");
    expect(a).not.toHaveProperty("description");
    expect(a).not.toHaveProperty("system");
    expect(a).toMatchObject({ name: "a", type: "string", value: "v" });
    expect(b).toMatchObject({ name: "b", type: "integer", value: "3", description: "D", system: "false" });
  });

  it("requires a value", () => {
    expect(messages(compile("UserPreference({ $id: Now.ID['a'], name: 'a', type: 'string' })\n"))).toEqual([
      "UserPreference(): 'value' is required.",
    ]);
  });
});

describe("ApplicationMenu()", () => {
  it("joins role names and Role() records, and refers to a category record", () => {
    const result = compile(
      "const r = Role({ name: 'x_snc_bprobe.user' })\n" +
        "const cat = Record({ $id: Now.ID['cat'], table: 'sys_app_category', data: { name: 'C' } })\n" +
        "ApplicationMenu({ $id: Now.ID['m'], title: 'M', roles: [r, 'admin', 'admin'], category: cat })\n",
    );
    expect(messages(result)).toEqual([]);
    const [category] = result.records.filter((r) => r.table === "sys_app_category");
    expect(only(result, "sys_app_application")[0]).toMatchObject({
      title: "M",
      roles: "x_snc_bprobe.user,admin,admin",
      category: category.sysId,
      active: "true",
      order: "100",
      device_type: "browser",
    });
  });

  it("rejects a role that is neither a name nor a Role()", () => {
    expect(messages(compile("ApplicationMenu({ $id: Now.ID['m'], title: 'M', roles: [1] })\n"))).toEqual([
      "ApplicationMenu(): 'roles' must hold role names or Role() records.",
    ]);
  });
});

describe("UiPolicy()", () => {
  it("writes the defaults of a policy without a table", () => {
    const result = compile(policy("actions: [{ field: 'f', visible: false }]"));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([]);
    expect(only(result, "sys_ui_policy")[0]).toMatchObject({
      table: "",
      script_true: "function onCondition() {\n\n}",
      ui_type: "0",
      view: "",
    });
    expect(only(result, "sys_ui_policy_action")[0]).toMatchObject({ table: "", visible: "false", disabled: "ignore" });
  });

  it("refers to a view record, writes the UI type and defaults an action's empty table", () => {
    const result = compile(
      VIEW + policy("table: 'x_snc_bprobe_t', view: view, uiType: 'mobile-or-service-portal', actions: [{ field: 'f', table: '', readOnly: 'ignore' }]"),
    );
    expect(messages(result)).toEqual([]);
    const [view] = result.records.filter((r) => r.table === "sys_app_category");
    expect(only(result, "sys_ui_policy")[0]).toMatchObject({ view: view.sysId, ui_type: "1" });
    expect(only(result, "sys_ui_policy_action")[0]).toMatchObject({ table: "x_snc_bprobe_t", disabled: "ignore" });
  });

  it("lets ServiceNow and global scopes target any table", () => {
    expect(messages(compile(policy("table: 'incident'"), {}, { scope: "sn_foo" }))).toEqual([]);
    expect(messages(compile(policy("table: 'incident'"), {}, { scope: "global" }))).toEqual([]);
  });

  it("reports a table outside the app's scope but still writes the policy", () => {
    const result = compile(policy("table: 'incident'"));
    expect(messages(result)).toEqual([
      "'table' property should start with scope prefix 'x_snc_bprobe_'. UI Policies in scoped apps can only be created for tables within the same scope.",
    ]);
    expect(only(result, "sys_ui_policy")).toHaveLength(1);
  });

  it("reports scripts that import modules and scripts that will not run", () => {
    const result = compile(
      policy("scriptTrue: \"const x = require('x')\", scriptFalse: 'function onCondition() {\\n\\n}'"),
    );
    expect(messages(result)).toEqual(["UI Policy scripts cannot import or require modules. Scripts run client-side in the browser."]);
    expect(messages(result, "hint")).toEqual(["This script will not execute unless runScripts is set to true"]);
    expect(compile(policy("runScripts: true, scriptTrue: 'g()'")).diagnostics).toEqual([]);
  });

  it("hints at actions without effect", () => {
    const result = compile(policy("actions: [{ field: 'a' }, { field: 'b', cleared: false }], relatedListActions: [{}, { visible: true }]"));
    expect(messages(result, "hint")).toEqual([
      "Action at index 0 has no effect — consider specifying at least one of: visible, readOnly, mandatory, or cleared",
      "Related list action at index 0 has no effect — consider specifying at least one of: list or visible",
    ]);
    expect(only(result, "sys_ui_policy_rl_action").map((r) => [r.list, r.visible])).toEqual([
      ["", "ignore"],
      ["", "true"],
    ]);
  });

  it("writes related lists by relationship record, GUID and table.field", () => {
    const result = compile(
      REL + policy("relatedListActions: [{ list: rel }, { list: 'b9b7e1a0c0a8016400b98a06818d57c7' }, { list: 'incident.caller_id' }]"),
    );
    expect(messages(result)).toEqual([]);
    const [rel] = result.records.filter((r) => r.table === "sys_relationship");
    expect(only(result, "sys_ui_policy_rl_action").map((r) => r.list)).toEqual([
      `REL:${rel.sysId}`,
      "REL:b9b7e1a0c0a8016400b98a06818d57c7",
      "incident.caller_id",
    ]);
  });

  it.each([
    ["a.b.c", "Related list action at index 0: 'list' property must be in 'table.field' format (e.g., 'incident.caller_id')"],
    ["a.", "Related list action at index 0: 'list' property must be in 'table.field' format (e.g., 'incident.caller_id')"],
    [
      "incident",
      "Related list action at index 0: 'list' property must be either a Record<'sys_relationship'>, a GUID, or in 'table.field' format (e.g., 'incident.caller_id')",
    ],
  ])("reports and skips the related list %s", (list, message) => {
    const result = compile(policy(`relatedListActions: [{ list: '${list}' }]`));
    expect(messages(result)).toEqual([message]);
    expect(only(result, "sys_ui_policy_rl_action")).toEqual([]);
  });

  it.each([
    ["shortDescription: ' '", "shortDescription cannot be empty or contain only whitespace"],
    ["uiType: 'tv'", "UiPolicy(): 'uiType' must be one of desktop, mobile-or-service-portal, all."],
    [
      "actions: [{ field: 'f', fieldMessageType: 'loud' }]",
      "UiPolicy(): 'actions[0].fieldMessageType' must be one of error, info, warning, none.",
    ],
    ["actions: [{ field: 'f', mandatory: 'yes' }]", "UiPolicy(): 'actions[0].mandatory' must be a boolean or 'ignore'."],
    ["relatedListActions: [{ visible: 1 }]", "UiPolicy(): 'relatedListActions[0].visible' must be a boolean or 'ignore'."],
  ])("rejects %s", (options, message) => {
    const source = options.startsWith("shortDescription")
      ? `UiPolicy({ $id: Now.ID['p'], ${options} })\n`
      : policy(options);
    expect(messages(compile(source))).toEqual([message]);
  });
});
