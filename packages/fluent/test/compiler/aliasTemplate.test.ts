// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const template = (options: string) => `AliasTemplate({ $id: Now.ID['t'], name: 'T', ${options} })\n`;

describe("AliasTemplate()", () => {
  it("leaves a null schema and template empty", () => {
    const result = compile(template("dynamicDataSchema: null, defaultDataTemplate: null"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_alias_templates")[0]).toMatchObject({ dynamic_data_schema: "", default_data_template: "" });
  });

  it("renames the SDK's snake_case keys at any depth", () => {
    const result = compile(template("defaultDataTemplate: { connection: { connectionUrl: 'u', nested: [{ useMid: true }] } }"));
    expect(messages(result)).toEqual([]);
    expect(JSON.parse(only(result, "sys_alias_templates")[0].default_data_template as string)).toEqual({
      connection: { connection_url: "u", nested: [{ use_mid: true }] },
    });
  });

  it.each([
    ["dynamicDataSchema: { a: Now.ID['y'] }", "AliasTemplate(): 'dynamicDataSchema' must be JSON data."],
    ["defaultDataTemplate: [Now.ID['x']]", "AliasTemplate(): 'defaultDataTemplate' must be JSON data."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(template(options)))).toEqual([message]);
  });
});
