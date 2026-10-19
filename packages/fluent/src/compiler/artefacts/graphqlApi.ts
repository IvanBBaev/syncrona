// SPDX-License-Identifier: GPL-3.0-or-later
//
// GraphQLApi() → sys_graphql_schema with a sys_graphql_resolver per resolver,
// a sys_graphql_resolver_mapping per resolver path (coalesced on the schema
// and the path) and a sys_graphql_typeresolver per type resolver.
//
// Like the SDK, the application namespace is derived from the scope (the
// platform's GraphQLApplicationNamespace default, which does not run on
// install); only a global app may name its own.

import type { FluentValue } from "../evaluate";
import { CData, type CreateRecordOptions } from "../record";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

const DEFAULT_CONTEXTUAL_ACL_MAX_DEPTH = 4;
const MAX_APPLICATION_NAMESPACE_LENGTH = 40;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The scope's application namespace: `x_snc_app` → `xSncApp`, global → `now`. */
function applicationNamespaceFromScope(scope: string): string {
  if (scope === "global") return "now";
  return scope.replace(/[-_][A-Za-z]/g, (boundary) => boundary.toUpperCase()).replace(/[^a-z0-9]/gi, "");
}

/** The `enforceAcl` list as unique comma-joined sys_ids, empty when absent. */
function enforcedAcls(o: Options, ctx: BuildContext): string {
  const ids = (o.array("enforceAcl") ?? []).map((item: FluentValue) => {
    if (item.kind === "call") return ctx.recordOf(item).id.getValue();
    if (item.kind !== "string") o.error("GraphQLApi(): 'enforceAcl' must be an array of ACL sys_ids or Acl() records.", item);
    return item.value;
  });
  return [...new Set(ids)].join(",");
}

/** Rejects the second occurrence of a value that must be unique within the API. */
function rejectDuplicates(o: Options, values: [string, FluentValue][], message: (value: string) => string): void {
  const seen = new Set<string>();
  for (const [value, source] of values) {
    if (seen.has(value)) o.error(message(value), source);
    seen.add(value);
  }
}

export const graphqlApi: ArtefactSpec = {
  properties: [
    "name",
    "applicationNamespace",
    "namespace",
    "schema",
    "active",
    "enforceAcl",
    "requiresAuthentication",
    "requiresAclAuthorization",
    "requiresSncInternalRole",
    "contextualAclMaxDepth",
    "resolvers",
    "typeResolvers",
  ],
  build(o, ctx) {
    const resolvers = (o.array("resolvers") ?? []).map((item, i) => o.sub(item, `resolvers[${i}].`, ["$id", "name", "script", "paths"]));
    const typeResolvers = (o.array("typeResolvers") ?? []).map((item, i) => o.sub(item, `typeResolvers[${i}].`, ["$id", "typeName", "script"]));
    const strings = (items: Options[], key: string) =>
      items.flatMap((r): [string, FluentValue][] => (r.get(key) ? [[r.requiredString(key), r.get(key)!]] : []));
    const paths = resolvers.map((r) =>
      (r.array("paths") ?? []).map((path): [string, FluentValue] =>
        path.kind === "string" ? [path.value, path] : r.error(`GraphQLApi(): '${r.path}paths' must be an array of strings.`, path),
      ),
    );
    rejectDuplicates(o, strings(resolvers, "name"), (name) => `Duplicate resolver name "${name}". Resolver names must be unique within a GraphQLApi.`);
    rejectDuplicates(o, paths.flat(), (path) => `Duplicate path "${path}". Each schema path can be served by only one resolver.`);
    rejectDuplicates(o, strings(typeResolvers, "typeName"), (type) => `Duplicate type resolver "${type}". Each type can have only one type resolver.`);

    const namespace = o.requiredString("namespace");
    if (!GRAPHQL_NAME.test(namespace)) {
      o.error(
        `Invalid namespace "${namespace}". A namespace must be a valid GraphQL name: a letter or underscore, followed by letters, digits, or underscores.`,
        o.get("namespace"),
      );
    }
    const global = ctx.scope === "global";
    const scoped = applicationNamespaceFromScope(ctx.scope);
    const requested = o.string("applicationNamespace");
    if (!global && requested && requested !== scoped) {
      ctx.report(
        "hint",
        `A custom application namespace is only supported in global scope. Using '${scoped}', derived from scope '${ctx.scope}'.`,
        o.get("applicationNamespace")!.loc,
      );
    }
    if (global && requested) {
      if (!GRAPHQL_NAME.test(requested)) {
        o.error(
          `Invalid application namespace "${requested}". An application namespace must be a valid GraphQL name: a letter or underscore, followed by letters, digits, or underscores.`,
          o.get("applicationNamespace"),
        );
      }
      if (requested.length > MAX_APPLICATION_NAMESPACE_LENGTH) {
        o.error(
          `Application namespace "${requested}" is ${requested.length} characters. The platform limits it to ${MAX_APPLICATION_NAMESPACE_LENGTH}.`,
          o.get("applicationNamespace"),
        );
      }
    }
    const applicationNamespace = global && requested ? requested : scoped;

    const schema = ctx.factory.createRecord({
      table: "sys_graphql_schema",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name"),
        application_namespace: applicationNamespace,
        namespace,
        schema: new CData(o.requiredString("schema")),
        active: o.boolean("active") ?? true,
        enforce_acl: enforcedAcls(o, ctx),
        requires_authentication: o.boolean("requiresAuthentication") ?? true,
        requires_acl_authorization: o.boolean("requiresAclAuthorization") ?? true,
        requires_snc_internal_role: o.boolean("requiresSncInternalRole") ?? true,
        contextual_acl_max_depth: o.number("contextualAclMaxDepth") ?? DEFAULT_CONTEXTUAL_ACL_MAX_DEPTH,
      },
    });
    const child = (table: string, source: FluentValue, explicitId: string | number | undefined, fields: CreateRecordOptions["fields"]) => {
      const record = ctx.factory.createRecord({ table, source: source.loc, installCategory: o.installCategory, explicitId, fields });
      schema.children.push(record);
      return record;
    };
    resolvers.forEach((r, i) => {
      const resolver = child("sys_graphql_resolver", r.object, r.explicitId(), {
        name: r.string("name"),
        script: new CData(r.string("script") ?? ""),
        schema,
      });
      for (const [path, source] of paths[i]) child("sys_graphql_resolver_mapping", source, undefined, { path, resolver, schema });
    });
    for (const t of typeResolvers) {
      child("sys_graphql_typeresolver", t.object, t.explicitId(), { type_name: t.string("typeName"), script: new CData(t.string("script") ?? ""), schema });
    }

    ctx.inspect((records) => {
      const first = records.find(
        (r) => r.table === "sys_graphql_schema" && r.fields.get("namespace") === namespace && r.fields.get("application_namespace") === applicationNamespace,
      );
      if (first !== schema) {
        ctx.report(
          "error",
          `Namespace "${namespace}" is already used by another GraphQL API in application namespace "${applicationNamespace}". Each API in an application namespace must have its own namespace.`,
          o.call.loc,
        );
      }
    });
    return schema;
  },
};
