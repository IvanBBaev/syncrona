// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

describe("SPWidget() and SPHeaderFooter()", () => {
  it("names the controller in the default client script", () => {
    const result = compile("SPWidget({ $id: Now.ID['w'], name: 'W', controllerAs: 'vm' })\n");
    expect(messages(result)).toEqual([]);
    const [widget] = only(result, "sp_widget");
    expect(widget.controller_as).toBe("vm");
    expect(widget.client_script).toContain("var vm = this;");
  });

  it("writes optionSchema keys in snake_case and keeps role repeats", () => {
    const result = compile(
      "const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })\n" +
        "SPWidget({ $id: Now.ID['w'], name: 'W', roles: ['a', r, 'a'], demoData: { n: null, u: undefined }, " +
        "optionSchema: [{ name: 'o', defaultValue: 'x', ed: { refQual: 'y' } }] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [widget] = only(result, "sp_widget");
    expect(widget.roles).toBe("a,x_snc_bprobe.r,a");
    expect(widget.demo_data).toBe('{"n":null}');
    expect(widget.option_schema).toBe('[{"name":"o","default_value":"x","ed":{"refQual":"y"}}]');
  });

  it("maps the category and writes a docs record's sys_id", () => {
    const result = compile(
      "const d = Record({ $id: Now.ID['d'], table: 'sp_documentation', data: { title: 'D' } })\n" +
        "SPHeaderFooter({ $id: Now.ID['h'], name: 'H', category: 'serviceCatalog', docs: d, dependencies: [''] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [header] = only(result, "sp_header_footer");
    expect([header.category, header.static, header.docs]).toEqual(["sc", "false", only(result, "sp_documentation")[0].sys_id]);
    expect(only(result, "m2m_sp_widget_dependency")).toEqual([]);
  });

  it.each([
    ["id: 'a b'", "Invalid value: must contain only alphanumeric, -, or _ characters"],
    ["clientScript: 'var x = 1;'", "Client controller must contain a JavaScript function. Example: api.controller = function($scope) { ... }"],
    ["htmlTemplate: '<a href=\"#\">x</a>'", 'Do not use href="#" in the Service Portal, use href="javascript:void(0)" instead'],
    ["roles: ['0123456789abcdef0123456789abcdef']", "expecting role names or role records created by the Role or Record plugins, not sys_ids"],
    ["roles: [1]", "SPWidget(): 'roles' must hold role names or role records."],
    ["demoData: { f: Now.ID['x'] }", "SPWidget(): 'demoData' must be JSON data."],
    ["optionSchema: ['x']", "SPWidget(): 'optionSchema' must hold option objects."],
    ["dependencies: [1]", "SPWidget(): 'dependencies' must hold sys_ids or records."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`SPWidget({ $id: Now.ID['w'], name: 'W', ${options} })\n`))).toEqual([message]);
  });
});
