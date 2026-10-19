// SPDX-License-Identifier: GPL-3.0-or-later
//
// UiPolicy() → sys_ui_policy, plus a sys_ui_policy_action row per action and
// a sys_ui_policy_rl_action row per related list action.

import { isGUID } from "../keys";
import { CData, type RecordId } from "../record";
import { lookup, usesModules, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const DEFAULT_SCRIPT = "function onCondition() {\n\n}";
const UI_TYPES: Record<string, number> = { desktop: 0, "mobile-or-service-portal": 1, all: 10 };
const FIELD_MESSAGE_TYPES = ["error", "info", "warning", "none"];
const ACTION_PROPERTIES = ["field", "visible", "readOnly", "mandatory", "cleared", "table", "value", "fieldMessage", "fieldMessageType", "valueAction"];

/** `visible` / `readOnly` / `mandatory`: a boolean or 'ignore', stored as a string ('ignore' when left out). */
function tristate(o: Options, path: string, key: string): string {
  const v = o.get(key);
  if (v === undefined) return "ignore";
  if (v.kind === "boolean") return String(v.value);
  if (v.kind === "string" && v.value === "ignore") return "ignore";
  return o.error(`UiPolicy(): '${path}${key}' must be a boolean or 'ignore'.`, v);
}

/** A record option (`view`) given as a Record() call or a string. */
function recordOrString(o: Options, ctx: BuildContext, key: string): string | RecordId {
  const v = o.get(key);
  if (v?.kind === "call") return ctx.recordOf(v).id;
  return o.string(key) ?? "";
}

function script(o: Options, ctx: BuildContext, key: string, runScripts: boolean): CData | string {
  const value = o.string(key);
  if (value === undefined) return DEFAULT_SCRIPT;
  const loc = o.get(key)!.loc;
  if (usesModules(ctx.ts, value)) {
    ctx.report("error", "UI Policy scripts cannot import or require modules. Scripts run client-side in the browser.", loc);
  }
  // The SDK reports this as `info`, which the native compiler has no severity for.
  if (!runScripts && value !== DEFAULT_SCRIPT) ctx.report("hint", "This script will not execute unless runScripts is set to true", loc);
  return new CData(value);
}

/** A related list action's `list`: `REL:<sys_id>` for a relationship, `table.field` for a reference list. */
function relatedList(o: Options, ctx: BuildContext, index: number): string | undefined {
  const list = o.get("list");
  if (list === undefined) return "";
  if (list.kind === "call") return `REL:${ctx.recordOf(list).id.getValue()}`;
  const value = o.string("list")!;
  if (isGUID(value)) return `REL:${value}`;
  if (value.includes(".")) {
    const parts = value.split(".");
    if (parts.length === 2 && parts.every((part) => part !== "")) return value;
    ctx.report("error", `Related list action at index ${index}: 'list' property must be in 'table.field' format (e.g., 'incident.caller_id')`, list.loc);
    return undefined;
  }
  ctx.report(
    "error",
    `Related list action at index ${index}: 'list' property must be either a Record<'sys_relationship'>, a GUID, or in 'table.field' format (e.g., 'incident.caller_id')`,
    list.loc,
  );
  return undefined;
}

export const uiPolicy: ArtefactSpec = {
  properties: [
    "table",
    "shortDescription",
    "active",
    "global",
    "onLoad",
    "reverseIfFalse",
    "inherit",
    "conditions",
    "actions",
    "relatedListActions",
    "description",
    "modelId",
    "modelTable",
    "order",
    "runScripts",
    "scriptTrue",
    "scriptFalse",
    "uiType",
    "isolateScript",
    "setValues",
    "view",
  ],
  build(o, ctx) {
    const shortDescription = o.requiredString("shortDescription");
    if (shortDescription.trim() === "") {
      o.error("shortDescription cannot be empty or contain only whitespace", o.get("shortDescription"));
    }
    const table = o.string("table") ?? "";
    if (o.get("table") !== undefined) {
      const loc = o.get("table")!.loc;
      // ServiceNow and global scopes may target any table.
      if (ctx.scope.startsWith("x_") && !table.startsWith(`${ctx.scope}_`)) {
        ctx.report(
          "error",
          `'table' property should start with scope prefix '${ctx.scope}_'. UI Policies in scoped apps can only be created for tables within the same scope.`,
          loc,
        );
      }
      ctx.dictionary.refer("UiPolicy", table, loc);
    }
    const runScripts = o.boolean("runScripts") ?? false;
    const uiTypeName = o.string("uiType");
    const uiType = uiTypeName === undefined ? UI_TYPES.desktop : lookup(UI_TYPES, uiTypeName);
    if (uiType === undefined) {
      o.error(`UiPolicy(): 'uiType' must be one of ${Object.keys(UI_TYPES).join(", ")}.`, o.get("uiType"));
    }
    const policy = ctx.factory.createRecord({
      table: "sys_ui_policy",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        table,
        short_description: shortDescription,
        active: o.boolean("active") ?? true,
        global: o.boolean("global") ?? true,
        on_load: o.boolean("onLoad") ?? true,
        reverse_if_false: o.boolean("reverseIfFalse") ?? true,
        inherit: o.boolean("inherit") ?? false,
        isolate_script: o.boolean("isolateScript") ?? false,
        conditions: o.string("conditions") ?? "",
        run_scripts: runScripts,
        script_true: script(o, ctx, "scriptTrue", runScripts),
        script_false: script(o, ctx, "scriptFalse", runScripts),
        description: o.string("description") ?? "",
        model_id: o.string("modelId") ?? "",
        model_table: o.string("modelTable") ?? "",
        order: o.number("order") ?? 100,
        set_values: o.string("setValues") ?? "",
        ui_type: uiType,
        view: recordOrString(o, ctx, "view"),
      },
    });

    for (const [index, item] of (o.array("actions") ?? []).entries()) {
      const action = o.sub(item, `actions[${index}].`, ACTION_PROPERTIES);
      const field = action.requiredString("field");
      const fieldMessageType = action.string("fieldMessageType") ?? "none";
      if (!FIELD_MESSAGE_TYPES.includes(fieldMessageType)) {
        action.error(`UiPolicy(): 'actions[${index}].fieldMessageType' must be one of ${FIELD_MESSAGE_TYPES.join(", ")}.`, action.get("fieldMessageType"));
      }
      const visible = tristate(action, `actions[${index}].`, "visible");
      const readOnly = tristate(action, `actions[${index}].`, "readOnly");
      const mandatory = tristate(action, `actions[${index}].`, "mandatory");
      const cleared = action.boolean("cleared");
      if (["visible", "readOnly", "mandatory"].every((key) => action.get(key) === undefined) && cleared === undefined) {
        ctx.report(
          "hint",
          `Action at index ${index} has no effect — consider specifying at least one of: visible, readOnly, mandatory, or cleared`,
          item.loc,
        );
      }
      policy.children.push(
        ctx.factory.createRecord({
          table: "sys_ui_policy_action",
          source: item.loc,
          installCategory: o.installCategory,
          fields: {
            ui_policy: policy,
            table: action.string("table") || table,
            field,
            visible,
            disabled: readOnly,
            mandatory,
            cleared: cleared ?? false,
            field_message: action.string("fieldMessage") ?? "",
            field_message_type: fieldMessageType,
            value: action.string("value") ?? "",
            value_action: action.string("valueAction") ?? "ignore",
          },
        }),
      );
    }

    for (const [index, item] of (o.array("relatedListActions") ?? []).entries()) {
      const rlAction = o.sub(item, `relatedListActions[${index}].`, ["list", "visible"]);
      const list = relatedList(rlAction, ctx, index);
      if (list === undefined) continue;
      const visible = tristate(rlAction, `relatedListActions[${index}].`, "visible");
      if (rlAction.get("visible") === undefined && list === "") {
        ctx.report("hint", `Related list action at index ${index} has no effect — consider specifying at least one of: list or visible`, item.loc);
      }
      policy.children.push(
        ctx.factory.createRecord({
          table: "sys_ui_policy_rl_action",
          source: item.loc,
          installCategory: o.installCategory,
          fields: { list, ui_policy: policy, visible },
        }),
      );
    }
    return policy;
  },
};
