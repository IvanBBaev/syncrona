// SPDX-License-Identifier: GPL-3.0-or-later
//
// Alias() → sys_alias.

import type { FluentValue } from "../evaluate";
import type { CompiledRecord } from "../record";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** Connection type option → the platform value. */
const CONNECTION_TYPES: Record<string, string> = {
  httpConnection: "http_connection",
  jdbcConnection: "jdbc_connection",
  basicConnection: "sys_connection",
  jmsConnection: "orch_jms_ds",
};
/** The retry policy a connection alias of each type gets when it names none. */
const DEFAULT_RETRY_POLICIES: Record<string, string> = {
  http_connection: "ef751ff07301330025d71afe2ff6a7f9",
  jdbc_connection: "e8ddcb7573331010cbfec9d234f6a7fd",
  sys_connection: "e385484773100010e3a71afe2ff6a709",
};
const CONNECTION_ONLY = "only applies to 'connection' type aliases.";

/** A sys_id string, or the record of an API call on `table`. */
function recordOrId(o: Options, ctx: BuildContext, key: string, table: string): string | CompiledRecord | undefined {
  const value: FluentValue | undefined = o.get(key);
  if (value?.kind !== "call") return o.string(key);
  const record = ctx.recordOf(value);
  if (record.table !== table) o.error(`Alias(): '${key}' must be a sys_id or a ${table} record.`, value);
  return record;
}

export const alias: ArtefactSpec = {
  properties: ["name", "type", "connectionType", "description", "parent", "configurationTemplate", "retryPolicy", "multipleConnections"],
  build(o, ctx) {
    const name = o.string("name")?.trim() ?? "";
    if (name === "") o.error("'name' is required and cannot be empty.", o.get("name"));
    const type = o.string("type") ?? "connection";
    if (type !== "connection" && type !== "credential") o.error("Alias(): 'type' must be 'connection' or 'credential'.", o.get("type"));
    const connectionTypeOption = o.string("connectionType");
    const connectionType =
      connectionTypeOption === undefined
        ? "http_connection"
        : (lookup(CONNECTION_TYPES, connectionTypeOption) ??
          o.error(`Alias(): 'connectionType' must be one of ${Object.keys(CONNECTION_TYPES).join(", ")}.`, o.get("connectionType")));
    if (type === "credential") {
      for (const key of ["connectionType", "parent", "multipleConnections", "retryPolicy"]) {
        const value = o.get(key);
        if (value === undefined) continue;
        const message =
          key === "parent"
            ? "'parent' field is not visible in the UI when type is 'credential'. Parent aliases are only supported for 'connection' type aliases."
            : `'${key}' is ignored when type is 'credential'. It ${CONNECTION_ONLY}`;
        ctx.report("warning", message, value.loc);
      }
    }
    const defaultRetryPolicy = type === "connection" ? (lookup(DEFAULT_RETRY_POLICIES, connectionType) ?? "") : "";
    return ctx.factory.createRecord({
      table: "sys_alias",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name"),
        id: ctx.scope === "global" ? sanitize(name) : `${ctx.scope}.${sanitize(name)}`,
        type,
        connection_type: connectionType,
        description: o.string("description") ?? "",
        parent: recordOrId(o, ctx, "parent", "sys_alias"),
        configuration_template: recordOrId(o, ctx, "configurationTemplate", "sys_alias_templates"),
        retry_policy: recordOrId(o, ctx, "retryPolicy", "sys_retry_policy") ?? defaultRetryPolicy,
        multiple_connections: o.boolean("multipleConnections") ?? false,
        sys_policy: o.protectionPolicy(),
      },
    });
  },
};

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
