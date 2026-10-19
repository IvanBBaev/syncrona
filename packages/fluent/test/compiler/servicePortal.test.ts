// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const css = "const c = CssInclude({ $id: Now.ID['c'], name: 'C', url: 'u' })\n";
const js = "const j = JsInclude({ $id: Now.ID['j'], name: 'J', url: 'u' })\n";

describe("SPAngularProvider()", () => {
  it("writes one m2m row per required provider", () => {
    const result = compile(
      "const a = SPAngularProvider({ $id: Now.ID['a'], name: 'a' })\n" +
        "SPAngularProvider({ $id: Now.ID['b'], name: 'b', requires: [a, 'abc'] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [a, b] = only(result, "sp_angular_provider");
    expect([a.type, a.script]).toEqual(["directive", ""]);
    expect(only(result, "m2m_sp_ng_pro_sp_ng_pro").map((row) => [row.required_by, row.requires])).toEqual([
      [b.sys_id, a.sys_id],
      [b.sys_id, "abc"],
    ]);
  });

  it.each([
    ["requires: ['self']", "recursive dependency detected"],
    ["requires: [1]", "SPAngularProvider(): 'requires' must be an SPAngularProvider() record or a sys_id."],
    [
      "requires: [Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })]",
      "SPAngularProvider(): 'requires' must be an SPAngularProvider() record or a sys_id.",
    ],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`SPAngularProvider({ $id: 'self', name: 'p', ${options} })\n`))).toEqual([message]);
  });
});

describe("CssInclude() and JsInclude()", () => {
  it.each([
    ["CssInclude({ $id: Now.ID['c'], name: 'C' })", "CssInclude must define either a url or spCss property, but not both"],
    ["CssInclude({ $id: Now.ID['c'], name: 'C', url: 'u', spCss: 'x' })", "CssInclude must define either a url or spCss property, but not both"],
    ["JsInclude({ $id: Now.ID['j'], name: 'J', url: 'u', sysUiScript: 'x' })", "JsInclude must define either a url or sysUiScript property, but not both"],
    ["CssInclude({ $id: Now.ID['c'], name: 'C', spCss: true })", "CssInclude(): 'spCss' must be a style sheet record or a sys_id."],
  ])("rejects %s", (source, message) => {
    expect(messages(compile(`${source}\n`))).toEqual([message]);
  });
});

describe("SPWidgetDependency() and SPTheme()", () => {
  it("defaults an include order of 0 or none to 100", () => {
    const result = compile(
      css + js + "SPWidgetDependency({ $id: Now.ID['d'], name: 'D', cssIncludes: [{ include: c, order: 0 }], jsIncludes: [{ include: j, order: 5 }] })\n",
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "m2m_sp_dependency_css_include")[0].order).toBe("100");
    expect(only(result, "m2m_sp_dependency_js_include")[0].order).toBe("5");
  });

  it("joins portal records and sys_ids", () => {
    const result = compile(
      "const p = Record({ $id: Now.ID['p'], table: 'sp_portal', data: { title: 'P' } })\n" +
        "SPWidgetDependency({ $id: Now.ID['d'], name: 'D', portalsForPageLoad: [p, 'abc'] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [portal] = only(result, "sp_portal");
    expect(only(result, "sp_dependency")[0].sp_portals).toBe(`${portal.sys_id},abc`);
  });

  it.each([
    ["cssIncludes: [{ order: 1 }]", "include must contain a valid CssInclude, Record<'sp_css_include'> or sys_id'"],
    ["jsIncludes: [{ include: c }]", "include must contain a valid JsInclude, Record<'sp_js_include'> or sys_id'"],
    ["header: c", "SPTheme(): 'header' must be a header record or a sys_id."],
    ["footer: 1", "SPTheme(): 'footer' must be a footer record or a sys_id."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`${css}SPTheme({ $id: Now.ID['t'], name: 'T', ${options} })\n`))).toEqual([message]);
  });
});

describe("SPPageRouteMap()", () => {
  it("keeps unique, non-blank role names and defaults the pages to empty", () => {
    const result = compile(
      "const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })\n" +
        "SPPageRouteMap({ $id: Now.ID['m'], roles: ['itil', r, ' ', 'itil'], portals: ['a', '', 'a', 'b'] })\n",
    );
    expect(messages(result)).toEqual([]);
    const [map] = only(result, "sp_page_route_map");
    expect([map.route_from_page, map.route_to_page, map.roles, map.portals, map.active, map.order]).toEqual([
      "",
      "",
      "itil,x_snc_bprobe.r",
      "a,b",
      "true",
      "10",
    ]);
  });

  it.each([
    ["routeFromPage: 'p', routeToPage: 'p'", 'Invalid SPPageRouteMap: "routeToPage" must be different from "routeFromPage".'],
    ["roles: [1]", "roles must be strings or role records"],
    ["routeToPage: 1", "SPPageRouteMap(): 'routeToPage' must be a page record or a sys_id."],
    ["portals: [1]", "Must be a sys_id or Record<'sp_portal'>"],
    ["portals: [Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })]", "Must be a sys_id or Record<'sp_portal'>"],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`SPPageRouteMap({ $id: Now.ID['m'], ${options} })\n`))).toEqual([message]);
  });
});
