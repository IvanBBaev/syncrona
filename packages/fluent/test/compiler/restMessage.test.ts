// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const message = (options: string) => `RestMessage({ $id: Now.ID['m'], name: 'M', endpoint: 'https://m', ${options} })\n`;

describe("RestMessage()", () => {
  it("writes an authentication profile only for its authentication type", () => {
    const result = compile(
      message(`description: 'd', authenticationType: 'basic', oauthProfile: 'o1', functions: [
        { name: 'a', httpMethod: 'GET', authenticationType: 'oauth2', basicAuthProfile: 'b2' },
        { name: 'b', httpMethod: 'GET', authenticationType: 'basic' },
        { name: 'c', httpMethod: 'GET', authenticationType: 'oauth2', oauthProfile: 'o3' },
      ]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_rest_message")[0]).toMatchObject({ description: "d", authentication_type: "basic", basic_auth_profile: "", oauth2_profile: "" });
    expect(only(result, "sys_rest_message_fn").map((f) => [f.function_name, f.authentication_type, f.basic_auth_profile, f.oauth2_profile])).toEqual(
      expect.arrayContaining([
        ["a", "oauth2", "", ""],
        ["b", "basic", "", ""],
        ["c", "oauth2", "", "o3"],
      ]),
    );
  });

  it("writes an unknown access as is and missing names, endpoints and methods empty", () => {
    const result = compile(
      `RestMessage({ $id: Now.ID['m'], access: 'other', functions: [{ name: 'x' }, { httpMethod: 'Foo' }] } as any)\n`,
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_rest_message")[0]).toMatchObject({ name: "", rest_endpoint: "", access: "other" });
    expect(only(result, "sys_rest_message_fn").map((f) => [f.function_name, f.http_method])).toEqual(
      expect.arrayContaining([
        ["x", ""],
        ["", "foo"],
      ]),
    );
  });

  it("writes missing descriptions, names and values empty", () => {
    const result = compile(
      message(`headers: [{ $id: Now.ID['h'] } as any], functions: [{ name: 'f', httpMethod: 'GET',
        headers: [{ $id: Now.ID['fh'] } as any], variables: [{ $id: Now.ID['v'] } as any], queryParams: [{ $id: Now.ID['q'] } as any] }]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_rest_message")[0]).toMatchObject({ description: "" });
    for (const table of ["sys_rest_message_headers", "sys_rest_message_fn_headers"]) {
      expect(only(result, table)[0]).toMatchObject({ name: "", value: "" });
    }
    expect(only(result, "sys_rest_message_fn_parameters")[0]).toMatchObject({ name: "", type: "string" });
    expect(only(result, "sys_rest_message_fn_param_defs")[0]).toMatchObject({ name: "", value: "", order: "0" });
  });

  it("references the function by its coalesce keys and writes query parameter defaults", () => {
    const result = compile(
      message(`functions: [{ name: 'f', httpMethod: 'GET', queryParams: [{ $id: Now.ID['q'], name: 'q', value: 'x', order: '5' as any }, { $id: Now.ID['r'], name: 'r' }] }]`),
    );
    expect(messages(result)).toEqual([]);
    const [fn] = only(result, "sys_rest_message_fn");
    const [message_] = only(result, "sys_rest_message");
    expect(only(result, "sys_rest_message_fn_param_defs")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "q",
          order: "5",
          value: "x",
          rest_message_function: fn.sys_id,
          "rest_message_function@rest_message": message_.sys_id,
          "rest_message_function@function_name": "f",
        }),
        expect.objectContaining({ name: "r", order: "0" }),
      ]),
    );
  });

  it.each([
    [message("authenticationType: 'digest' as any"), "RestMessage(): unknown authentication type 'digest' in 'authenticationType'."],
    [
      message("functions: [{ name: 'f', httpMethod: 'GET', authenticationType: 'digest' as any }]"),
      "RestMessage(): unknown authentication type 'digest' in 'functions[0].authenticationType'.",
    ],
    [message("headers: [{ name: 'h', value: 'v' } as any]"), "Cannot determine the sys_id of this sys_rest_message_headers record: give it a $id."],
    [message("functions: [{ name: 'f', httpMethod: 'GET', verb: 'x' } as any]"), "RestMessage() has no property 'functions[0].verb'."],
  ])("rejects %s", (source, error) => {
    expect(messages(compile(source))).toEqual([error]);
  });

  it("reports two functions with one name as a conflict", () => {
    const result = compile(message("functions: [{ name: 'f', httpMethod: 'GET' }, { name: 'f', httpMethod: 'POST' }]"));
    expect(messages(result).join("\n")).toMatch(/Record "sys_rest_message_fn\.[0-9a-f]{32}" is defined 2 times in the project/);
  });
});
