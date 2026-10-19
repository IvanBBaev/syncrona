// SPDX-License-Identifier: GPL-3.0-or-later
//
// What CatalogUiPolicy() and CatalogClientScript() share: the catalog item or
// variable set they apply to, and the variables they name, written as `IO:`
// references the way the SDK's service catalog plugins write them.

import type { FluentValue } from "../evaluate";
import type { CompiledRecord } from "../record";
import { element } from "./catalogItem";
import { lookup, type BuildContext, type Options } from "./shared";
import { flat } from "./variables";

export type AppliesTo = "item" | "set";

const UI_TYPES: Record<string, number> = { desktop: 0, mobileOrServicePortal: 1, all: 10 };

/** `appliesTo`: 'set' targets the variable set, anything else the catalog item. */
export function appliesTo(o: Options): AppliesTo {
  const value = o.get("appliesTo");
  return value?.kind === "string" && value.value === "set" ? "set" : "item";
}

/** `catalogItem` / `variableSet`: a sys_id, a record, or '' when left out. */
export function target(o: Options, ctx: BuildContext, key: "catalogItem" | "variableSet"): string | CompiledRecord {
  const value = o.get(key);
  return value === undefined ? "" : element(o, ctx, value, key);
}

/** A `uiType` option: the SDK's number for a known name, 10 ('all') otherwise. */
export function uiType(o: Options, key: string): number {
  const value = o.string(key);
  return (value ? lookup(UI_TYPES, value) : undefined) ?? 10;
}

function present(value: FluentValue | undefined): boolean {
  return value !== undefined && !(value.kind === "string" && value.value === "");
}

/** The SDK's check that only the target `appliesTo` names is given; reports the first problem. */
export function validateTargets(o: Options, ctx: BuildContext, context: string): void {
  const item = o.get("catalogItem");
  const set = o.get("variableSet");
  if (present(item) && present(set)) {
    ctx.report(
      "error",
      `${context}: 'catalogItem' and 'variableSet' are mutually exclusive. Specify only one. When appliesTo is 'set', use variableSet; when 'item', use catalogItem.`,
      o.call.loc,
    );
    return;
  }
  const applies = o.get("appliesTo");
  const value = applies?.kind === "string" ? applies.value : undefined;
  if (value === "set" && present(item)) {
    ctx.report("error", `${context}: 'catalogItem' should not be specified when appliesTo is 'set'. Use 'variableSet' instead.`, item!.loc);
  } else if (value === "item" && present(set)) {
    ctx.report("error", `${context}: 'variableSet' should not be specified when appliesTo is 'item'. Use 'catalogItem' instead.`, set!.loc);
  }
}

/**
 * `item.variables.name` as `IO:<sys_id>` of the variable that `item` defines
 * (`IO:<name>` when it defines none), checked against the target `applies`
 * names when that target is a `const` bound record, as the SDK checks it.
 */
export function variableReference(
  o: Options,
  ctx: BuildContext,
  ref: Extract<FluentValue, { kind: "variable" }>,
  applies: AppliesTo,
): string {
  const parent = ctx.recordOf(ref.owner);
  const variable = flat(parent).find((r) => r.table === "item_option_new" && r.fields.get("name") === ref.name);
  const targetValue = o.get(applies === "set" ? "variableSet" : "catalogItem");
  if (targetValue?.kind === "call" && targetValue.binding) {
    const targetRecord = ctx.recordOf(targetValue);
    const id = targetRecord.id.getValue();
    if (parent.id.getValue() !== id) {
      // The SDK accepts a foreign variable on an item that attaches any variable set.
      if (applies === "set") ctx.report("error", "Variable is not in the variable set", targetValue.loc);
      else if (!flat(targetRecord).some((r) => r.table === "io_set_item")) {
        ctx.report("error", "Variable is not in the catalog item", targetValue.loc);
      }
    }
  }
  return `IO:${variable ? variable.id.getValue() : ref.name}`;
}

/** A `variableName` option: its `IO:` reference and the plain name, or undefined when left out. */
export function variableName(
  top: Options,
  ctx: BuildContext,
  o: Options,
  applies: AppliesTo,
): { id: string; name: string } | undefined {
  const value = o.get("variableName");
  if (value === undefined) return undefined;
  if (value.kind === "variable") return { id: variableReference(top, ctx, value, applies), name: value.name };
  if (value.kind === "string") return { id: `IO:${value.value}`, name: value.value };
  return o.error(`${o.call.api}(): '${o.path}variableName' must be a variable name or a variable reference.`, value);
}
