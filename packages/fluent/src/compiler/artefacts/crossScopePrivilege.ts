// SPDX-License-Identifier: GPL-3.0-or-later
//
// CrossScopePrivilege() → sys_scope_privilege.

import { lookup, type ArtefactSpec } from "./shared";

const STATUSES = ["requested", "allowed", "denied"];
/** The target types each operation applies to. */
const TARGET_TYPES: Record<string, readonly string[]> = {
  execute: ["sys_script_include", "scriptable"],
  create: ["sys_db_object"],
  read: ["sys_db_object"],
  write: ["sys_db_object"],
  delete: ["sys_db_object"],
};

export const crossScopePrivilege: ArtefactSpec = {
  properties: ["operation", "status", "targetName", "targetScope", "targetType"],
  aliases: {
    target_name: "targetName",
    target_scope: "targetScope",
    target_type: "targetType",
  },
  build(o, ctx) {
    const operation = o.requiredString("operation");
    const types = lookup(TARGET_TYPES, operation);
    if (!types) return o.error(`CrossScopePrivilege(): 'operation' must be one of ${Object.keys(TARGET_TYPES).join(", ")}.`, o.get("operation"));
    const status = o.requiredString("status");
    if (!STATUSES.includes(status)) o.error(`CrossScopePrivilege(): 'status' must be one of ${STATUSES.join(", ")}.`, o.get("status"));
    const targetType = o.requiredString("targetType");
    if (!types.includes(targetType)) {
      o.error(`CrossScopePrivilege(): 'targetType' must be ${types.join(" or ")} when 'operation' is '${operation}'.`, o.get("targetType"));
    }
    return ctx.factory.createRecord({
      table: "sys_scope_privilege",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        operation,
        status,
        target_name: o.requiredString("targetName"),
        target_scope: ctx.factory.createReference("sys_scope", o.requiredString("targetScope")),
        target_type: targetType,
        source_scope: ctx.scopeId,
      },
    });
  },
};
