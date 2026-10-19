// SPDX-License-Identifier: GPL-3.0-or-later
//
// CatalogClientScript() → catalog_script_client: a client script on a catalog
// item or variable set; an onChange script names the variable it watches.

import { CData, type FieldValue } from "../record";
import { appliesTo, target, uiType, validateTargets, variableName } from "./catalogTargets";
import type { ArtefactSpec } from "./shared";

export const catalogClientScript: ArtefactSpec = {
  properties: [
    "name",
    "script",
    "type",
    "variableName",
    "uiType",
    "active",
    "global",
    "appliesOnCatalogItemView",
    "appliesOnRequestedItems",
    "appliesOnCatalogTasks",
    "appliesOnTargetRecord",
    "vaSupported",
    "publishedRef",
    "isolateScript",
    "order",
    "catalogItem",
    "appliesTo",
    "variableSet",
  ],
  build(o, ctx) {
    validateTargets(o, ctx, "CatalogClientScript");
    const type = o.string("type");
    // Only an onChange script watches a variable; the SDK ignores `variableName` otherwise.
    const variable = type === "onChange" ? variableName(o, ctx, o, appliesTo(o)) : undefined;
    const order = o.number("order");
    const fields: Record<string, FieldValue> = {
      name: o.requiredString("name"),
      active: o.boolean("active") ?? true,
      global: o.boolean("global") ?? true,
      script: new CData(o.requiredString("script")),
      type: type ?? "",
      applies_to: o.string("appliesTo") ?? "item",
    };
    return ctx.factory.createRecord({
      table: "catalog_script_client",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        ...fields,
        cat_item: target(o, ctx, "catalogItem"),
        variable_set: target(o, ctx, "variableSet"),
        cat_variable: variable?.id ?? "",
        applies_catalog: o.boolean("appliesOnCatalogItemView") ?? true,
        applies_req_item: o.boolean("appliesOnRequestedItems") ?? false,
        applies_sc_task: o.boolean("appliesOnCatalogTasks") ?? false,
        applies_target_record: o.boolean("appliesOnTargetRecord") ?? false,
        isolate_script: o.boolean("isolateScript") ?? true,
        // The SDK writes `order` only when it is a number.
        ...(order === undefined ? {} : { order }),
        ui_type: uiType(o, "uiType"),
        va_supported: o.boolean("vaSupported") ?? false,
        published_ref: o.string("publishedRef") ?? "",
      },
    });
  },
};
