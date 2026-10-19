// SPDX-License-Identifier: GPL-3.0-or-later
//
// Role() → sys_user_role, plus one sys_user_role_contains row per contained role.

import { roleReference, type ArtefactSpec } from "./shared";

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
      const { role: contains, name: containsName } = roleReference(o, ctx, element, "containsRoles");
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
