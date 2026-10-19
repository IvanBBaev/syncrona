// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const api = (options: string) => `RestApi({ $id: Now.ID['api'], name: 'A', serviceId: 'a', ${options} })\n`;

describe("RestApi()", () => {
  it("reads the deprecated aliases with a hint and puts every record in the $meta install category", () => {
    const result = compile(`RestApi({ $id: Now.ID['api'], name: 'A', service_id: 'a', short_description: 'd', doc_link: 'l', enforce_acl: [], policy: 'read',
      $meta: { installMethod: 'demo' },
      versions: [{ $id: Now.ID['v1'], version: 1, is_default: true, short_description: 'v' }],
      routes: [{ $id: Now.ID['r'], script: 's', version: 1, short_description: 'r', request_example: 'e', enforce_acl: ['x', 'x', 'y'], policy: 'protected',
        headers: [{ $id: Now.ID['h'], name: 'H', short_description: 'h', example_value: 'hv' }] }] } as any)\n`);
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(
      expect.arrayContaining(["The property 'service_id' is deprecated, use 'serviceId' instead.", "The property 'example_value' is deprecated, use 'exampleValue' instead."]),
    );
    expect(only(result, "sys_ws_definition")[0]).toMatchObject({ service_id: "a", short_description: "d", doc_link: "l", enforce_acl: "", sys_policy: "read", default_version: "v1" });
    expect(only(result, "sys_ws_version")[0]).toMatchObject({ is_default: "true", short_description: "v" });
    expect(only(result, "sys_ws_operation")[0]).toMatchObject({ short_description: "r", request_example: "e", enforce_acl: "x,y", sys_policy: "protected" });
    expect(only(result, "sys_ws_header")[0]).toMatchObject({ short_description: "h", example_value: "hv" });
    expect(result.records.map((r) => r.path.split("/")[0])).toEqual(Array(5).fill("unload.demo"));
  });

  it("uses the scope as namespace outside ServiceNow scopes and a custom namespace inside them", () => {
    const custom = compile(api("namespace: 'custom'"));
    expect(messages(custom, "hint")).toEqual(["Custom namespace is only supported for ServiceNow scoped applications. Using scope 'x_snc_bprobe' as namespace."]);
    expect(only(custom, "sys_ws_definition")[0]).toMatchObject({ namespace: "x_snc_bprobe", base_uri: "/api/x_snc_bprobe/a" });
    expect(messages(compile(api("namespace: 'x_snc_bprobe'")), "hint")).toEqual([]);
    const sn = compile(api("namespace: 'custom', routes: [{ $id: Now.ID['r'], path: '/p', script: 's' }]"), {}, { scope: "sn_app" });
    expect(messages(sn, "hint")).toEqual([]);
    expect(only(sn, "sys_ws_operation")[0]).toMatchObject({ operation_uri: "/api/custom/a/p", default_operation_uri: "/api/custom/a/p" });
  });

  it("writes routes without a version, script or name, and lets a write method override the media type", () => {
    const result = compile(
      api(`produces: 'application/json,application/xml,text/xml', routes: [
        { $id: Now.ID['r0'], version: 0 } as any,
        { $id: Now.ID['r1'], method: 'PUT', consumes: 'text/plain', path: '/p' },
        { $id: Now.ID['r2'], consumes: 'application/json,application/xml,text/xml', path: '/q', script: 's' },
      ]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ws_definition")[0]).toMatchObject({ produces_customized: "false", is_versioned: "false" });
    expect(only(result, "sys_ws_operation").map((r) => [r.name, r.web_service_version, r.operation_script, r.consumes_customized, r.http_method])).toEqual(
      expect.arrayContaining([
        ["/", "", "", "false", "GET"],
        ["/p", "", "", "true", "PUT"],
        ["/q", "", "s", "false", "GET"],
      ]),
    );
  });

  it("writes a header two routes share once, with a map row per route", () => {
    const header = "{ $id: Now.ID['h'], name: 'H', required: true }";
    const result = compile(
      api(`routes: [{ $id: Now.ID['r1'], path: '/1', script: 's', headers: [${header}], parameters: [{ $id: Now.ID['q'], name: 'q' }] },
        { $id: Now.ID['r2'], path: '/2', script: 's', headers: [${header}] }]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_ws_header")).toEqual([expect.objectContaining({ name: "H", required: "true" })]);
    expect(only(result, "sys_ws_header_map")).toHaveLength(2);
    expect(only(result, "sys_ws_query_parameter_map")).toHaveLength(1);
  });

  it.each([
    [api("serviceId: 'Bad-Id'").replace("serviceId: 'a', ", ""), "Rest service_id must only contain lowercase letters, numbers, and underscores and end with a letter or number"],
    [api("versions: [{ $id: Now.ID['v1'], version: 1, isDefault: true }, { $id: Now.ID['v2'], version: 2, isDefault: true }]"), "Multiple versions cannot be set to default."],
    [
      api("versions: [{ $id: Now.ID['v1'], version: 1 }, { $id: Now.ID['v2'], version: 1 }]"),
      'Duplicate versions with version number "1" found in RestApi with id "api". All versions are expected to be unique.',
    ],
    [api("versions: [{ $id: Now.ID['v1'] } as any]"), "RestApi(): 'versions[0].version' is required."],
    [
      api("versions: [{ $id: Now.ID['v1'], version: 1 }], routes: [{ $id: Now.ID['r'], script: 's', version: 2 as any }]"),
      'Unable to resolve version details for version number "2". Check if the version is listed in your API versions list.',
    ],
    [api("routes: [{ $id: Now.ID['r'], script: 's', consumes: 'text/plain' }]"), "Cannot override consumer type for GET method"],
    [
      api(`routes: [{ $id: Now.ID['r1'], path: '/1', script: 's', headers: [{ $id: Now.ID['h'], name: 'H' }] },
        { $id: Now.ID['r2'], path: '/2', script: 's', headers: [{ $id: Now.ID['h'], name: 'Other' }] }]`),
      'Multiple route attributes found with the same ID "h" but with different property values. Attributes with same ID are expected to have identical property values.',
    ],
    [api("enforceAcl: [1 as any]"), "RestApi(): 'enforceAcl' must be an array of ACL sys_ids or Acl() records."],
    [api("routes: [{ $id: Now.ID['r'], script: 's', verb: 'x' } as any]"), "RestApi() has no property 'routes[0].verb'."],
  ])("rejects %s", (source, error) => {
    expect(messages(compile(source))).toEqual([error]);
  });
});
