// SPDX-License-Identifier: GPL-3.0-or-later
//
// RestApi() → sys_ws_definition with a sys_ws_version per version and a
// sys_ws_operation per route; each route brings its headers (sys_ws_header)
// and query parameters (sys_ws_query_parameter), linked through
// sys_ws_header_map and sys_ws_query_parameter_map rows.
//
// Like the SDK, a header or parameter several routes of one API share by
// `$id` is written once (and must be declared identically), only its map row
// repeats, and `$meta` puts every record of the API in its install category.

import type { FluentValue } from "../evaluate";
import { CData, RecordId, type CompiledRecord } from "../record";
import { isSNScope, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const DEFAULT_MEDIA_TYPE = "application/json,application/xml,text/xml";
const DEFAULT_ENFORCED_ACL = "cf9d01d3e73003009d6247e603f6a990";
const OVERRIDING_METHODS = ["PUT", "PATCH", "POST"];
const SERVICE_ID = /^[a-z0-9_]*[a-z0-9]$/;

const ROUTE_ALIASES = {
  short_description: "shortDescription",
  request_example: "requestExample",
  enforce_acl: "enforceAcl",
  policy: "protectionPolicy",
};
const VERSION_ALIASES = { is_default: "isDefault", short_description: "shortDescription" };
const ATTRIBUTE_ALIASES = { short_description: "shortDescription", example_value: "exampleValue" };

/** The `enforceAcl` list as unique comma-joined sys_ids, or the SDK's default ACL when absent. */
function enforcedAcls(o: Options, ctx: BuildContext): string {
  const items = o.array("enforceAcl");
  if (items === undefined) return DEFAULT_ENFORCED_ACL;
  const ids = items.map((item: FluentValue) => {
    if (item.kind === "call") return ctx.recordOf(item).id.getValue();
    if (item.kind !== "string") o.error(`RestApi(): '${o.path}enforceAcl' must be an array of ACL sys_ids or Acl() records.`, item);
    return item.value;
  });
  return [...new Set(ids)].join(",");
}

export const restApi: ArtefactSpec = {
  properties: [
    "name",
    "serviceId",
    "active",
    "consumes",
    "produces",
    "namespace",
    "enforceAcl",
    "shortDescription",
    "docLink",
    "versions",
    "routes",
  ],
  aliases: {
    service_id: "serviceId",
    enforce_acl: "enforceAcl",
    doc_link: "docLink",
    short_description: "shortDescription",
    policy: "protectionPolicy",
  },
  build(o, ctx) {
    const scope = ctx.scope;
    const userNamespace = o.string("namespace");
    const namespace = isSNScope(scope) && userNamespace ? userNamespace : scope;
    if (!isSNScope(scope) && userNamespace && userNamespace !== scope) {
      ctx.report(
        "hint",
        `Custom namespace is only supported for ServiceNow scoped applications. Using scope '${scope}' as namespace.`,
        o.get("namespace")!.loc,
      );
    }
    const serviceId = o.requiredString("serviceId");
    if (!SERVICE_ID.test(serviceId)) {
      o.error("Rest service_id must only contain lowercase letters, numbers, and underscores and end with a letter or number", o.get("serviceId"));
    }

    const versions = (o.array("versions") ?? []).map((item, i) => {
      const v = o.sub(item, `versions[${i}].`, ["$id", "version", "active", "deprecated", "isDefault", "shortDescription"], VERSION_ALIASES);
      return { v, version: v.number("version") ?? v.error(`RestApi(): 'versions[${i}].version' is required.`, item) };
    });
    const defaults = versions.filter(({ v }) => v.boolean("isDefault") ?? false);
    if (defaults.length > 1) o.error("Multiple versions cannot be set to default.", o.get("versions"));
    const defaultVersion = defaults.length === 1 ? defaults[0].version : undefined;

    const consumes = o.string("consumes");
    const produces = o.string("produces");
    const apiConsumes = consumes ?? DEFAULT_MEDIA_TYPE;
    const apiProduces = produces ?? DEFAULT_MEDIA_TYPE;
    const baseUri = `/api/${namespace}/${serviceId}`;
    const definition = ctx.factory.createRecord({
      table: "sys_ws_definition",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name"),
        service_id: serviceId,
        active: o.boolean("active") ?? true,
        base_uri: baseUri,
        short_description: o.string("shortDescription") ?? "",
        consumes: apiConsumes,
        consumes_customized: consumes !== undefined && consumes !== DEFAULT_MEDIA_TYPE,
        default_version: defaultVersion !== undefined ? `v${defaultVersion}` : "No active default version",
        is_versioned: versions.length > 0,
        namespace,
        doc_link: o.string("docLink") ?? "",
        produces: apiProduces,
        produces_customized: produces !== undefined && produces !== DEFAULT_MEDIA_TYPE,
        sys_policy: o.string("protectionPolicy") ?? "",
        enforce_acl: enforcedAcls(o, ctx),
      },
    });
    const record = (sub: Options, table: string, fields: Parameters<typeof ctx.factory.createRecord>[0]["fields"]) =>
      ctx.factory.createRecord({ table, source: sub.object.loc, installCategory: o.installCategory, explicitId: sub.explicitId(), fields });

    const versionRecords = new Map<number, CompiledRecord>();
    for (const { v, version } of versions) {
      if (versionRecords.has(version)) {
        v.error(
          `Duplicate versions with version number "${version}" found in RestApi with id "${o.explicitId()}". All versions are expected to be unique.`,
          v.get("version"),
        );
      }
      const versionRecord = record(v, "sys_ws_version", {
        active: v.boolean("active") ?? true,
        deprecated: v.boolean("deprecated") ?? false,
        is_default: defaultVersion === version,
        short_description: v.string("shortDescription") ?? "",
        version,
        version_id: `v${version}`,
        web_service_definition: definition,
      });
      versionRecords.set(version, versionRecord);
      definition.children.push(versionRecord);
    }

    // Headers and parameters already written by an earlier route, with the fields they were declared with.
    const shared = new Map<string, string>();
    const attributes = (route: Options, operation: CompiledRecord, key: string, type: "header" | "query_parameter") => {
      (route.array(key) ?? []).forEach((item, j) => {
        const a = route.sub(item, `${key}[${j}].`, ["$id", "name", "required", "shortDescription", "exampleValue"], ATTRIBUTE_ALIASES);
        const attribute = record(a, `sys_ws_${type}`, {
          name: a.string("name"),
          required: a.boolean("required") ?? false,
          short_description: a.string("shortDescription") ?? "",
          example_value: a.string("exampleValue") ?? "",
          web_service_definition: definition,
        });
        const map = ctx.factory.createRecord({
          table: `sys_ws_${type}_map`,
          source: item.loc,
          installCategory: o.installCategory,
          fields: { web_service_operation: operation, [`web_service_${type}`]: attribute },
        });
        const id = `${attribute.table}.${attribute.id.getValue()}`;
        const declared = JSON.stringify([...attribute.fields].map(([k, v]) => [k, v instanceof RecordId ? v.getValue() : v]));
        const earlier = shared.get(id);
        if (earlier === undefined) {
          shared.set(id, declared);
          operation.children.push(attribute);
        } else if (earlier !== declared) {
          a.error(
            `Multiple route attributes found with the same ID "${a.explicitId()}" but with different property values. Attributes with same ID are expected to have identical property values.`,
            a.get("$id"),
          );
        }
        operation.children.push(map);
      });
    };

    (o.array("routes") ?? []).forEach((item, i) => {
      const route = o.sub(
        item,
        `routes[${i}].`,
        [
          "$id",
          "name",
          "script",
          "method",
          "path",
          "active",
          "consumes",
          "produces",
          "authorization",
          "authentication",
          "internalRole",
          "parameters",
          "headers",
          "version",
          "enforceAcl",
          "shortDescription",
          "requestExample",
          "protectionPolicy",
        ],
        ROUTE_ALIASES,
      );
      const version = route.number("version");
      const versionRecord = version ? versionRecords.get(version) : undefined;
      if (version && !versionRecord) {
        route.error(
          `Unable to resolve version details for version number "${version}". Check if the version is listed in your API versions list.`,
          route.get("version"),
        );
      }
      const method = route.string("method") ?? "GET";
      const routeConsumes = route.string("consumes") ?? "";
      if (routeConsumes && routeConsumes !== apiConsumes && !OVERRIDING_METHODS.includes(method)) {
        route.error(`Cannot override consumer type for ${method} method`, route.get("consumes"));
      }
      const effectiveConsumes = routeConsumes || apiConsumes;
      const effectiveProduces = route.string("produces") ?? apiProduces;
      const path = route.string("path") ?? "/";
      const script = route.string("script");
      const operation = record(route, "sys_ws_operation", {
        name: route.string("name") ?? path,
        active: route.boolean("active") ?? true,
        consumes: effectiveConsumes,
        consumes_customized: effectiveConsumes !== apiConsumes,
        default_operation_uri: `${baseUri}${path}`,
        http_method: method,
        operation_script: script !== undefined ? new CData(script) : "",
        operation_uri: versionRecord ? `/api/${namespace}/v${version}/${serviceId}${path}` : `/api/${namespace}/${serviceId}${path}`,
        produces: effectiveProduces,
        produces_customized: effectiveProduces !== apiProduces,
        relative_path: path,
        enforce_acl: enforcedAcls(route, ctx),
        requires_acl_authorization: route.boolean("authorization") ?? true,
        requires_authentication: route.boolean("authentication") ?? true,
        requires_snc_internal_role: route.boolean("internalRole") ?? true,
        short_description: route.string("shortDescription") ?? "",
        request_example: route.string("requestExample") ?? "",
        web_service_definition: definition,
        web_service_version: versionRecord ?? "",
        sys_policy: route.string("protectionPolicy") ?? "",
      });
      attributes(route, operation, "headers", "header");
      attributes(route, operation, "parameters", "query_parameter");
      definition.children.push(operation);
    });
    return definition;
  },
};
