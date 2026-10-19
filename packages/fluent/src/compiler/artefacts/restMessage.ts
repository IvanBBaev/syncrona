// SPDX-License-Identifier: GPL-3.0-or-later
//
// RestMessage() → sys_rest_message with a sys_rest_message_headers per
// message-level header and a sys_rest_message_fn per function (coalesced on
// the message and the function name); each function brings its own headers
// (sys_rest_message_fn_headers), variables (sys_rest_message_fn_parameters)
// and query parameters (sys_rest_message_fn_param_defs).
//
// Like the SDK, an authentication profile is written only for the matching
// authentication type, and missing names or methods are written empty.

import type { SourceLocation } from "../diagnostics";
import type { CreateRecordOptions } from "../record";
import { lookup, type ArtefactSpec, type Options } from "./shared";

const AUTHENTICATION_TYPES: Record<string, string> = {
  noAuthentication: "no_authentication",
  basic: "basic",
  oauth2: "oauth2",
  inheritFromParent: "inherit_from_parent",
};

const AUTH_PROPERTIES = ["authenticationType", "basicAuthProfile", "oauthProfile"];

/** The authentication fields of a message or function, `fallback` when no type is given. */
function authentication(o: Options, fallback: string): Record<string, string> {
  const type = o.string("authenticationType") ?? fallback;
  const value = lookup(AUTHENTICATION_TYPES, type);
  if (value === undefined) o.error(`${o.call.api}(): unknown authentication type '${type}' in '${o.path}authenticationType'.`, o.get("authenticationType"));
  return {
    authentication_type: value,
    basic_auth_profile: (type === "basic" && o.string("basicAuthProfile")) || "",
    oauth2_profile: (type === "oauth2" && o.string("oauthProfile")) || "",
  };
}

export const restMessage: ArtefactSpec = {
  properties: ["name", "endpoint", "description", "access", "headers", "functions", ...AUTH_PROPERTIES],
  build(o, ctx) {
    const access = o.string("access") ?? "packagePrivate";
    const message = ctx.factory.createRecord({
      table: "sys_rest_message",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        rest_endpoint: o.string("endpoint") ?? "",
        description: o.string("description") ?? "",
        access: access === "packagePrivate" ? "package_private" : access,
        ...authentication(o, "noAuthentication"),
      },
    });
    const child = (sub: Options, table: string, item: { loc: SourceLocation }, fields: CreateRecordOptions["fields"]) =>
      ctx.factory.createRecord({ table, source: item.loc, installCategory: o.installCategory, explicitId: sub.explicitId(), fields });
    (o.array("headers") ?? []).forEach((item, i) => {
      const h = o.sub(item, `headers[${i}].`, ["$id", "name", "value"]);
      message.children.push(
        child(h, "sys_rest_message_headers", item, { rest_message: message, name: h.string("name") ?? "", value: h.string("value") ?? "" }),
      );
    });
    (o.array("functions") ?? []).forEach((item, i) => {
      const key = `functions[${i}].`;
      const f = o.sub(item, key, [
        "name",
        "httpMethod",
        "endpoint",
        "content",
        "midServer",
        "lock",
        "headers",
        "variables",
        "queryParams",
        ...AUTH_PROPERTIES,
      ]);
      const fn = ctx.factory.createRecord({
        table: "sys_rest_message_fn",
        source: item.loc,
        installCategory: o.installCategory,
        fields: {
          rest_message: message,
          function_name: f.string("name") ?? "",
          http_method: f.string("httpMethod")?.toLowerCase() ?? "",
          rest_endpoint: f.string("endpoint") ?? "",
          content: f.string("content") ?? "",
          use_mid_server: f.string("midServer") ?? "",
          lock: f.boolean("lock") ?? false,
          ...authentication(f, "inheritFromParent"),
        },
      });
      (f.array("headers") ?? []).forEach((header, j) => {
        const h = o.sub(header, `${key}headers[${j}].`, ["$id", "name", "value"]);
        fn.children.push(
          child(h, "sys_rest_message_fn_headers", header, {
            rest_message_function: fn,
            name: h.string("name") ?? "",
            value: h.string("value") ?? "",
          }),
        );
      });
      (f.array("variables") ?? []).forEach((variable, j) => {
        const v = o.sub(variable, `${key}variables[${j}].`, ["$id", "name", "escapeType"]);
        fn.children.push(
          child(v, "sys_rest_message_fn_parameters", variable, {
            rest_message_function: fn,
            name: v.string("name") ?? "",
            type: v.string("escapeType") === "escapeXml" ? "xml" : "string",
          }),
        );
      });
      (f.array("queryParams") ?? []).forEach((param, j) => {
        const q = o.sub(param, `${key}queryParams[${j}].`, ["$id", "name", "value", "order"]);
        fn.children.push(
          child(q, "sys_rest_message_fn_param_defs", param, {
            rest_message_function: fn,
            name: q.string("name") ?? "",
            value: q.string("value") ?? "",
            order: q.scalar("order") ?? 0,
          }),
        );
      });
      message.children.push(fn);
    });
    return message;
  },
};
