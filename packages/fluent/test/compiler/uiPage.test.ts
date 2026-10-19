// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const page = (options: string) => `UiPage({ $id: Now.ID['p'], endpoint: 'x_snc_bprobe_home.do'${options} })\n`;

describe("UiPage()", () => {
  it("strips the scope prefix and .do from the endpoint for the page name", () => {
    const result = compile(page(""));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ui_page")[0]).toMatchObject({
      name: "home",
      sys_name: "home",
      endpoint: "x_snc_bprobe_home.do",
      direct: "false",
      html: "",
    });
  });

  it("normalises the html the way the SDK prints it", () => {
    const result = compile(page(", html: '<div><b>a &amp; b</b></div>', direct: true"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ui_page")[0]).toMatchObject({ html: "\n<div>\n  <b>a &amp; b</b>\n</div>", direct: "true" });
  });

  it("names a global page after its whole endpoint and leaves the endpoint empty", () => {
    const result = compile("UiPage({ $id: Now.ID['p'], endpoint: 'my_page.do' })\n", {}, { scope: "global" });
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ui_page")[0]).toMatchObject({ name: "my_page", endpoint: "" });
  });

  it("accepts any endpoint in an sn_ scope", () => {
    const result = compile("UiPage({ $id: Now.ID['p'], endpoint: 'other.do' })\n", {}, { scope: "sn_probe" });
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ui_page")[0]).toMatchObject({ name: "other", endpoint: "other.do" });
  });

  it.each([
    ["UiPage({ $id: Now.ID['p'], endpoint: 'home.do' })", "endpoint must begin with 'x_snc_bprobe_'"],
    ["UiPage({ $id: Now.ID['p'], endpoint: 'x_snc_bprobe_.do' })", "endpoint must include a page name before .do"],
    ["UiPage({ $id: Now.ID['p'] })", "UiPage(): 'endpoint' is required."],
    [page(", html: 1"), "UiPage(): 'html' must be a string."],
    [page(", html: '<!-- @fluent-import-html x -->\\n<div/>'"), "UiPage(): an imported .html 'html' is not supported by the native compiler yet."],
    [page(", html: '<textarea>&amp;</textarea>'"), "UiPage(): 'html' with a character reference in textarea content is not supported by the native compiler yet."],
    [page(", html: '<!-- x'"), "Comment is not closed."],
  ])("rejects %s", (source, message) => {
    expect(messages(compile(source))).toEqual([message]);
  });

  it("rejects an included html file", () => {
    const result = compile(page(", html: Now.include('./page.html')"), { "src/fluent/page.html": "<div/>" });
    expect(messages(result)).toEqual(["UiPage(): a Now.include() 'html' is not supported by the native compiler yet."]);
  });
});
