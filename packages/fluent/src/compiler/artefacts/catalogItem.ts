// SPDX-License-Identifier: GPL-3.0-or-later
//
// CatalogItem() → sc_cat_item, with its catalog, category, variable set, user
// criteria and topic M2M records, its pricing (fx_price) and its variables
// (item_option_new, question_choice, fx_price) as children.

import type { FluentCall, FluentValue } from "../evaluate";
import type { CompiledRecord, FieldValue } from "../record";
import { formatDuration } from "../time";
import { lookup, roleNames, type ArtefactSpec, type BuildContext, type Options } from "./shared";
import { buildVariables, cdata, pricingRecords, setVariables, VARIABLE_TYPES, variableEntries } from "./variables";

const AVAILABILITY: Record<string, string> = { desktopOnly: "on_desktop", mobileOnly: "on_mobile", both: "on_both" };
const MOBILE_PICTURE_TYPES: Record<string, string> = {
  desktopPicture: "use_desktop_picture",
  mobilePicture: "use_mobile_picture",
  noPicture: "use_no_picture",
};
const AUTOMATION_LEVELS: Record<string, string> = {
  unspecified: "unspecified",
  manual: "manual",
  semiAutomated: "semi_automated",
  fullyAutomated: "fully_automated",
};
/** The content type of a topic connected to a catalog item. */
const CATALOG_ITEM_CONTENT_TYPE = "98f9a16553622010069addeeff7b1248";

/** The options CatalogItem() and CatalogItemRecordProducer() share. */
export const CATALOG_BASE_PROPERTIES = [
  "name",
  "active",
  "accessType",
  "availability",
  "categories",
  "catalogs",
  "checkedOut",
  "description",
  "icon",
  "image",
  "mandatoryAttachment",
  "hideAttachment",
  "meta",
  "mobilePicture",
  "mobilePictureType",
  "model",
  "hideSaveAsDraft",
  "order",
  "owner",
  "picture",
  "roles",
  "shortDescription",
  "showVariableHelpOnLoad",
  "startClosed",
  "state",
  "assignedTopics",
  "useScLayout",
  "version",
  "view",
  "visibleBundle",
  "visibleGuide",
  "visibleStandalone",
  "hideAddToCart",
  "hideAddToWishList",
  "hideDeliveryTime",
  "hideQuantitySelector",
  "hideSP",
  "makeItemNonConversational",
  "noSearch",
  "availableFor",
  "notAvailableFor",
  "variableSets",
  "variables",
];

/** A reference field: a sys_id string, or the record of another API call. */
function reference(o: Options, ctx: BuildContext, key: string): string | CompiledRecord {
  const value = o.get(key);
  if (value === undefined) return "";
  return element(o, ctx, value, key);
}

/** One element of a reference list: a sys_id string, or the record of another API call. */
export function element(o: Options, ctx: BuildContext, value: FluentValue, key: string): string | CompiledRecord {
  if (value.kind === "string") return value.value;
  if (value.kind === "call") return ctx.recordOf(value);
  return o.error(`${o.call.api}(): '${key}' must hold sys_ids or records.`, value);
}

function references(o: Options, ctx: BuildContext, key: string): (string | CompiledRecord)[] {
  return (o.array(key) ?? []).map((item) => element(o, ctx, item, key));
}

/** The sys_id a reference list stores: a string as given, a record by its id. */
function idOf(ref: string | CompiledRecord): string {
  return typeof ref === "string" ? ref : ref.id.getValue();
}

/** The first element of a reference list, as the single reference field mirroring it. */
function first(refs: (string | CompiledRecord)[]): string {
  return refs.length === 0 ? "" : idOf(refs[0]);
}

/** A field whose option takes one of `map`'s keys; anything else is `fallback`. */
function mapped(o: Options, key: string, map: Record<string, string>, fallback: string): string {
  const value = o.get(key);
  return (value?.kind === "string" ? lookup(map, value.value) : undefined) ?? fallback;
}

/** A script field: the text as CDATA (a module function is not supported natively). */
function script(o: Options, key: string): FieldValue {
  const value = o.get(key);
  if (value !== undefined && value.kind !== "string") o.error(`${o.call.api}(): '${key}' must be a string.`, value);
  return cdata(value?.value);
}

/** An attached variable set: a sys_id kept as given, or a VariableSet() record. */
export interface AttachedSet {
  set: string | CompiledRecord;
  order: number;
}

export function attachedSets(o: Options, ctx: BuildContext): AttachedSet[] {
  return (o.array("variableSets") ?? []).map((item, i) => {
    const entry = o.sub(item, `variableSets[${i}].`, ["variableSet", "order"]);
    const value = entry.get("variableSet");
    if (value === undefined) o.error(`${o.call.api}(): 'variableSets[${i}].variableSet' is required.`, item);
    const set = element(o, ctx, value, `variableSets[${i}].variableSet`);
    if (typeof set !== "string" && set.table !== "item_option_new_set") {
      o.error(`${o.call.api}(): 'variableSets[${i}].variableSet' must be a sys_id or a VariableSet().`, value);
    }
    const order = entry.get("order");
    if (order === undefined || (order.kind === "string" && order.value === "")) return { set, order: 100 };
    return { set, order: entry.number("order")! };
  });
}

/** The SDK's checks that run before a catalog item is built; `context` names the API in messages. */
export function validateCatalogItem(
  o: Options,
  ctx: BuildContext,
  entries: [string, FluentCall][],
  sets: AttachedSet[],
  context: string,
): void {
  const fulfillment = ["executionPlan", "flow", "workflow"].filter((key) => {
    const value = o.get(key);
    return value !== undefined && (value.kind === "call" || (value.kind === "string" && value.value !== ""));
  });
  if (fulfillment.length > 1) {
    ctx.report(
      "error",
      `Only one of executionPlan, flow, or workflow can be specified. Found: ${fulfillment.join(", ")}. Remove the extra fields so that only one fulfillment method is configured.`,
      o.object.loc,
    );
  }
  if ((o.array("categories") ?? []).length > 0 && (o.array("catalogs") ?? []).length === 0) {
    ctx.report(
      "error",
      "'categories' requires 'catalogs' to also be specified. Categories can only be selected after the Catalogs field is populated.",
      o.get("categories")!.loc,
    );
  }

  const variables = o.get("variables");
  const direct = entries.filter(([, call]) => call.api === "RequestedForVariable").length;
  if (direct > 1) o.error(`Only one RequestedForVariable is allowed in a ${context}`, variables);
  const setRecords = sets.flatMap(({ set }) => (typeof set === "string" ? [] : [setVariables(set)]));
  const inSets = setRecords.flat().filter((r) => r.fields.get("type") === VARIABLE_TYPES.RequestedForVariable).length;
  if (inSets > 0 && direct > 0) {
    o.error(
      `RequestedForVariable cannot be used in both ${context} variables and attached VariableSets. Remove RequestedForVariable from either the ${context} variables or the attached VariableSet.`,
      variables,
    );
  }
  if (inSets > 1) {
    o.error(
      `RequestedForVariable cannot be used in multiple VariableSets attached to the same ${context}. Only one RequestedForVariable is allowed across all VariableSets.`,
      o.get("variableSets"),
    );
  }

  const setNames = new Set(setRecords.flat().map((r) => r.fields.get("name")));
  const conflict = entries.find(([name]) => setNames.has(name));
  if (conflict) {
    o.error(
      `Variable name conflict: '${conflict[0]}' is defined in both ${context} variables and an attached VariableSet. Each variable must have a unique name across the ${context} and all attached VariableSets.`,
      variables,
    );
  }
}

/** The sc_cat_item fields CatalogItem() and CatalogItemRecordProducer() share. */
export function catalogBaseFields(o: Options, ctx: BuildContext): Record<string, FieldValue | CompiledRecord> {
  const bool = (key: string, fallback: boolean) => o.boolean(key) ?? fallback;
  return {
    name: o.string("name"),
    active: bool("active", true),
    access_type: o.string("accessType") ?? "restricted",
    availability: mapped(o, "availability", AVAILABILITY, "on_desktop"),
    category: first(references(o, ctx, "categories")),
    checked_out: o.boolean("checkedOut"),
    description: cdata(o.string("description") ?? ""),
    icon: o.string("icon") ?? "",
    mandatory_attachment: bool("mandatoryAttachment", false),
    meta: (o.stringArray("meta") ?? []).join(","),
    mobile_picture: o.string("mobilePicture") ?? "",
    no_attachment_v2: bool("hideAttachment", false),
    no_save_as_draft: bool("hideSaveAsDraft", false),
    order: o.number("order") ?? 0,
    owner: reference(o, ctx, "owner"),
    picture: o.string("picture") ?? "",
    roles: roleNames(o, ctx, o.array("roles") ?? [], "roles"),
    sc_catalogs: references(o, ctx, "catalogs").map(idOf).join(","),
    short_description: o.string("shortDescription") ?? "",
    show_variable_help_on_load: bool("showVariableHelpOnLoad", false),
    state: o.string("state") ?? "",
    start_closed: bool("startClosed", false),
    taxonomy_topic: first(references(o, ctx, "assignedTopics")),
    type: "item",
    use_sc_layout: bool("useScLayout", true),
    version: o.number("version") ?? 1,
    view: reference(o, ctx, "view"),
    visible_bundle: bool("visibleBundle", true),
    visible_guide: bool("visibleGuide", true),
    visible_standalone: bool("visibleStandalone", true),
    no_cart_v2: bool("hideAddToCart", false),
    no_wishlist_v2: bool("hideAddToWishList", false),
    no_delivery_time_v2: bool("hideDeliveryTime", false),
    no_quantity_v2: bool("hideQuantitySelector", false),
    hide_sp: bool("hideSP", false),
    image: o.string("image") ?? "",
    model: reference(o, ctx, "model"),
    mobile_picture_type: mapped(o, "mobilePictureType", MOBILE_PICTURE_TYPES, "use_desktop_picture"),
    make_item_non_conversational: bool("makeItemNonConversational", false),
    no_search: bool("noSearch", false),
  };
}

/** The M2M records of a catalog item, in the SDK's order. */
export function catalogM2MRecords(o: Options, ctx: BuildContext, item: CompiledRecord, sets: AttachedSet[]): CompiledRecord[] {
  const create = (table: string, fields: Record<string, FieldValue | CompiledRecord>) =>
    ctx.factory.createRecord({ table, source: o.call.loc, installCategory: o.installCategory, fields });
  return [
    ...references(o, ctx, "catalogs").map((c) => create("sc_cat_item_catalog", { sc_cat_item: item, sc_catalog: c })),
    ...references(o, ctx, "categories").map((c) => create("sc_cat_item_category", { sc_cat_item: item, sc_category: c })),
    ...sets.map(({ set, order }) => create("io_set_item", { sc_cat_item: item, variable_set: set, order })),
    ...references(o, ctx, "availableFor").map((c) => create("sc_cat_item_user_criteria_mtom", { sc_cat_item: item, user_criteria: c })),
    ...references(o, ctx, "notAvailableFor").map((c) =>
      create("sc_cat_item_user_criteria_no_mtom", { sc_cat_item: item, user_criteria: c }),
    ),
    ...references(o, ctx, "assignedTopics").map((topic) =>
      create("m2m_connected_content", {
        content_type: CATALOG_ITEM_CONTENT_TYPE,
        catalog_item: item,
        topic,
        source: "user",
        order: "100",
      }),
    ),
  ];
}

export const catalogItem: ArtefactSpec = {
  properties: [
    ...CATALOG_BASE_PROPERTIES,
    "billable",
    "cost",
    "ignorePrice",
    "omitPrice",
    "mobileHidePrice",
    "pricingDetails",
    "recurringFrequency",
    "displayPriceProperty",
    "executionPlan",
    "flow",
    "fulfillmentAutomationLevel",
    "fulfillmentGroup",
    "workflow",
    "deliveryTime",
    "deliveryPlanScript",
    "entitlementScript",
    "requestMethod",
    "customCart",
    "noCart",
    "noOrder",
    "noOrderNow",
    "noProceedCheckout",
    "noQuantity",
    "vendor",
    "location",
  ],
  build(o, ctx) {
    const entries = variableEntries(o) ?? [];
    const sets = attachedSets(o, ctx);
    validateCatalogItem(o, ctx, entries, sets, "CatalogItem");

    const delivery = o.nested("deliveryTime", ["days", "hours", "minutes", "seconds"]);
    const requestMethod = o.string("requestMethod");
    const record = ctx.factory.createRecord({
      table: "sc_cat_item",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        ...catalogBaseFields(o, ctx),
        billable: o.boolean("billable") ?? false,
        cost: o.number("cost") ?? 0,
        ignore_price: o.boolean("ignorePrice") ?? true,
        omit_price: o.boolean("omitPrice") ?? false,
        mobile_hide_price: o.boolean("mobileHidePrice") ?? false,
        delivery_plan: reference(o, ctx, "executionPlan"),
        flow_designer_flow: reference(o, ctx, "flow"),
        fulfillment_automation_level: mapped(o, "fulfillmentAutomationLevel", AUTOMATION_LEVELS, "unspecified"),
        group: reference(o, ctx, "fulfillmentGroup"),
        workflow: reference(o, ctx, "workflow"),
        delivery_time: formatDuration({
          days: delivery?.number("days"),
          hours: delivery?.number("hours"),
          minutes: delivery?.number("minutes"),
          seconds: delivery?.number("seconds"),
        }),
        delivery_plan_script: script(o, "deliveryPlanScript"),
        display_price_property: o.string("displayPriceProperty") ?? "non_zero",
        entitlement_script: script(o, "entitlementScript"),
        request_method: requestMethod === undefined || requestMethod === "order" ? "" : requestMethod,
        custom_cart: reference(o, ctx, "customCart"),
        recurring_frequency: o.string("recurringFrequency") ?? "",
        no_cart: o.boolean("noCart") ?? false,
        no_order: o.boolean("noOrder") ?? false,
        no_order_now: o.boolean("noOrderNow") ?? false,
        no_proceed_checkout: o.boolean("noProceedCheckout") ?? false,
        no_quantity: o.boolean("noQuantity") ?? false,
        vendor: reference(o, ctx, "vendor"),
        location: reference(o, ctx, "location"),
      },
    });
    record.children.push(
      ...catalogM2MRecords(o, ctx, record, sets),
      ...pricingRecords(o, ctx, o.array("pricingDetails") ?? [], "pricingDetails", record, o.installCategory),
      ...buildVariables(o, ctx, entries, { kind: "item", record, variableSets: sets.map(({ set }) => set) }),
    );
    return record;
  },
};
