// SPDX-License-Identifier: GPL-3.0-or-later
//
// Catalog variables (`SingleLineTextVariable()` and the other `*Variable()`
// APIs) → item_option_new, with question_choice rows for the choices of a
// select box or multiple choice and fx_price rows for pricing details. A
// variable compiles only inside the `variables` of its VariableSet,
// CatalogItem or RecordProducer, as the SDK's `buildVariableRecords` does.

import { isGUID } from "../keys";
import type { FluentCall, FluentObject, FluentValue } from "../evaluate";
import type { CompiledRecord, FieldValue, RecordId } from "../record";
import { CData } from "../record";
import { lookup, Options, roleNames, type BuildContext } from "./shared";

/** Variable API → item_option_new `type`. */
export const VARIABLE_TYPES: Record<string, string> = {
  YesNoVariable: "1",
  MultiLineTextVariable: "2",
  MultipleChoiceVariable: "3",
  NumericScaleVariable: "4",
  SelectBoxVariable: "5",
  SingleLineTextVariable: "6",
  CheckboxVariable: "7",
  ReferenceVariable: "8",
  DateVariable: "9",
  DateTimeVariable: "10",
  LabelVariable: "11",
  BreakVariable: "12",
  CustomVariable: "14",
  UIPageVariable: "15",
  WideSingleLineTextVariable: "16",
  CustomWithLabelVariable: "17",
  LookupSelectBoxVariable: "18",
  ContainerStartVariable: "19",
  ContainerEndVariable: "20",
  ListCollectorVariable: "21",
  LookupMultipleChoiceVariable: "22",
  HtmlVariable: "23",
  ContainerSplitVariable: "24",
  MaskedVariable: "25",
  EmailVariable: "26",
  UrlVariable: "27",
  IpAddressVariable: "28",
  DurationVariable: "29",
  RequestedForVariable: "31",
  RichTextLabelVariable: "32",
  AttachmentVariable: "33",
};

export const VARIABLE_APIS: readonly string[] = Object.keys(VARIABLE_TYPES);

/** Every option any variable API declares; the SDK maps them all onto one item_option_new shape. */
const VARIABLE_PROPERTIES = [
  "question",
  "order",
  "active",
  "disableInitialSlotFill",
  "conversationalLabel",
  "tooltip",
  "exampleText",
  "showHelp",
  "helpTag",
  "helpText",
  "instructions",
  "width",
  "attributes",
  "readRoles",
  "writeRoles",
  "createRoles",
  "deleteRoles",
  "defaultValue",
  "visibleBundle",
  "visibleGuide",
  "visibleStandalone",
  "visibleSummary",
  "removeFromConversationalInterfaces",
  "pricingDetails",
  "alwaysExpand",
  "description",
  "global",
  "layout",
  "deliveryPlan",
  "visibility",
  "category",
  "pricingImplications",
  "useDynamicDefault",
  "unique",
  "dotWalkPath",
  "dependentQuestion",
  "readScript",
  "postInsertScript",
  "mapToField",
  "field",
  "mandatory",
  "readOnly",
  "hidden",
  "selectionRequired",
  "displayTitle",
  "choiceDirection",
  "choiceField",
  "choiceTable",
  "choices",
  "choicesDependOn",
  "defaultHTML",
  "doNotSelectFirstChoice",
  "dynamicRefQual",
  "enableAlsoRequestFor",
  "includeNone",
  "listTable",
  "lookupFromTable",
  "lookupLabelFields",
  "lookupPriceField",
  "lookupRecurringPriceField",
  "lookupSource",
  "lookupValueField",
  "macro",
  "macroponent",
  "summaryMacro",
  "topicBlock",
  "uiPage",
  "widget",
  "referenceQual",
  "referenceQualCondition",
  "referenceTable",
  "richText",
  "rolesToUseAlsoRequestFor",
  "scaleMax",
  "scaleMin",
  "uniqueValuesOnly",
  "useConfirmation",
  "useEncryption",
  "useReferenceQualifier",
  "validateRegex",
];
const PRICING_DETAIL = ["amount", "currencyType", "field"];
const CHOICE = ["label", "sequence", "hint", "inactive", "language", "synonyms", "dependentValue", "inactiveOnUpdate", "pricingDetails"];

/** Variables without the base options: no mapToField or mandatory checks. */
const MINIMAL = ["BreakVariable", "ContainerEndVariable", "ContainerSplitVariable"];
/** Variables that cannot be mandatory. */
const NOT_INTERACTIVE = [
  ...MINIMAL,
  "ContainerStartVariable",
  "LabelVariable",
  "RichTextLabelVariable",
  "CustomVariable",
  "CustomWithLabelVariable",
  "UIPageVariable",
];
/** Variable types a multi-row variable set cannot hold. */
const NOT_MULTI_ROW = [
  "AttachmentVariable",
  "BreakVariable",
  "ContainerEndVariable",
  "ContainerStartVariable",
  "ContainerSplitVariable",
  "HtmlVariable",
  "LabelVariable",
  "CustomVariable",
  "CustomWithLabelVariable",
  "RichTextLabelVariable",
  "UIPageVariable",
];
/** Variable types a dependentQuestion can point at. */
const DEPENDENT_QUESTION_PARENTS = ["ReferenceVariable", "RequestedForVariable"];
const VISIBILITY: Record<string, number> = { Always: 1, Bundle: 2, Standalone: 3 };

/** The `variables` object of `o`, its entries checked to be variable calls. */
export function variableEntries(o: Options): [string, FluentCall][] | undefined {
  const value = o.get("variables");
  if (value === undefined) return undefined;
  if (value.kind !== "object") o.error(`${o.call.api}(): 'variables' must be an object.`, value);
  return [...value.props].map(([name, v]) => {
    if (v.kind !== "call" || !VARIABLE_APIS.includes(v.api)) {
      o.error(`${o.call.api}(): 'variables.${name}' must be a variable such as SingleLineTextVariable().`, v);
    }
    return [name, v];
  });
}

/** VariableSet's checks of its variables: one RequestedForVariable at most, and the multi-row restrictions. */
export function validateSetVariables(o: Options, entries: [string, FluentCall][], multiRow: boolean): void {
  let requestedFor = 0;
  for (const [name, call] of entries) {
    if (call.api === "RequestedForVariable" && ++requestedFor > 1) {
      o.error(`Only one RequestedForVariable is allowed in a ${o.call.api}`, o.get("variables"));
    }
    if (multiRow && NOT_MULTI_ROW.includes(call.api)) {
      o.error(`Variable type '${call.api}' is not supported in multiRow variable sets. Variable '${name}' cannot be used.`, call);
    }
  }
}

/** Whether `value` is set to something other than an empty string. */
function present(value: FluentValue | undefined): boolean {
  return value !== undefined && !(value.kind === "string" && value.value === "");
}

function isTrue(value: FluentValue | undefined): boolean {
  return value?.kind === "boolean" && value.value;
}

function validate(v: Options, ctx: BuildContext, api: string): void {
  const error = (message: string, value: FluentValue | undefined) =>
    ctx.report("error", message, (value ?? v.object).loc);
  if (!MINIMAL.includes(api) && isTrue(v.get("mapToField")) && !present(v.get("field"))) {
    error(`'field' is required when 'mapToField' is true. Specify the field to map to.`, v.get("mapToField"));
  }
  if (api === "CheckboxVariable") {
    const required = v.get("selectionRequired");
    if (isTrue(required) && isTrue(v.get("readOnly"))) {
      error(`'selectionRequired' cannot be true when 'readOnly' is true. A checkbox cannot be both required and read-only.`, required);
    } else if (isTrue(required) && isTrue(v.get("hidden"))) {
      error(`'selectionRequired' cannot be true when 'hidden' is true. A checkbox cannot be both required and hidden.`, required);
    }
  } else if (!NOT_INTERACTIVE.includes(api)) {
    const mandatory = v.get("mandatory");
    if (isTrue(mandatory) && isTrue(v.get("readOnly"))) {
      error(`'mandatory' cannot be true when 'readOnly' is true. A field cannot be both required and read-only.`, mandatory);
    } else if (isTrue(mandatory) && isTrue(v.get("hidden"))) {
      error(`'mandatory' cannot be true when 'hidden' is true. A field cannot be both required and hidden.`, mandatory);
    }
  }
  if (api === "LookupSelectBoxVariable" || api === "LookupMultipleChoiceVariable") validateLookup(v, error);
  if (api === "ReferenceVariable" || api === "RequestedForVariable") validateQualifier(v, error, api);
}

type Report = (message: string, value: FluentValue | undefined) => void;

function validateLookup(v: Options, error: Report): void {
  const source = v.get("lookupSource");
  const fromTable = v.get("lookupFromTable");
  const valueField = v.get("lookupValueField");
  if (source?.kind === "string" && source.value === "choices") {
    if (present(fromTable)) error(`'lookupFromTable' should not be specified when 'lookupSource' is 'choices'.`, fromTable);
    else if (present(valueField)) error(`'lookupValueField' should not be specified when 'lookupSource' is 'choices'.`, valueField);
  } else if (!present(fromTable)) {
    error(`'lookupFromTable' is required when 'lookupSource' is not 'choices'.`, source);
  } else if (!present(valueField)) {
    error(`'lookupValueField' is required when 'lookupSource' is not 'choices'.`, source);
  }
}

function validateQualifier(v: Options, error: Report, api: string): void {
  const use = v.get("useReferenceQualifier");
  const mode = use?.kind === "string" ? use.value : undefined;
  if ((mode === "simple" || mode === "") && !present(v.get("referenceQualCondition"))) {
    error(`${api}: 'referenceQualCondition' is required when 'useReferenceQualifier' is 'simple'.`, use);
  } else if (mode === "dynamic" && !present(v.get("dynamicRefQual"))) {
    error(`${api}: 'dynamicRefQual' is required when 'useReferenceQualifier' is 'dynamic'.`, use);
  } else if (mode === "advanced" && !present(v.get("referenceQual"))) {
    error(`${api}: 'referenceQual' is required when 'useReferenceQualifier' is 'advanced'.`, use);
  }
}

/** A string, number or boolean option, or a record's sys_id (`defaultValue: Record({...})`). */
function scalarOrRecord(v: Options, ctx: BuildContext, key: string): FieldValue {
  const value = v.get(key);
  if (value?.kind === "call") return ctx.recordOf(value).id.getValue();
  return v.scalar(key) ?? "";
}

function roles(v: Options, ctx: BuildContext, key: string): string {
  return roleNames(v, ctx, v.array(key) ?? [], key);
}

export function cdata(text: string | undefined): FieldValue {
  return text === undefined ? "" : new CData(text);
}

export function pricingRecords(
  v: Options,
  ctx: BuildContext,
  items: FluentValue[],
  path: string,
  target: CompiledRecord,
  installCategory: CompiledRecord["installCategory"],
): CompiledRecord[] {
  return items.map((item, i) => {
    const detail = v.sub(item, `${path}[${i}].`, PRICING_DETAIL);
    const field = detail.string("field");
    const amount = detail.scalar("amount");
    const currency = detail.string("currencyType");
    const id = target.id.getValue();
    // The SDK writes a choice's pricing fields in a different order.
    const fields =
      target.table === "question_choice"
        ? { id, amount, currency, type: "calculated", field, table: target.table }
        : { id, field, amount, currency, type: "calculated", table: target.table };
    return ctx.factory.createRecord({ table: "fx_price", source: v.call.loc, installCategory, fields });
  });
}

/**
 * What a list of variables belongs to: a VariableSet's item_option_new_set, or
 * a catalog item with the variable sets it attaches (their records, or sys_ids).
 */
export type VariableParent =
  | { kind: "set"; record: CompiledRecord }
  | { kind: "item"; record: CompiledRecord; variableSets: (string | CompiledRecord)[] };

/** Every record of `record`'s tree. */
export function flat(record: CompiledRecord): CompiledRecord[] {
  return [record, ...record.children.flatMap(flat)];
}

/** The item_option_new records of a compiled VariableSet. */
export function setVariables(set: CompiledRecord): CompiledRecord[] {
  return flat(set).filter((r) => r.table === "item_option_new");
}

/**
 * The records of `entries`, the variables of `parent`: each item_option_new
 * followed by its pricing, with its choices (and their pricing) as children.
 */
export function buildVariables(
  owner: Options,
  ctx: BuildContext,
  entries: [string, FluentCall][],
  parent: VariableParent,
): CompiledRecord[] {
  const records: CompiledRecord[] = [];
  const apis = new Map(entries.map(([name, call]) => [name, call.api]));
  const built = new Map<string, CompiledRecord>();
  const installCategory = owner.installCategory;

  for (const [name, call] of entries) {
    if (call.binding) {
      ctx.report(
        "error",
        `Variable '${name}' must be declared inline inside 'variables: {...}'. A direct reference to a variable const (e.g. ${name}: someVariableConst) is not supported.`,
        call.loc,
      );
    }
  }

  for (const [name, call] of entries) {
    const [arg] = call.args;
    if (arg?.kind !== "object") continue;
    const api = call.api;
    const v: Options = new Options(call, arg, { properties: VARIABLE_PROPERTIES }, ctx);
    validate(v, ctx, api);

    const dependentQuestion = resolveDependentQuestion(v, ctx, name, apis, built, parent);
    const useReferenceQualifier = ["ListCollectorVariable", "LookupSelectBoxVariable", "LookupMultipleChoiceVariable"].includes(api)
      ? "advanced"
      : "simple";
    const visibility = v.get("visibility");
    const record = ctx.factory.createRecord({
      table: "item_option_new",
      source: call.loc,
      installCategory,
      fields: {
        name,
        type: VARIABLE_TYPES[api],
        question_text: v.string("question") ?? "",
        order: v.number("order") ?? 0,
        active: v.boolean("active") ?? true,
        mandatory: (api === "CheckboxVariable" ? v.boolean("selectionRequired") : v.boolean("mandatory")) ?? false,
        read_only: v.boolean("readOnly") ?? false,
        hidden: v.boolean("hidden") ?? false,
        disable_initial_slot_fill: v.boolean("disableInitialSlotFill") ?? false,
        conversational_label: v.string("conversationalLabel") ?? "",
        layout: v.string("layout") ?? "normal",
        tooltip: v.string("tooltip") ?? "",
        example_text: v.string("exampleText") ?? "",
        show_help: v.boolean("showHelp") ?? false,
        help_tag: v.string("helpTag") ?? "More information",
        help_text: v.string("helpText") ?? "",
        instructions: cdata(v.string("instructions")),
        variable_width: v.scalar("width") ?? "",
        attributes: v.string("attributes") ?? "",
        default_value: scalarOrRecord(v, ctx, "defaultValue"),
        read_roles: roles(v, ctx, "readRoles"),
        write_roles: roles(v, ctx, "writeRoles"),
        create_roles: roles(v, ctx, "createRoles"),
        delete_roles: roles(v, ctx, "deleteRoles"),
        cat_item: parent.kind === "item" ? parent.record : "",
        variable_set: parent.kind === "set" ? parent.record : "",
        reference: api === "RequestedForVariable" ? "sys_user" : (v.string("referenceTable") ?? ""),
        visible_standalone: v.boolean("visibleStandalone") ?? true,
        visible_summary: v.boolean("visibleSummary") ?? true,
        visible_guide: v.boolean("visibleGuide") ?? true,
        visible_bundle: v.boolean("visibleBundle") ?? true,
        not_available_conversation: v.boolean("removeFromConversationalInterfaces") ?? false,
        display_title: v.boolean("displayTitle") ?? false,
        macro: v.string("macro") ?? "",
        summary_macro: v.string("summaryMacro") ?? "",
        sp_widget: v.string("widget") ?? "",
        macroponent: v.string("macroponent") ?? "",
        topic_block: v.string("topicBlock") ?? "",
        list_table: v.string("listTable") ?? "",
        reference_qual: v.string("referenceQual") ?? "",
        lookup_source: v.string("lookupSource") ?? "",
        lookup_table: v.string("lookupFromTable") ?? "",
        lookup_value: v.string("lookupValueField") ?? "",
        lookup_label: v.stringArray("lookupLabelFields")?.join(",") ?? "",
        lookup_price: v.string("lookupPriceField") ?? "",
        rec_lookup_price: v.string("lookupRecurringPriceField") ?? "",
        choice_table: v.string("choiceTable") ?? "",
        choice_field: v.string("choiceField") ?? "",
        lookup_dependent_question: v.string("choicesDependOn") ?? "",
        choice_direction: v.string("choiceDirection") ?? "down",
        include_none: v.boolean("includeNone") ?? false,
        lookup_unique: v.boolean("uniqueValuesOnly") ?? false,
        mask_use_confirmation: v.boolean("useConfirmation") ?? false,
        mask_use_encryption: api === "MaskedVariable" ? (v.boolean("useEncryption") ?? true) : false,
        do_not_select_first: v.boolean("doNotSelectFirstChoice") ?? false,
        scale_min: v.number("scaleMin") ?? 0,
        scale_max: v.number("scaleMax") ?? 5,
        use_reference_qualifier: v.string("useReferenceQualifier") ?? useReferenceQualifier,
        reference_qual_condition: v.string("referenceQualCondition") ?? "",
        dynamic_ref_qual: scalarOrRecord(v, ctx, "dynamicRefQual"),
        enable_also_request_for: v.boolean("enableAlsoRequestFor") ?? false,
        rich_text: cdata(v.string("richText")),
        validate_regex: v.string("validateRegex") ?? "",
        ui_page: v.string("uiPage") ?? "",
        default_html_value: cdata(v.string("defaultHTML")),
        map_to_field: v.boolean("mapToField") ?? false,
        field: v.string("field") ?? "",
        delivery_plan: v.string("deliveryPlan") ?? "",
        visibility: visibility?.kind === "string" ? (lookup(VISIBILITY, visibility.value) ?? 1) : 1,
        roles_to_use_also_request_for: roles(v, ctx, "rolesToUseAlsoRequestFor"),
        category: v.string("category") ?? "",
        pricing_implications: v.boolean("pricingImplications") ?? false,
        show_help_on_load: v.boolean("alwaysExpand") ?? false,
        use_dynamic_default: v.boolean("useDynamicDefault") ?? false,
        read_script: cdata(v.string("readScript")),
        post_insert_script: cdata(v.string("postInsertScript")),
        unique: v.boolean("unique") ?? false,
        global: v.boolean("global") ?? false,
        description: cdata(v.string("description")),
        dynamic_value_dot_walk_path: v.string("dotWalkPath") ?? "",
        dynamic_value_field: dependentQuestion ?? "",
      },
    });
    built.set(name, record);

    const pricing = pricingRecords(v, ctx, v.array("pricingDetails") ?? [], "pricingDetails", record, installCategory);
    const choices = v.get("choices");
    if ((api === "MultipleChoiceVariable" || api === "SelectBoxVariable") && choices !== undefined) {
      if (choices.kind !== "object") v.error(`${api}(): 'choices' must be an object.`, choices);
      record.children.push(...choiceRecords(v, ctx, choices, record, installCategory));
    }
    records.push(record, ...pricing);
  }
  return records;
}

function choiceRecords(
  v: Options,
  ctx: BuildContext,
  choices: FluentObject,
  question: CompiledRecord,
  installCategory: CompiledRecord["installCategory"],
): CompiledRecord[] {
  return [...choices.props].map(([value, item]) => {
    const choice = v.sub(item, `choices.${value}.`, CHOICE);
    const record = ctx.factory.createRecord({
      table: "question_choice",
      source: v.call.loc,
      installCategory,
      fields: {
        value,
        text: choice.string("label") ?? value,
        inactive: choice.boolean("inactive") ?? false,
        order: choice.number("sequence") ?? 0,
        question,
      },
    });
    const path = `choices.${value}.pricingDetails`;
    record.children.push(...pricingRecords(v, ctx, choice.array("pricingDetails") ?? [], path, record, installCategory));
    return record;
  });
}

/**
 * `dependentQuestion` as the dynamic_value_field: the named variable of the
 * same `variables` (a reference variable), one of a catalog item's attached
 * variable sets, or a sys_id kept as given.
 */
function resolveDependentQuestion(
  v: Options,
  ctx: BuildContext,
  name: string,
  apis: Map<string, string>,
  built: Map<string, CompiledRecord>,
  parent: VariableParent,
): FieldValue | undefined {
  const value = v.get("dependentQuestion");
  if (value === undefined) return undefined;
  if (value.kind === "call") {
    ctx.report(
      "error",
      `'dependentQuestion' must be a string variable name (e.g. 'requestedFor') or a dot-walk into a variable set's variables (e.g. employeeSet.variables.requestedFor) referencing '${name}'. A direct reference to a variable const is not supported.`,
      value.loc,
    );
    return undefined;
  }
  if (value.kind !== "string") {
    ctx.report(
      "error",
      `'dependentQuestion' for '${name}' must be a string variable name (e.g. 'requestedFor') or a dot-walk into a variable set's variables (e.g. employeeSet.variables.requestedFor).`,
      value.loc,
    );
    return undefined;
  }
  const target = value.value;
  if (target === "") return undefined;
  const invalidParent = (): undefined => {
    ctx.report(
      "error",
      `'dependentQuestion' references '${target}' which is not a valid parent type. Only ReferenceVariable and RequestedForVariable are supported.`,
      value.loc,
    );
    return undefined;
  };
  const api = apis.get(target);
  if (api !== undefined) {
    if (!DEPENDENT_QUESTION_PARENTS.includes(api)) return invalidParent();
    const earlier = built.get(target);
    if (earlier) return earlier.id;
    const reference: RecordId = ctx.factory.createReference("item_option_new", undefined, {
      cat_item: parent.kind === "item" ? parent.record : "NULL",
      variable_set: parent.kind === "set" ? parent.record : "NULL",
      name: target,
    });
    return reference;
  }
  if (isGUID(target)) return target;
  if (parent.kind === "item") {
    // The SDK takes the first attached set that holds the name, or any set it cannot look into.
    for (const set of parent.variableSets) {
      if (typeof set !== "string") {
        const variable = setVariables(set).find((r) => r.fields.get("name") === target);
        if (!variable) continue;
        if (!DEPENDENT_QUESTION_PARENTS.some((p) => VARIABLE_TYPES[p] === variable.fields.get("type"))) return invalidParent();
      }
      return ctx.factory.createReference("item_option_new", undefined, { cat_item: "NULL", variable_set: set, name: target });
    }
  }
  ctx.report(
    "error",
    parent.kind === "item"
      ? `'dependentQuestion' references '${target}' which does not exist in this catalog item's variables or any attached variableSets. If it belongs to a variable set, add that variable set to the variableSets array.`
      : `'dependentQuestion' references '${target}' which does not exist in this variable set's variables.`,
    value.loc,
  );
  return undefined;
}
