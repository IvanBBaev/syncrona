// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const WRAPPED = '{"k":{"value":"v","displayValue":"v"}}';

describe("SPPage() and SPMenu()", () => {
  it("keys the page by its id and falls back to it for the title", () => {
    const result = compile(
      "const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })\n" +
        "const j = JsInclude({ $id: Now.ID['j'], name: 'J', url: 'u' })\n" +
        "SPPage({ pageId: 'p', title: '', roles: ['a', r, '', 'a', j, 1], humanReadableUrlStructure: 'a-%id/b%x', " +
        "containers: [{ $id: Now.ID['c'], order: 0 }, { $id: Now.ID['c2'], name: 'N' }] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [page] = only(result, "sp_page");
    expect([page.id, page.title, page.roles]).toEqual(["p", "p", "a,x_snc_bprobe.r"]);
    expect(only(result, "sp_container").map((c) => [c.name, c.order, c.sp_page])).toEqual([
      ["p - Container 1", "0", page.sys_id],
      ["N", "2", page.sys_id],
    ]);
  });

  it("writes a script include call as the SEO script", () => {
    const result = compile(
      "const s = Record({ $id: Now.ID['s'], table: 'sys_script_include', data: { name: 'S' } })\n" +
        "SPPage({ pageId: 'p', useSeoScript: true, seoScript: s })\n",
    );
    expect(messages(result)).toEqual([]);
    const [page] = only(result, "sp_page");
    expect([page.use_seo_script, page.seo_script]).toEqual(["true", only(result, "sys_script_include")[0].sys_id]);
  });

  it.each([
    [{ a: 1, n: null }, '{"a":{"value":"1","displayValue":"1"},"n":{"value":"","displayValue":""}}'],
    [{ k: { value: "v", displayValue: "v" } }, WRAPPED],
    [{ k: 1, w: { value: "v", displayValue: "v" } }, '{"k":{"value":"1","displayValue":"1"},"w":{"value":"[object Object]","displayValue":"[object Object]"}}'],
    ["'not json'", "not json"],
    ["'[1]'", "[1]"],
    ["'null'", "null"],
    [`'${WRAPPED}'`, WRAPPED],
    [`'{"k":"v"}'`, WRAPPED],
  ])("writes instance widget parameters %j", (parameters, expected) => {
    const literal = typeof parameters === "string" ? parameters : JSON.stringify(parameters);
    const result = compile(
      `SPPage({ pageId: 'p', containers: [{ $id: Now.ID['c'], rows: [{ $id: Now.ID['r'], columns: [{ $id: Now.ID['col'], ` +
        `instances: [{ $id: Now.ID['i'], widget: '0123456789abcdef0123456789abcdef', widgetParameters: ${literal}, ` +
        `placeholderDimensions: { a: 1 } }] }] }] }] })\n`,
    );
    expect(messages(result)).toEqual([]);
    const [instance] = only(result, "sp_instance");
    expect([instance.widget_parameters, instance.placeholder_dimensions, instance.sp_widget]).toEqual([
      expected,
      '{"a":1}',
      "0123456789abcdef0123456789abcdef",
    ]);
  });

  it("writes menu widget parameters with native values and child items", () => {
    const result = compile(
      "SPMenu({ $id: Now.ID['m'], widgetParameters: { a: 1, n: null }, placeholderDimensions: 'd', " +
        "items: [{ $id: Now.ID['i'], type: 'page', childItems: [{ $id: Now.ID['ic'], type: 'url', childItems: [{ $id: Now.ID['icc'], type: 'url' }] }] }] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [menu] = only(result, "sp_instance_menu");
    expect([menu.widget_parameters, menu.placeholder_dimensions, menu.title]).toEqual([
      '{"a":{"value":1,"displayValue":"1"},"n":{"value":null,"displayValue":""}}',
      "d",
      undefined,
    ]);
    const items = only(result, "sp_rectangle_menu_item");
    expect(items.map((i) => [i.sp_rectangle_menu, i.sp_rectangle_menu_item])).toEqual([
      [menu.sys_id, ""],
      ["", items[0].sys_id],
      ["", items[1].sys_id],
    ]);
  });

  it.each([
    ["pageId: ''", 'Invalid SPPage configuration: "pageId" must be a non-empty string.'],
    ["pageId: 'p', useSeoScript: true", 'Invalid SPPage configuration: when "useSeoScript" is true, "seoScript" must be added.'],
    ["pageId: 'p', useSeoScript: true, seoScript: ' '", 'Invalid SPPage configuration: when "useSeoScript" is true, "seoScript" must be added.'],
    ["pageId: 'p', seoScript: 1", "SPPage(): 'seoScript' must be a script include record or a sys_id."],
    ["pageId: 'p', humanReadableUrlStructure: 'a_b'", "Only alphanumeric characters, - and / are allowed in humanReadableUrlStructure."],
    ["pageId: 'p', humanReadableUrlStructure: 'a/b/c'", 'No more than one "/" character is allowed in humanReadableUrlStructure.'],
    [
      "pageId: 'p', containers: [{ $id: Now.ID['c'], rows: [{ $id: Now.ID['r'], columns: [{ $id: Now.ID['col'], instances: [{ $id: Now.ID['i'], widgetParameters: 1 }] }] }] }]",
      "SPPage(): 'containers[].rows[].columns[].instances[].widgetParameters' must be an object or a JSON string.",
    ],
  ])("rejects SPPage %s", (options, message) => {
    expect(messages(compile(`SPPage({ ${options} })\n`))).toEqual([message]);
  });

  it.each([
    ["roles: [1]", "roles must be strings or role records"],
    ["roles: [JsInclude({ $id: Now.ID['j'], name: 'J', url: 'u' })]", "roles must be strings or role records"],
    ["column: 1", "SPMenu(): 'column' must be a column record or a sys_id."],
    ["items: [{ $id: Now.ID['i'], type: 'page', roles: [1] }]", "roles must be strings or role records"],
    ["items: [{ $id: Now.ID['i'], type: 'page', page: 1 }]", "SPMenu(): 'items[].page' must be a page record or a sys_id."],
  ])("rejects SPMenu %s", (options, message) => {
    expect(messages(compile(`SPMenu({ $id: Now.ID['m'], ${options} })\n`))).toEqual([message]);
  });
});
