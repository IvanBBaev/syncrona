// SPDX-License-Identifier: GPL-3.0-or-later
//
// CatalogUiPolicy() → catalog_ui_policy, plus a catalog_ui_policy_action row
// per action. Variables are named by `item.variables.name` references or by
// name, and the catalog condition may interpolate such references.

import { CData, type FieldValue } from "../record";
import {
  appliesTo,
  target,
  uiType,
  validateTargets,
  variableName,
  variableReference,
  type AppliesTo,
} from "./catalogTargets";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const DEFAULT_SCRIPT = "function onCondition() {\n\n}";
const VALUE_ACTIONS: Record<string, string> = { clearValue: "clear_value", setValue: "set_value" };
const ACTION_PROPERTIES = [
  "variableName",
  "variable",
  "visible",
  "mandatory",
  "readOnly",
  "cleared",
  "value",
  "valueAction",
  "order",
  "variableMessageType",
  "variableMessage",
];

function script(o: Options, key: string): FieldValue {
  const value = o.string(key);
  return value === undefined ? DEFAULT_SCRIPT : new CData(value);
}

/**
 * `catalogCondition`: a template literal's text with each interpolated
 * variable as its `IO:` reference, or an encoded query the SDK prefixes with
 * `IO:` term by term and ends with `^EQ`.
 */
function catalogCondition(o: Options, ctx: BuildContext, applies: AppliesTo): string {
  const value = o.get("catalogCondition");
  if (value === undefined) return "";
  if (value.kind === "template") {
    let result = value.head;
    for (const span of value.spans) {
      const part = span.value;
      if (part.kind === "variable") result += variableReference(o, ctx, part, applies);
      else if (part.kind === "string" || part.kind === "number" || part.kind === "boolean") result += String(part.value);
      else o.error("CatalogUiPolicy(): 'catalogCondition' can only interpolate variables, strings, numbers and booleans.", part);
      result += span.text;
    }
    return result;
  }
  const condition = o.string("catalogCondition");
  if (!condition) return "";
  return condition
    .replace(/^(?!IO:)/, "IO:")
    .replace(/\^OR(?!IO:)/g, "^ORIO:")
    .replace(/\^NQ(?!IO:)/g, "^NQIO:")
    .replace(/\^(?!(ORIO:|NQIO:|EQ))/g, "^IO:")
    .replace(/(?<!\^EQ)$/, "^EQ");
}

/** The SDK's check that an action's message and message type come together. */
function validateMessage(action: Options, ctx: BuildContext): void {
  const type = action.get("variableMessageType");
  const message = action.get("variableMessage");
  const present = (v: typeof type) => v !== undefined && !(v.kind === "string" && v.value === "");
  if (present(type) && !present(message)) {
    ctx.report(
      "error",
      "'variableMessage' is required when 'variableMessageType' is specified. Provide a message to display on the field.",
      type!.loc,
    );
  } else if (present(message) && !present(type)) {
    ctx.report(
      "error",
      "'variableMessageType' is required when 'variableMessage' is specified. Provide a message type (info, warning, or error).",
      message!.loc,
    );
  }
}

export const catalogUiPolicy: ArtefactSpec = {
  properties: [
    "shortDescription",
    "active",
    "global",
    "onLoad",
    "runScripts",
    "reverseIfFalse",
    "isolateScript",
    "catalogCondition",
    "appliesOnCatalogItemView",
    "appliesOnTargetRecord",
    "appliesOnCatalogTasks",
    "appliesOnRequestedItems",
    "executeIfTrue",
    "executeIfFalse",
    "description",
    "order",
    "runScriptsInUiType",
    "vaSupported",
    "actions",
    "catalogItem",
    "appliesTo",
    "variableSet",
  ],
  build(o, ctx) {
    validateTargets(o, ctx, "CatalogUiPolicy");
    const applies = appliesTo(o);
    const conditions = catalogCondition(o, ctx, applies);
    const catalogItem = target(o, ctx, "catalogItem");
    const variableSet = target(o, ctx, "variableSet");
    const policy = ctx.factory.createRecord({
      table: "catalog_ui_policy",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        catalog_item: catalogItem,
        variable_set: variableSet,
        applies_to: o.string("appliesTo") ?? "item",
        short_description: o.requiredString("shortDescription"),
        active: o.boolean("active") ?? true,
        global: o.boolean("global") ?? true,
        on_load: o.boolean("onLoad") ?? true,
        reverse_if_false: o.boolean("reverseIfFalse") ?? true,
        inherit: false,
        isolate_script: o.boolean("isolateScript") ?? true,
        conditions: "",
        catalog_conditions: conditions,
        applies_catalog: o.boolean("appliesOnCatalogItemView") ?? true,
        applies_target_record: o.boolean("appliesOnTargetRecord") ?? false,
        applies_sc_task: o.boolean("appliesOnCatalogTasks") ?? false,
        applies_req_item: o.boolean("appliesOnRequestedItems") ?? false,
        run_scripts: o.boolean("runScripts") ?? false,
        script_true: script(o, "executeIfTrue"),
        script_false: script(o, "executeIfFalse"),
        description: o.string("description") ?? "",
        model_id: "",
        model_table: "",
        order: o.number("order") ?? 100,
        set_values: "",
        published_ref: "",
        ui_type: uiType(o, "runScriptsInUiType"),
        table: "",
        va_supported: o.boolean("vaSupported") ?? true,
        view: "",
      },
    });

    const names = new Set<string>();
    for (const [index, item] of (o.array("actions") ?? []).entries()) {
      const action = o.sub(item, `actions[${index}].`, ACTION_PROPERTIES);
      validateMessage(action, ctx);
      const variable = variableName(o, ctx, action, applies);
      if (variable) {
        if (names.has(variable.name)) {
          ctx.report(
            "error",
            `Duplicate variableName '${variable.name}' found in actions. Each action must have a unique variableName.`,
            action.get("variableName")!.loc,
          );
        }
        names.add(variable.name);
      }
      const valueAction = action.string("valueAction");
      policy.children.push(
        ctx.factory.createRecord({
          table: "catalog_ui_policy_action",
          source: item.loc,
          installCategory: o.installCategory,
          fields: {
            ui_policy: policy,
            catalog_item: catalogItem,
            variable_set: variableSet,
            catalog_variable: variable?.id ?? "",
            variable: action.string("variable") ?? variable?.name ?? "",
            visible: action.boolean("visible") ?? "ignore",
            disabled: action.boolean("readOnly") ?? "ignore",
            mandatory: action.boolean("mandatory") ?? "ignore",
            order: action.number("order") ?? 100,
            cleared: action.boolean("cleared") ?? false,
            field_message: action.string("variableMessage") ?? "",
            field_message_type: action.string("variableMessageType") ?? "none",
            value: action.string("value") ?? "",
            value_action: (valueAction === undefined ? undefined : lookup(VALUE_ACTIONS, valueAction)) ?? "ignore",
          },
        }),
      );
    }
    return policy;
  },
};
