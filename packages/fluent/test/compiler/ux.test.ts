// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

/** A menu with one list whose applicabilities are `applicabilities`. */
const menu = (applicabilities: string, before = "") =>
  `${before}UxListMenuConfig({ $id: Now.ID['m'], name: 'M', categories: [{ $id: Now.ID['c'], title: 'C', lists: [{ $id: Now.ID['l'], table: 'incident', title: 'L', applicabilities: [${applicabilities}] }] }] })\n`;

describe("Applicability()", () => {
  it("joins Role() sys_ids and sys_id strings, once each", () => {
    const result = compile(
      "const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })\n" +
        "Applicability({ $id: Now.ID['a'], name: 'A', roles: [r, 'abc', r, 'abc'] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [roleRow] = only(result, "sys_user_role");
    expect(only(result, "sys_ux_applicability")[0].roles).toBe(`${roleRow.sys_id},abc`);
  });

  it.each([
    ["roles: [1]", "Applicability(): 'roles' must hold role sys_ids or Role() records."],
    ["roles: [Applicability({ $id: Now.ID['b'], name: 'B' })]", "Applicability(): 'roles' must hold roles."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`Applicability({ $id: Now.ID['a'], name: 'A', ${options} })\n`))).toEqual([message]);
  });
});

describe("UxListMenuConfig()", () => {
  it("writes a menu without categories as a single record", () => {
    const result = compile("UxListMenuConfig({ $id: Now.ID['m'], name: 'M' })\n");
    expect(messages(result)).toEqual([]);
    expect(result.records.map((r) => r.table)).toEqual(["sys_ux_list_menu_config"]);
  });

  it("writes a category without lists", () => {
    const result = compile("UxListMenuConfig({ $id: Now.ID['m'], name: 'M', categories: [{ $id: Now.ID['c'], title: 'C' }] })\n");
    expect(messages(result)).toEqual([]);
    expect(result.records.map((r) => r.table).sort()).toEqual(["sys_ux_list_category", "sys_ux_list_menu_config"]);
  });

  it.each([
    ["{ $id: Now.ID['x'] }", "UxListMenuConfig(): 'categories[].lists[].applicabilities[].applicability' must be an Applicability() record or a sys_id."],
    ["{ $id: Now.ID['x'], applicability: 1 }", "UxListMenuConfig(): 'categories[].lists[].applicabilities[].applicability' must be an Applicability() record or a sys_id."],
    ["{ $id: Now.ID['x'], applicability: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' }) }", "UxListMenuConfig(): 'categories[].lists[].applicabilities[].applicability' must be an Applicability() record or a sys_id."],
    ["{ $id: Now.ID['x'], applicability: 'abc', bogus: 1 }", "UxListMenuConfig() has no property 'categories[].lists[].applicabilities[].bogus'."],
  ])("rejects the applicability %s", (applicability, message) => {
    expect(messages(compile(menu(applicability)))).toEqual([message]);
  });

  it("requires a list's table and title", () => {
    const source = "UxListMenuConfig({ $id: Now.ID['m'], name: 'M', categories: [{ $id: Now.ID['c'], title: 'C', lists: [{ $id: Now.ID['l'], title: 'L' }] }] })\n";
    expect(messages(compile(source))).toEqual(["UxListMenuConfig(): 'categories[].lists[].table' is required."]);
  });
});

describe("Workspace()", () => {
  const workspace = (options: string, before = "") =>
    `${before}Workspace({ $id: Now.ID['w'], title: 'W', path: 'w', tables: ['incident'], ${options} })\n`;

  it("derives the SDK's records with its defaults", () => {
    const result = compile(workspace(""));
    expect(messages(result)).toEqual([]);
    const [registry] = only(result, "sys_ux_page_registry");
    expect(registry.active).toBe("true");
    expect(only(result, "sys_ux_registry_m2m_category")[0].order).toBe("1000");
    expect(only(result, "sys_ux_app_config")[0].landing_path).toBe("home");
    const listConfig = only(result, "sys_ux_page_property").find((p) => p.name === "listConfigId");
    expect(listConfig?.value).toBe("d305c0a873601010a0a79329faf6a7cb");
    expect(only(result, "sys_ux_screen")).toHaveLength(4);
    expect(only(result, "sys_ux_macroponent")).toHaveLength(1);
  });

  it.each([
    ["listConfig: 1", "Workspace(): 'listConfig' must be a UxListMenuConfig() record or a sys_id."],
    ["listConfig: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })", "Workspace(): 'listConfig' must be a UxListMenuConfig() record or a sys_id."],
    ["defaultRecordOverrides: {}", "Workspace(): 'defaultRecordOverrides' is not supported by the native compiler yet."],
    ["tables: [1]", "Workspace(): 'tables' must be an array of strings."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(workspace(options)))).toEqual([message]);
  });

  it("requires tables and $id", () => {
    expect(messages(compile("Workspace({ $id: Now.ID['w'], title: 'W', path: 'w' })\n"))).toEqual(["Workspace(): 'tables' is required."]);
    expect(messages(compile("Workspace({ title: 'W', path: 'w', tables: [] })\n"))).toEqual(["Workspace(): '$id' is required."]);
  });
});

describe("Dashboard()", () => {
  const dashboard = (options: string, before = "") => `${before}Dashboard({ $id: Now.ID['d'], name: 'D', ${options} })\n`;
  const widget = (fields: string) =>
    `{ $id: Now.ID['w'], component: 'x', height: 1, width: 2, position: { x: 3, y: 4 }, ${fields} }`;
  const tab = (widgets: string) => `tabs: [{ $id: Now.ID['t'], name: 'T', widgets: [${widgets}] }]`;

  it("writes a tab with its canvas and widgets and the default visibility", () => {
    const result = compile(dashboard(tab(widget("componentProps: { a: true, b: null, c: [1, 'two'], d: { e: 'f' } }"))));
    expect(messages(result)).toEqual([]);
    const [tabRow] = only(result, "par_dashboard_tab");
    expect(tabRow.active).toBe("true");
    const [canvas] = only(result, "par_dashboard_canvas");
    expect(canvas.dashboard_tab).toBe(tabRow.sys_id);
    const [w] = only(result, "par_dashboard_widget");
    expect(w.component).toBe("x");
    expect([w.h, w.w, w.x, w.y]).toEqual(["1", "2", "3", "4"]);
    expect(JSON.parse(w.component_props!)).toMatchObject({ a: true, b: null, c: [1, "two"], d: { e: "f" }, chartVariation: "stacked" });
    expect(only(result, "par_dashboard_visibility")[0].experience).toBe("08c73d60537101100834ddeeff7b1287");
    expect(only(result, "par_dashboard_permission")).toEqual([]);
  });

  it("writes a widget without componentProps with the defaults only, and layouts without widgets", () => {
    const result = compile(dashboard(`topLayout: {}, ${tab(widget(""))}`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "par_dashboard_canvas")).toHaveLength(2);
    expect(JSON.parse(only(result, "par_dashboard_widget")[0].component_props!).chartVariation).toBe("stacked");
    expect(messages(compile(dashboard("tabs: [{ $id: Now.ID['t'], name: 'T' }]")))).toEqual([]);
  });

  it("writes a permission's subjects only when given", () => {
    const result = compile(dashboard("permissions: [{ $id: Now.ID['p'] }]"));
    expect(messages(result)).toEqual([]);
    const [permission] = only(result, "par_dashboard_permission");
    expect(permission).not.toHaveProperty("user");
    expect([permission.can_read, permission.can_write, permission.can_share, permission.owner]).toEqual(["true", "false", "false", "false"]);
  });

  it.each([
    ["componentProps: { a: Now.ID['x'] }", "Dashboard(): 'tabs[].widgets[].componentProps.a' must be a JSON value."],
    ["componentProps: { a: [Now.ID['x']] }", "Dashboard(): 'tabs[].widgets[].componentProps.a[0]' must be a JSON value."],
  ])("rejects a widget with %s", (fields, message) => {
    expect(messages(compile(dashboard(tab(widget(fields)))))).toEqual([message]);
  });

  it.each([
    ["{ $id: Now.ID['w'], component: 'x', height: 1, width: 2 }", "Dashboard(): 'tabs[].widgets[].position' is required."],
    ["{ $id: Now.ID['w'], component: 'x', width: 2, position: { x: 3, y: 4 } }", "Dashboard(): 'tabs[].widgets[].height' is required."],
  ])("rejects the widget %s", (w, message) => {
    expect(messages(compile(dashboard(tab(w))))).toEqual([message]);
  });

  it.each([
    ["visibilities: [{ $id: Now.ID['v'], experience: 1 }]", "Dashboard(): 'visibilities[].experience' must be a Workspace() record or a sys_id."],
    ["visibilities: [{ $id: Now.ID['v'] }]", "Dashboard(): 'visibilities[].experience' must be a Workspace() record or a sys_id."],
    [
      "visibilities: [{ $id: Now.ID['v'], experience: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' }) }]",
      "Dashboard(): 'visibilities[].experience' must be a Workspace() record or a sys_id.",
    ],
    ["permissions: [{ $id: Now.ID['p'], role: 1 }]", "Dashboard(): 'permissions[].role' must be a string."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(dashboard(options)))).toEqual([message]);
  });
});
