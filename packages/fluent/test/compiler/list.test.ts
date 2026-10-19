// SPDX-License-Identifier: GPL-3.0-or-later

import type { CompileFluentResult } from "../../src/compiler/compile";
import { compile, messages, only } from "./helpers";

const list = (props: string) => `List({ table: 'x_snc_bprobe_t', ${props} })\n`;

function files(result: CompileFluentResult): Record<string, string> {
  return Object.fromEntries(result.files.map((f) => [f.path, f.content]));
}

function file(result: CompileFluentResult): string {
  expect(result.files).toHaveLength(1);
  return result.files[0]!.content;
}

describe("List()", () => {
  it("writes the list and its columns as one file, not as record updates", () => {
    const result = compile(list("view: default_view, columns: ['a', { element: 'b', sum: true }]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ui_list")).toEqual([]);
    expect(only(result, "sys_ui_list_element")).toEqual([]);
    expect(Object.keys(files(result))).toEqual(["update/sys_ui_list_x_snc_bprobe_t_null.xml"]);
    const content = file(result);
    expect(content).toContain('<sys_ui_list table="x_snc_bprobe_t" parent="" relationship="" sys_domain="global" view="">');
    expect(content).toContain('<view name="NULL">Default view</view>');
    expect(content).toContain("<element>b</element>\n      <position>1</position>\n      <sum>true</sum>");
  });

  it("names the file after the parent, relationship, view and domain", () => {
    const names = (props: string) => Object.keys(files(compile(list(`columns: [], ${props}`))));
    expect(names("view: 'v1', parent: 'p'")).toEqual(["update/sys_ui_list_x_snc_bprobe_t_p_v1.xml"]);
    expect(names("view: 'v1', relationship: 'R'")).toEqual(["update/sys_ui_list_null_r_v1.xml"]);
    expect(names("view: 'v1', parent: 'p', relationship: 'r', domain: 'd'")).toEqual(["update/sys_ui_list_p_r_v1_d.xml"]);
    expect(names("view: 'v1', relationship: '', domain: ''")).toEqual(["update/sys_ui_list_x_snc_bprobe_t_v1.xml"]);
  });

  it("writes a list without columns", () => {
    const content = file(compile(list("view: 'v1'")));
    expect(content).not.toContain("sys_ui_list_element");
  });

  it("writes an empty sys_domain as an empty element", () => {
    expect(file(compile(list("view: 'v1', columns: [], domain: ''")))).toContain("<sys_domain/>");
  });

  it("takes the view from Now.ref(), by keys or by sys_id alone", () => {
    const byKeys = file(compile(list("view: Now.ref('sys_ui_view', { name: 'v2' }), columns: []")));
    expect(byKeys).toContain('view="v2"');
    const bySysId = compile(list("view: Now.ref('sys_ui_view', '0123456789abcdef0123456789abcdef'), columns: []"));
    expect(Object.keys(files(bySysId))).toEqual(["update/sys_ui_list_x_snc_bprobe_t_null.xml"]);
    expect(file(bySysId)).toContain('view="0123456789abcdef0123456789abcdef">');
    expect(file(bySysId)).toContain("<view>0123456789abcdef0123456789abcdef</view>");
  });

  it("names the default view NULL however it is given", () => {
    const result = compile(list("view: Now.ref('sys_ui_view', { name: 'Default view' }), columns: []"));
    expect(Object.keys(files(result))).toEqual(["update/sys_ui_list_x_snc_bprobe_t_null.xml"]);
    expect(file(result)).toContain('view="">');
  });

  it("writes a Record() relationship with its keys", () => {
    const result = compile(
      "const rel = Record({ $id: Now.ID['rel'], table: 'sys_relationship', data: { name: 'R' } })\n" +
        list("view: 'v1', parent: 'p', relationship: rel, columns: []"),
    );
    expect(messages(result)).toEqual([]);
    expect(file(result)).toMatch(/<relationship>[0-9a-f]+<\/relationship>/);
  });

  it("reports invalid options", () => {
    expect(messages(compile(list("columns: []")))).toEqual(["List(): 'view' is required."]);
    expect(messages(compile(list("view: 1, columns: []")))).toEqual([
      "List(): 'view' must be default_view, a sys_ui_view record or a view name.",
    ]);
    expect(messages(compile(list("view: Now.ref('sys_ui_view', { name: Now.ref('x', 'y') }), columns: []")))).toEqual([
      "List(): Now.ref() keys of 'view' must be strings.",
    ]);
    expect(messages(compile(list("view: 'v1', relationship: 1, columns: []")))).toEqual([
      "List(): 'relationship' must be a sys_relationship record or a sys_id.",
    ]);
    expect(messages(compile(list("view: 'v1', columns: [1]")))).toEqual(["List(): 'columns[0]' must be a string or an object."]);
  });

  it("hints at the deprecated aggregate aliases", () => {
    const result = compile(list("view: 'v1', columns: [{ element: 'a', min_value: true, average_value: false }]"));
    expect(messages(result, "hint")).toEqual([
      "The property 'min_value' is deprecated, use 'minValue' instead.",
      "The property 'average_value' is deprecated, use 'averageValue' instead.",
    ]);
    expect(file(result)).toContain("<min_value>true</min_value>\n      <average_value>false</average_value>");
  });
});

describe("Record() on sys_ui_view", () => {
  const view = (data: string) => compile(`Record({ $id: 'v', table: 'sys_ui_view', data: ${data} })\n`);

  it("refuses a view name with other than alphanumeric characters", () => {
    expect(messages(view("{ name: 'my view' }"))).toEqual(["View name can only contain alphanumeric characters"]);
    expect(messages(view("{ name: 'a_b,c1' }"))).toEqual([]);
    expect(messages(view("{}"))).toEqual(["View name can only contain alphanumeric characters"]);
  });

  it("accepts any name on the default view", () => {
    expect(messages(view("{ name: 'my view', title: 'Default view' }"))).toEqual([]);
  });
});
