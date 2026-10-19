// SPDX-License-Identifier: GPL-3.0-or-later
//
// ClientScript() → sys_script_client.

import { CData } from "../record";
import { lookup, usesModules, type ArtefactSpec } from "./shared";

const UI_TYPES: Record<string, number> = {
  desktop: 0,
  mobile_or_service_portal: 1,
  all: 10,
};
const FIELD_TYPES = ["onChange", "onCellEdit"];

export const clientScript: ArtefactSpec = {
  properties: [
    "table",
    "global",
    "view",
    "field",
    "script",
    "type",
    "name",
    "active",
    "appliesExtended",
    "description",
    "messages",
    "isolateScript",
    "uiType",
    "order",
  ],
  aliases: {
    applies_extended: "appliesExtended",
    isolate_script: "isolateScript",
    ui_type: "uiType",
  },
  build(o, ctx) {
    const name = o.string("name");
    const type = o.string("type");
    const field = o.string("field");
    if (field !== undefined && !FIELD_TYPES.includes(type ?? "")) {
      ctx.report("warning", "Field value takes effect only when type is set to onChange or onCellEdit", o.get("field")!.loc);
    }
    const script = o.string("script");
    if (script !== undefined && usesModules(ctx.ts, script)) {
      ctx.report("error", "Client side scripts cannot import or require modules.", o.get("script")!.loc);
    }
    const uiType = o.string("uiType");
    const order = o.number("order");
    const table = o.string("table");
    if (table !== undefined) {
      ctx.dictionary.refer(
        "ClientScript",
        table,
        o.get("table")!.loc,
        field === undefined ? undefined : { name: field, location: o.get("field")!.loc },
      );
    }
    return ctx.factory.createRecord({
      table: "sys_script_client",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        table,
        global: o.boolean("global") ?? true,
        view: o.string("view"),
        field,
        script: script !== undefined ? new CData(script) : undefined,
        type,
        name,
        active: o.boolean("active") ?? true,
        applies_extended: o.boolean("appliesExtended") ?? false,
        description: o.string("description"),
        messages: o.string("messages"),
        isolate_script: o.boolean("isolateScript") ?? false,
        ui_type:
          uiType === undefined
            ? 0
            : (lookup(UI_TYPES, uiType) ??
              o.error(
                `ClientScript(): 'uiType' must be one of ${Object.keys(UI_TYPES)
                  .map((t) => `'${t}'`)
                  .join(", ")}.`,
                o.get("uiType"),
              )),
        sys_name: name,
        ...(order !== undefined ? { order } : {}),
      },
    });
  },
};
