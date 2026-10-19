// SPDX-License-Identifier: GPL-3.0-or-later
//
// The columns of a Table() schema: `StringColumn({...})` and its siblings →
// sys_dictionary, with its sys_documentation rows (one per label language)
// and, for a column with choices, its sys_choice rows and their
// sys_choice_set. Choices are written by the table's choice file, not as
// record updates of their own.

import { FluentCompileError } from "../diagnostics";
import type { FluentCall, FluentValue } from "../evaluate";
import { CData, type CompiledRecord, type FieldValue, type InstallCategory } from "../record";
import { generateLabel, generatePlural } from "./labels";
import { isSNScope, lookup, Options, type BuildContext, type OptionsShape } from "./shared";

/** Column API → sys_dictionary internal_type. */
export const COLUMN_TYPES: Readonly<Record<string, string>> = {
  StringColumn: "string",
  BooleanColumn: "boolean",
  ChoiceColumn: "choice",
  ConditionsColumn: "conditions",
  OtherDateColumn: "date",
  CalendarDateTimeColumn: "calendar_date_time",
  BasicDateTimeColumn: "datetime",
  DueDateColumn: "due_date",
  DateColumn: "glide_date",
  DateTimeColumn: "glide_date_time",
  IntegerDateColumn: "integer_date",
  ScheduleDateTimeColumn: "schedule_date_time",
  DecimalColumn: "decimal",
  DocumentIdColumn: "document_id",
  DomainIdColumn: "domain_id",
  DomainPathColumn: "domain_path",
  FieldNameColumn: "field_name",
  IntegerColumn: "integer",
  RadioColumn: "radio",
  ReferenceColumn: "reference",
  ScriptColumn: "script",
  SystemClassNameColumn: "sys_class_name",
  TableNameColumn: "table_name",
  TranslatedFieldColumn: "translated_field",
  TranslatedTextColumn: "translated_text",
  UserRolesColumn: "user_roles",
  VersionColumn: "version",
  ListColumn: "glide_list",
  BasicImageColumn: "image",
  GuidColumn: "GUID",
  Password2Column: "password2",
  JsonColumn: "json",
  UrlColumn: "url",
  EmailColumn: "email",
  HtmlColumn: "html",
  FloatColumn: "float",
  DurationColumn: "glide_duration",
  TimeColumn: "glide_time",
  FieldListColumn: "field_list",
  RecordsColumn: "records",
  SlushBucketColumn: "slushbucket",
  NameValuePairsColumn: "name_values",
  ApprovalRulesColumn: "approval_rules",
  MultiLineTextColumn: "multi_two_lines",
  TemplateValueColumn: "template_value",
  DayOfWeekColumn: "day_of_week",
  DaysOfWeekColumn: "days_of_week",
};

/** Column APIs: the typed ones, GenericColumn (any `columnType`) and OverrideColumn. */
export const COLUMN_APIS: readonly string[] = [...Object.keys(COLUMN_TYPES), "GenericColumn", "OverrideColumn"];

const COLUMN: OptionsShape = {
  properties: [
    "default",
    "maxLength",
    "label",
    "mandatory",
    "attributes",
    "active",
    "audit",
    "plural",
    "hint",
    "help",
    "widget",
    "array",
    "primary",
    "unique",
    "readOnlyOption",
    "dependent",
    "formula",
    "virtualType",
    "readOnly",
    "functionDefinition",
    "tableReference",
    "elementReference",
    "spellCheck",
    "xmlView",
    "textIndex",
    "choices",
    "dropdown",
    "dynamicValueDefinitions",
    "isFullUTF8",
    "min",
    "max",
    "scale",
    "script",
    "signature",
    "referenceTable",
    "cascadeRule",
    "useReferenceQualifier",
    "dynamicRefQual",
    "referenceFloats",
    "dynamicCreationScript",
    "dynamicCreation",
    "referenceKey",
    "referenceQual",
    "mtom",
    "columnType",
    "$override",
  ],
  aliases: {
    read_only: "readOnly",
    function_definition: "functionDefinition",
    table_reference: "tableReference",
    element_reference: "elementReference",
    spell_check: "spellCheck",
    xml_view: "xmlView",
    text_index: "textIndex",
    dynamic_value_definitions: "dynamicValueDefinitions",
    reference_floats: "referenceFloats",
    dynamic_creation_script: "dynamicCreationScript",
    // The SDK keeps this misspelt alias for backwards compatibility.
    dyamic_creation: "dynamicCreation",
    reference_key: "referenceKey",
    reference_qual: "referenceQual",
    column_type: "columnType",
    virtual_type: "virtualType",
    use_reference_qualifier: "useReferenceQualifier",
    dynamic_ref_qual: "dynamicRefQual",
  },
};

const LABEL: OptionsShape = {
  properties: ["label", "language", "plural", "hint", "help", "url", "urlTarget"],
  aliases: { url_target: "urlTarget" },
};

const CHOICE: OptionsShape = {
  properties: ["label", "sequence", "dependentValue", "hint", "inactive", "inactiveOnUpdate", "language", "synonyms"],
  aliases: { dependent_value: "dependentValue", inactive_on_update: "inactiveOnUpdate" },
};

const DROPDOWN = ["none", "dropdown_with_none", "suggestion", "dropdown_without_none"];
const DEPENDENT_TYPES = ["document_id", "field_list", "template_value"];
export const BCP47 = /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const BCP47_MESSAGE = "'language' must be a valid BCP 47 language tag (e.g., 'en', 'es', 'en-US', 'zh-Hans')";

/** A column's `mtom`, which only the table's dictionary file writes. */
export const COLUMN_MTOM = new WeakMap<CompiledRecord, string>();

/** Where a table's records go and what they are labelled with. */
export interface TableTarget {
  name: string;
  installCategory: InstallCategory;
  defaultLanguage: string;
}

/** `{ a: 1, b: true }` → `a=1,b=true`, the platform's attributes string. */
export function attributesText(o: Options, key: string): Record<string, string> | undefined {
  const v = o.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== "object") o.error(`${o.call.api}(): '${key}' must be an object.`, v);
  const out: Record<string, string> = {};
  for (const [k, item] of v.props) {
    if (item.kind !== "string" && item.kind !== "number" && item.kind !== "boolean") {
      o.error(`${o.call.api}(): '${key}.${k}' must be a string, number or boolean.`, item);
    }
    out[k] = String(item.value);
  }
  return out;
}

export const joinAttributes = (attrs: Record<string, string> | undefined): string | undefined =>
  attrs &&
  Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

/** The `{ plural, hint, help }` a column gives every label entry that does not set its own. */
interface RootDocumentation {
  plural?: string;
  hint?: string;
  help?: string;
}

/**
 * sys_documentation rows for a `label` option: a string, an array of
 * per-language entries, or nothing (one row with the generated label).
 */
export function documentation(
  o: Options,
  ctx: BuildContext,
  target: TableTarget,
  element: string | undefined,
  path: string,
  root: RootDocumentation = {},
): CompiledRecord[] {
  const shape = o.get("label");
  let entries: (Options | string | undefined)[];
  if (shape === undefined) entries = [undefined];
  else if (shape.kind === "string") entries = [shape.value];
  else if (shape.kind === "array") {
    entries = shape.items.map((item, i) => {
      if (item.kind !== "object") o.error(`${o.call.api}(): '${path}label[${i}]' must be an object.`, item);
      return new Options(o.call, item, LABEL, ctx, `${path}label[${i}].`);
    });
  } else return o.error(`${o.call.api}(): '${path}label' must be a string or an array of label entries.`, shape);

  const defaultLabel = generateLabel(element ?? target.name);
  const languages = new Set<string>();
  return entries.map((entry) => {
    const e = entry instanceof Options ? entry : undefined;
    const loc = e?.object.loc ?? shape?.loc ?? o.call.loc;
    const explicitLanguage = e?.string("language");
    const language = explicitLanguage || target.defaultLanguage;
    if (!BCP47.test(language)) ctx.report("error", BCP47_MESSAGE, loc);
    if (languages.has(language)) {
      ctx.report("error", `Duplicate language '${language}' found. Each language must be unique per label entry.`, loc);
    }
    languages.add(language);
    const given = entry instanceof Options ? entry.string("label") : entry;
    const label = given || defaultLabel;
    const recordLanguage = explicitLanguage ?? target.defaultLanguage;
    return ctx.factory.createRecord({
      table: "sys_documentation",
      source: loc,
      installCategory: target.installCategory,
      updateName: `sys_documentation_${target.name}_${element ?? ""}_${recordLanguage || "en"}`,
      fields: {
        name: target.name,
        element,
        label,
        plural: e?.string("plural") ?? root.plural ?? generatePlural(label),
        language: recordLanguage,
        help: e?.string("help") ?? root.help,
        hint: e?.string("hint") ?? root.hint,
        url: e?.string("url"),
        url_target: e?.string("urlTarget"),
      },
    });
  });
}

/** The label of the default-language documentation row, if there is one. */
export function defaultLanguageLabel(docs: CompiledRecord[], language: string): string | undefined {
  const doc = docs.find((d) => d.fields.get("language") === language);
  return doc === undefined ? undefined : String(doc.fields.get("label"));
}

function nonEmpty(o: Options, key: string): string | undefined {
  return o.string(key) || undefined;
}

/** A column call's options object, read with the column option names. */
function columnOptions(call: FluentCall, name: string, ctx: BuildContext): Options {
  const [arg] = call.args;
  if (call.args.length !== 1 || arg.kind !== "object") {
    throw new FluentCompileError(`${call.api}() takes one options object.`, call.loc);
  }
  return new Options(call, arg, COLUMN, ctx, `schema.${name}.`);
}

function unsupported(o: Options, key: string, what = `'${key}'`): void {
  const v = o.get(key);
  if (v !== undefined) o.error(`${o.call.api}(): ${what} is not supported by the native compiler yet.`, v);
}

/** The value of the option, if it is a string or a number. */
function stringOrNumber(o: Options, key: string): string | number | undefined {
  const v = o.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== "string" && v.kind !== "number") o.error(`${o.call.api}(): '${key}' must be a string or a number.`, v);
  return v.value;
}

function scalarValue(o: Options, key: string): string | number | boolean | undefined {
  const v = o.get(key);
  if (v === undefined) return undefined;
  if (v.kind === "array") o.error(`${o.call.api}(): an array '${key}' is not supported by the native compiler yet.`, v);
  if (v.kind !== "string" && v.kind !== "number" && v.kind !== "boolean") {
    o.error(`${o.call.api}(): '${key}' must be a string, number or boolean.`, v);
  }
  return v.value;
}

/**
 * The sys_dictionary row of one column, with its documentation and choices
 * as children. `value` is the schema entry; anything but a column call is an error.
 */
export function buildColumn(
  table: Options,
  ctx: BuildContext,
  target: TableTarget,
  name: string,
  value: FluentValue,
  display: boolean,
): CompiledRecord {
  if (value.kind !== "call" || !COLUMN_APIS.includes(value.api)) {
    return table.error("Invalid column in table schema", value);
  }
  if (value.api === "OverrideColumn") {
    return table.error("Table(): OverrideColumn() is not supported by the native compiler yet.", value);
  }
  const o = columnOptions(value, name, ctx);
  unsupported(o, "dynamicValueDefinitions");
  const columnType = value.api === "GenericColumn" ? o.requiredString("columnType") : lookup(COLUMN_TYPES, value.api)!;
  const internalType = columnType === "string" && o.boolean("isFullUTF8") === true ? "string_full_utf8" : columnType;
  // min, max and signature are typed options the SDK does not write.
  for (const ignored of ["min", "max", "signature"]) o.get(ignored);

  const docs = documentation(o, ctx, target, name, `schema.${name}.`, {
    plural: nonEmpty(o, "plural"),
    hint: nonEmpty(o, "hint"),
    help: nonEmpty(o, "help"),
  });

  const attrs = attributesText(o, "attributes") ?? {};
  const scale = o.number("scale");
  if (scale !== undefined) attrs.scale = String(scale);
  const script = o.string("script");
  if (script !== undefined) attrs.script = script;

  const dropdown = o.string("dropdown");
  const dropdownIndex = dropdown === undefined ? -1 : DROPDOWN.indexOf(dropdown);
  if (dropdown !== undefined && dropdownIndex < 0) {
    o.error(`${o.call.api}(): 'dropdown' must be one of ${DROPDOWN.map((d) => `'${d}'`).join(", ")}.`, o.get("dropdown"));
  }

  const formula = o.string("formula");
  const hasFormula = formula !== undefined && formula !== "";
  const virtualType = o.string("virtualType");
  const impliedVirtualType = hasFormula ? "formula" : "script";
  if (virtualType !== undefined && virtualType !== impliedVirtualType) {
    const reason = hasFormula ? "formula is set, implying 'formula'" : "formula is not set, implying 'script'";
    ctx.report(
      "warning",
      `virtualType is set to '${virtualType}' but ${reason}. The explicit value '${virtualType}' will be used.`,
      o.get("virtualType")!.loc,
    );
  }

  const dependentValue = o.get("dependent");
  let dependent: string | undefined;
  if (dependentValue?.kind === "string") dependent = dependentValue.value;
  else if (dependentValue !== undefined) {
    ctx.report(
      "warning",
      "Passing a TableNameColumn object to 'dependent' is deprecated and will not work as expected. Pass the field name as a string instead.",
      dependentValue.loc,
    );
  }
  const usesDependentField = DEPENDENT_TYPES.includes(internalType) && !!dependent;

  const functionDefinition = o.string("functionDefinition");

  const readOnlyOption = o.string("readOnlyOption");
  const readOnly = o.boolean("readOnly");
  if (readOnlyOption && readOnly === false) {
    ctx.report("error", `readOnly cannot be false with readOnlyOption ${readOnlyOption}.`, o.get("readOnly")!.loc);
  } else if (readOnlyOption && readOnly === true) {
    ctx.report("hint", `readOnly is unnecessary when readOnlyOption '${readOnlyOption}' is declared.`, o.get("readOnly")!.loc);
  }

  const dynamicRefQual = o.string("dynamicRefQual");
  const referenceQual = o.string("referenceQual");
  const hasDynamic = dynamicRefQual !== undefined;
  const hasReference = referenceQual !== undefined && referenceQual !== "";
  const derivedQualifier = hasDynamic ? "dynamic" : hasReference ? "advanced" : "simple";
  const useReferenceQualifier = o.string("useReferenceQualifier");
  if (useReferenceQualifier !== undefined && useReferenceQualifier !== derivedQualifier) {
    const reason =
      hasDynamic && hasReference
        ? "both dynamicRefQual and referenceQual are set"
        : hasDynamic
          ? "dynamicRefQual is set, implying 'dynamic'"
          : hasReference
            ? "referenceQual is set, implying 'advanced'"
            : "neither dynamicRefQual nor referenceQual is set, implying 'simple'";
    ctx.report(
      "hint",
      `useReferenceQualifier is set to '${useReferenceQualifier}' but ${reason}. The explicit value '${useReferenceQualifier}' will be used.`,
      o.get("useReferenceQualifier")!.loc,
    );
  }

  const mtom = o.scalar("mtom");
  if (mtom && !isSNScope(ctx.scope)) {
    ctx.report(
      "warning",
      "'mtom' is reserved for ServiceNow internal use and will be ignored. Use the sys_m2m table to establish many-to-many relationships.",
      o.get("mtom")!.loc,
    );
  }

  const referenceFloats = scalarValue(o, "referenceFloats");
  const referenceTable = o.string("referenceTable");
  if (referenceTable !== undefined) ctx.dictionary.refer(value.api, referenceTable, o.get("referenceTable")!.loc);
  const fields: Record<string, FieldValue> = {
    name: target.name,
    element: name,
    active: o.boolean("active") ?? true,
    array: o.boolean("array") ?? false,
    attributes: joinAttributes(attrs),
    audit: o.boolean("audit") ?? false,
    calculation: undefined,
    choice: dropdownIndex > 0 ? dropdownIndex : undefined,
    choice_field: undefined,
    choice_table: undefined,
    column_label: defaultLanguageLabel(docs, target.defaultLanguage) ?? generateLabel(name),
    default_value: scalarValue(o, "default"),
    dependent,
    dependent_on_field: usesDependentField ? dependent : undefined,
    display,
    dynamic_creation: o.boolean("dynamicCreation"),
    dynamic_creation_script: o.string("dynamicCreationScript"),
    dynamic_ref_qual: dynamicRefQual ? ctx.factory.createReference("sys_filter_option_dynamic", dynamicRefQual) : dynamicRefQual,
    element_reference: o.boolean("elementReference") ?? false,
    formula: formula === undefined ? undefined : new CData(formula),
    function_definition: functionDefinition,
    function_field: !!functionDefinition,
    internal_type: internalType,
    mandatory: o.boolean("mandatory") ?? false,
    max_length: stringOrNumber(o, "maxLength"),
    primary: o.boolean("primary") ?? false,
    read_only: readOnly ?? !!readOnlyOption,
    read_only_option: readOnlyOption || (readOnly === true ? "instance_configured" : undefined),
    reference: referenceTable,
    reference_cascade_rule: o.string("cascadeRule"),
    reference_floats: referenceFloats,
    reference_key: o.string("referenceKey"),
    reference_qual: referenceQual,
    spell_check: o.boolean("spellCheck") ?? false,
    table_reference: o.boolean("tableReference") ?? false,
    text_index: o.boolean("textIndex") ?? false,
    unique: o.boolean("unique") ?? false,
    use_dependent_field: usesDependentField,
    use_reference_qualifier: useReferenceQualifier ?? derivedQualifier,
    virtual: hasFormula ? true : undefined,
    virtual_type: virtualType ?? impliedVirtualType,
    widget: o.string("widget"),
    xml_view: o.boolean("xmlView") ?? false,
  };
  const record = ctx.factory.createRecord({
    table: "sys_dictionary",
    source: value.loc,
    installCategory: target.installCategory,
    updateName: `sys_dictionary_${target.name}_${name}`,
    elementAttributes: { element: name, table: target.name },
    fields,
  });
  // Not a sys_dictionary field: the table's dictionary file writes it for ServiceNow scopes.
  if (mtom !== undefined) COLUMN_MTOM.set(record, mtom);
  o.applyOverride(record);
  record.children.push(...docs, ...choices(o, ctx, target, name));
  return record;
}

/** The column's sys_choice rows, then their sys_choice_set; none without `choices`. */
function choices(o: Options, ctx: BuildContext, target: TableTarget, element: string): CompiledRecord[] {
  const value = o.get("choices");
  if (value === undefined) return [];
  if (value.kind !== "object") return o.error(`${o.call.api}(): 'choices' must be an object.`, value);
  const records: CompiledRecord[] = [];
  const create = (loc: FluentValue["loc"], fields: Record<string, FieldValue>) =>
    ctx.factory.createRecord({
      table: "sys_choice",
      source: loc,
      installCategory: target.installCategory,
      emit: false,
      fields: { name: target.name, element, ...fields },
    });
  [...value.props].forEach(([choiceValue, choice], idx) => {
    if (choice.kind === "string") {
      records.push(
        create(choice.loc, {
          label: choice.value,
          value: choiceValue,
          sequence: idx + 1,
          language: target.defaultLanguage,
        }),
      );
      return;
    }
    const multi = choice.kind === "array";
    const entries = multi ? choice.items : [choice];
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      const path = `choices.${choiceValue}${multi ? `[${i}]` : ""}.`;
      if (entry.kind !== "object") o.error(`${o.call.api}(): '${path.slice(0, -1)}' must be a string or a choice object.`, entry);
      const c = new Options(o.call, entry, CHOICE, ctx, path);
      const language = c.string("language");
      const resolvedLanguage = multi ? (language ?? target.defaultLanguage) : language;
      if (language && !BCP47.test(language)) ctx.report("error", BCP47_MESSAGE, entry.loc);
      const dependentValue = stringOrNumber(c, "dependentValue");
      if (resolvedLanguage !== undefined) {
        const dv = dependentValue === undefined ? "" : String(dependentValue);
        const key = `${resolvedLanguage}::${dv}`;
        if (seen.has(key)) {
          const detail = dv ? ` with dependentValue '${dv}'` : "";
          ctx.report(
            "error",
            `Duplicate entry for choice value '${choiceValue}'${detail}: language '${resolvedLanguage}' is already used. Each (language, dependentValue) combination must be unique per choice value.`,
            entry.loc,
          );
        }
        seen.add(key);
      }
      records.push(
        create(entry.loc, {
          label: c.string("label"),
          value: choiceValue,
          sequence: c.number("sequence"),
          dependent_value: dependentValue,
          hint: c.string("hint"),
          inactive: c.boolean("inactive") ?? false,
          inactive_on_update: c.boolean("inactiveOnUpdate") ?? false,
          language: language ?? target.defaultLanguage,
          synonyms: c.stringArray("synonyms")?.join(","),
        }),
      );
    });
  });
  if (records.length > 0) {
    records.push(
      ctx.factory.createRecord({
        table: "sys_choice_set",
        source: value.loc,
        installCategory: target.installCategory,
        emit: false,
        updateName: `sys_choice_${target.name}_${element}`,
        fields: { name: target.name, element },
      }),
    );
  }
  return records;
}
