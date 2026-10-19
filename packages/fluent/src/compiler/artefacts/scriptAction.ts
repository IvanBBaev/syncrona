// SPDX-License-Identifier: GPL-3.0-or-later
//
// ScriptAction() → sysevent_script_action.

import { CData } from "../record";
import type { ArtefactSpec } from "./shared";

export const scriptAction: ArtefactSpec = {
  properties: ["name", "active", "description", "script", "eventName", "order", "conditionScript"],
  build(o, ctx) {
    const name = o.requiredString("name");
    const condition = o.string("conditionScript");
    return ctx.factory.createRecord({
      table: "sysevent_script_action",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        description: o.string("description") ?? "",
        event_name: o.requiredString("eventName"),
        active: o.boolean("active") ?? false,
        condition_script: condition === undefined ? undefined : new CData(condition),
        script: new CData(o.requiredString("script")),
        order: o.number("order") ?? 100,
        sys_name: name,
      },
    });
  },
};
