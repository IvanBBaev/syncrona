// SPDX-License-Identifier: GPL-3.0-or-later
//
// Role() → sys_user_role, plus one sys_user_role_contains row per contained role.

import { isGUID } from "../keys";
import type { CompiledRecord, RecordId } from "../record";
import type { ArtefactSpec } from "./shared";

export const role: ArtefactSpec = {
  properties: [
    "name",
    "description",
    "grantable",
    "federatedId",
    "canDelegate",
    "elevatedPrivilege",
    "assignableBy",
    "containsRoles",
    "scopedAdmin",
  ],
  aliases: {
    can_delegate: "canDelegate",
    elevated_privilege: "elevatedPrivilege",
    assignable_by: "assignableBy",
    contains_roles: "containsRoles",
    scoped_admin: "scopedAdmin",
  },
  build(o, ctx) {
    const name = o.requiredString("name");
    if (ctx.scope.startsWith("x_") && !name.startsWith(`${ctx.scope}.`)) {
      ctx.report("error", `Role name must begin with '${ctx.scope}.'`, o.get("name")!.loc);
    }
    const federatedId = o.string("federatedId");
    const record = ctx.factory.createRecord({
      table: "sys_user_role",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        assignable_by: o.string("assignableBy") ?? "",
        can_delegate: o.boolean("canDelegate") ?? true,
        description: o.string("description") ?? "",
        elevated_privilege: o.boolean("elevatedPrivilege") ?? false,
        grantable: o.boolean("grantable") ?? true,
        scoped_admin: o.boolean("scopedAdmin") ?? false,
        suffix: name.replace(new RegExp(`^${ctx.scope}\\.`), ""),
        ...(federatedId !== undefined ? { federated_id: federatedId } : {}),
        sys_name: name,
      },
    });

    for (const element of o.array("containsRoles") ?? []) {
      let contains: RecordId | CompiledRecord;
      let containsName: string | undefined;
      if (element.kind === "string" && isGUID(element.value)) {
        ctx.report(
          "hint",
          `Unable to determine a role name for sys_id '${element.value}', so 'sys_name' will not be set on this record. Reference the role via Role() if it is defined in this project to populate sys_name.`,
          element.loc,
        );
        contains = ctx.factory.createReference("sys_user_role", element.value);
      } else if (element.kind === "string") {
        containsName = element.value;
        contains = ctx.factory.createReference("sys_user_role", undefined, { name: element.value });
      } else if (element.kind === "call") {
        contains = ctx.recordOf(element);
        if (contains.table !== "sys_user_role") o.error("Role(): 'containsRoles' must hold roles.", element);
        containsName = String(contains.fields.get("name"));
      } else {
        return o.error("Role(): 'containsRoles' must hold role names, sys_ids or Role() records.", element);
      }
      record.children.push(
        ctx.factory.createRecord({
          table: "sys_user_role_contains",
          source: o.call.loc,
          installCategory: o.installCategory,
          fields: {
            role: record,
            contains,
            ...(containsName !== undefined ? { sys_name: `${containsName}.${name}` } : {}),
          },
        }),
      );
    }
    return record;
  },
};
