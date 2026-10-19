// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const api = (options: string, id = "api") => `GraphQLApi({ $id: Now.ID['${id}'], name: 'API', schema: 'type Query { a: String }', ${options} })\n`;

describe("GraphQLApi()", () => {
  it("writes empty scripts for a bare resolver and type resolver", () => {
    const result = compile(api("namespace: 'n', resolvers: [{ $id: Now.ID['r'] } as any], typeResolvers: [{ $id: Now.ID['t'] } as any]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_graphql_resolver")[0]).toMatchObject({ script: "" });
    expect(only(result, "sys_graphql_typeresolver")[0]).toMatchObject({ script: "" });
    expect(only(result, "sys_graphql_resolver_mapping")).toEqual([]);
  });

  it("derives the application namespace from the scope and hints at a custom one", () => {
    const result = compile(api("namespace: 'n', applicationNamespace: 'other'"));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(["A custom application namespace is only supported in global scope. Using 'xSncBprobe', derived from scope 'x_snc_bprobe'."]);
    expect(only(result, "sys_graphql_schema")[0]).toMatchObject({ application_namespace: "xSncBprobe", enforce_acl: "" });
  });

  it("uses 'now' in global scope unless the API names its own", () => {
    const result = compile(api("namespace: 'n'") + api("namespace: 'n', applicationNamespace: 'mine'", "other"), {}, { scope: "global" });
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([]);
    expect(only(result, "sys_graphql_schema").map((r) => r.application_namespace)).toEqual(["now", "mine"]);
  });

  it.each([
    ["applicationNamespace: '1x'", 'Invalid application namespace "1x". An application namespace must be a valid GraphQL name: a letter or underscore, followed by letters, digits, or underscores.'],
    [`applicationNamespace: '${"a".repeat(41)}'`, `Application namespace "${"a".repeat(41)}" is 41 characters. The platform limits it to 40.`],
  ])("rejects a global application namespace %s", (option, error) => {
    expect(messages(compile(api(`namespace: 'n', ${option}`), {}, { scope: "global" }))).toEqual([error]);
  });

  it("rejects a namespace another API of the application namespace uses", () => {
    expect(messages(compile(api("namespace: 'n'") + api("namespace: 'n'", "other")))).toEqual([
      'Namespace "n" is already used by another GraphQL API in application namespace "xSncBprobe". Each API in an application namespace must have its own namespace.',
    ]);
  });

  it.each([
    [api("namespace: 'a-b'"), 'Invalid namespace "a-b". A namespace must be a valid GraphQL name: a letter or underscore, followed by letters, digits, or underscores.'],
    ["GraphQLApi({ name: 'API', namespace: 'n' } as any)", "GraphQLApi(): 'schema' is required."],
    [api("namespace: 'n', enforceAcl: [1 as any]"), "GraphQLApi(): 'enforceAcl' must be an array of ACL sys_ids or Acl() records."],
    [api("namespace: 'n', resolvers: [{ name: 'a', script: '', paths: [1 as any] }]"), "GraphQLApi(): 'resolvers[0].paths' must be an array of strings."],
    [
      api("namespace: 'n', resolvers: [{ name: 'a', script: '', paths: [] }, { name: 'a', script: '', paths: [] }]"),
      'Duplicate resolver name "a". Resolver names must be unique within a GraphQLApi.',
    ],
    [
      api("namespace: 'n', resolvers: [{ name: 'a', script: '', paths: ['Query:a'] }, { name: 'b', script: '', paths: ['Query:a'] }]"),
      'Duplicate path "Query:a". Each schema path can be served by only one resolver.',
    ],
    [
      api("namespace: 'n', typeResolvers: [{ typeName: 'T', script: '' }, { typeName: 'T', script: '' }]"),
      'Duplicate type resolver "T". Each type can have only one type resolver.',
    ],
  ])("rejects %s", (source, error) => {
    expect(messages(compile(source))).toEqual([error]);
  });
});
