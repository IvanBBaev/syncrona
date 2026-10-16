// SPDX-License-Identifier: GPL-3.0-or-later
//
// ClientScript() → sys_script_client.

import type * as TS from "typescript";
import { CData } from "../record";
import { lookup, type ArtefactSpec } from "./shared";

const UI_TYPES: Record<string, number> = {
  desktop: 0,
  mobile_or_service_portal: 1,
  all: 10,
};
const FIELD_TYPES = ["onChange", "onCellEdit"];

/** Whether a browser-side script imports or requires a module, which it cannot. */
function usesModules(ts: typeof TS, script: string): boolean {
  const source = ts.createSourceFile("client-script.ts", script, ts.ScriptTarget.Latest);
  const visit = (node: TS.Node): boolean =>
    ts.isImportDeclaration(node) ||
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") ||
    ts.forEachChild(node, visit) === true;
  return visit(source);
}

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
    return ctx.factory.createRecord({
      table: "sys_script_client",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        table: o.string("table"),
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
