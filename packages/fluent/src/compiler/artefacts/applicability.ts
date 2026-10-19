// SPDX-License-Identifier: GPL-3.0-or-later
//
// Applicability() → sys_ux_applicability: a workspace audience, by role.

import type { CompiledRecord } from "../record";
import { roleRecord, type ArtefactSpec } from "./shared";

export const applicability: ArtefactSpec = {
  properties: ["name", "description", "active", "roles", "roleNames"],
  build(o, ctx) {
    // A Role() contributes its sys_id and a string is taken verbatim, as the SDK does.
    const roles = (o.array("roles") ?? []).map((item) => {
      if (item.kind === "string") return item.value;
      if (item.kind === "call") return (roleRecord(o, ctx, item, "roles").role as CompiledRecord).id.getValue();
      return o.error(`${o.call.api}(): 'roles' must hold role sys_ids or Role() records.`, item);
    });
    return ctx.factory.createRecord({
      table: "sys_ux_applicability",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        description: o.string("description") ?? "",
        active: o.boolean("active") ?? true,
        roles: [...new Set(roles)].join(","),
        role_names: o.string("roleNames") ?? "",
      },
    });
  },
};
