// SPDX-License-Identifier: GPL-3.0-or-later
//
// ApplicationMenu() → sys_app_application.

import type { RecordId } from "../record";
import { roleRecord, type ArtefactSpec } from "./shared";

export const applicationMenu: ArtefactSpec = {
  properties: ["title", "active", "roles", "category", "hint", "description", "name", "order"],
  build(o, ctx) {
    // The SDK joins the role names as given, duplicates included.
    const roles = (o.array("roles") ?? []).map((item) => {
      if (item.kind === "string") return item.value;
      if (item.kind === "call") return roleRecord(o, ctx, item, "roles").name;
      return o.error("ApplicationMenu(): 'roles' must hold role names or Role() records.", item);
    });
    const categoryValue = o.get("category");
    let category: string | RecordId = "";
    if (categoryValue?.kind === "call") category = ctx.recordOf(categoryValue).id;
    else if (categoryValue !== undefined) category = o.string("category")!;
    return ctx.factory.createRecord({
      table: "sys_app_application",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        title: o.requiredString("title"),
        hint: o.string("hint") ?? "",
        description: o.string("description") ?? "",
        name: o.string("name") ?? "",
        active: o.boolean("active") ?? true,
        order: o.number("order") ?? 100,
        device_type: "browser",
        roles: roles.join(","),
        category,
      },
    });
  },
};
