// SPDX-License-Identifier: GPL-3.0-or-later
//
// The two files a Table() writes besides its record updates, the way SDK
// 4.13.6 writes them:
//
// - `dictionary/<table>.xml`, the bootstrap dictionary the platform reads to
//   create the table and its columns (one `<element>` per column, choices
//   nested under theirs);
// - `author_elective_update/sys_choice_<table>_<column>.xml`, one per column
//   with choices: the legacy (version 3) choice set composite, which
//   ChoiceSet() writes too.

import { escapeXmlAttribute, escapeXmlText } from "../../recordXml";
import { CData, RecordId, type CompiledRecord, type FieldValue } from "../record";
import { generatePlural } from "./labels";

/** A column of a table, as the files need it. */
export interface TableFileColumn {
  dictionary: CompiledRecord;
  docs: CompiledRecord[];
  choices: CompiledRecord[];
  choiceSet?: CompiledRecord;
  mtom?: string;
}

export interface TableFileModel {
  name: string;
  scope: string;
  scopeId: string;
  snScope: boolean;
  dbObject: CompiledRecord;
  collection: CompiledRecord;
  docs: CompiledRecord[];
  columns: TableFileColumn[];
  /** The name of the table this one extends. */
  extendsName?: string;
  display?: string;
}

export interface EmittedFile {
  /** Relative to the app's dist directory, `/`-separated. */
  path: string;
  content: string;
}

type Attr = string | number | boolean | undefined;

function text(value: FieldValue): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof RecordId) return value.getValue();
  if (value instanceof CData) return value.text;
  return String(value);
}

/** Like a record_update attribute, plus line breaks as references (xml-js leaves them, the platform would fold them). */
function escapeAttribute(value: string): string {
  return escapeXmlAttribute(value).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

function element(name: string, attrs: [string, Attr][], children: string[], indent: string): string {
  const rendered = attrs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttribute(String(v))}"`)
    .join("");
  if (children.length === 0) return `${indent}<${name}${rendered}/>`;
  return [`${indent}<${name}${rendered}>`, ...children, `${indent}</${name}>`].join("\n");
}

const DROPDOWN_DEFAULT = 0;

function columnElement(model: TableFileModel, column: TableFileColumn): string {
  const f = (key: string): FieldValue => column.dictionary.fields.get(key);
  const s = (key: string): string | undefined => text(f(key));
  const doc = column.docs[0]?.fields;
  const docText = (key: string): string | undefined => text(doc?.get(key)) || s(key) || undefined;
  const dependentOnField = s("dependent_on_field");
  const referenceFloats = f("reference_floats");
  const formula = s("formula");
  const virtualType = s("virtual_type");
  const qualifier = s("use_reference_qualifier");
  const choice = f("choice");
  const attrs: [string, Attr][] = [
    ["name", s("element")],
    ["type", s("internal_type")],
    ["active", s("active")],
    ["array", s("array")],
    ["audit", s("audit")],
    ["default_value", s("default_value")],
    ["unique", s("unique")],
    ["label", s("column_label")],
    ["max_length", s("max_length")],
    ["mandatory", s("mandatory")],
    ["read_only", s("read_only")],
    ["read_only_option", s("read_only_option")],
    ["reference_cascade_rule", s("reference_cascade_rule")],
    ["calculation", s("calculation")],
    ["choice", typeof choice === "number" ? choice : DROPDOWN_DEFAULT],
    ["choice_table", s("choice_table")],
    ["choice_field", s("choice_field")],
    ["display", s("display")],
    ["function_field", s("function_field")],
    ["attributes", s("attributes")],
    ["inactive", s("inactive")],
    ["dynamic_default", s("dynamic_default")],
    ["spell_check", s("spell_check")],
    ["xml_view", s("xml_view")],
    ["table_reference", s("table_reference")],
    ["text_index", s("text_index")],
    ["element_reference", s("element_reference")],
    ["primary", s("primary")],
    ["dependent", s("dependent")],
    ["dependent_on_field", dependentOnField],
    ["use_dependent_field", dependentOnField === undefined ? undefined : dependentOnField !== ""],
    ["use_dynamic_default", s("use_dynamic_default")],
    ["reference", s("reference")],
    ["function_definition", s("function_definition")],
    ["reference_floats", typeof referenceFloats === "boolean" ? referenceFloats : undefined],
    ["reference_key", s("reference_key")],
    ["mtom", model.snScope ? column.mtom : undefined],
    ["dynamic_creation_script", s("dynamic_creation_script")],
    ["dynamic_creation", s("dynamic_creation")],
    ["plural", docText("plural")],
    ["hint", docText("hint")],
    ["help", docText("help")],
    ["url", docText("url")],
    ["url_target", docText("url_target")],
    ["virtual", s("virtual")],
    ["formula", formula || undefined],
    ["virtual_type", virtualType === "script" ? undefined : virtualType],
    ["use_reference_qualifier", qualifier === "simple" ? undefined : qualifier],
    ["dynamic_ref_qual", s("dynamic_ref_qual") || undefined],
    ["widget", s("widget")],
    ["reference_qual", s("reference_qual")],
    ["reference_qual_condition", s("reference_qual_condition")],
  ];
  const children =
    column.choices.length === 0
      ? []
      : [
          element(
            "choice",
            [],
            column.choices.map((c) => {
              const cf = (key: string): string | undefined => text(c.fields.get(key));
              const sequence = c.fields.get("sequence");
              return element(
                "element",
                [
                  ["value", cf("value")],
                  ["label", cf("label")],
                  ["dependent_value", cf("dependent_value")],
                  ["inactive", cf("inactive")],
                  ["inactive_on_update", cf("inactive_on_update")],
                  ["sequence", typeof sequence === "number" ? sequence : undefined],
                  ["hint", cf("hint")],
                  ["synonyms", cf("synonyms")],
                  ["language", cf("language")],
                ],
                [],
                "        ",
              );
            }),
            "      ",
          ),
        ];
  return element("element", attrs, children, "    ");
}

/** `dictionary/<table>.xml`. */
export function bootstrapFile(model: TableFileModel): EmittedFile {
  const db = (key: string): string | undefined => text(model.dbObject.fields.get(key));
  const dict = (key: string): string | undefined => text(model.collection.fields.get(key));
  // table.ts always sets a label: the default-language entry or one derived from the name.
  const label = db("label") as string;
  const doc = model.docs.length === 1 ? model.docs[0].fields : undefined;
  const docText = (key: string): string | undefined => text(doc?.get(key)) || undefined;
  const plural = text(doc?.get("plural"));
  const callerAccess = model.dbObject.fields.get("caller_access");
  const attrs: [string, Attr][] = [
    ["name", model.name],
    ["type", "collection"],
    ["label", label],
    ["extends", model.extendsName],
    ["is_extendable", db("is_extendable")],
    ["text_index", dict("text_index")],
    ["read_only", dict("read_only")],
    ["audit", dict("audit")],
    ["display", model.display],
    ["access", db("access")],
    ["caller_access", typeof callerAccess === "number" ? callerAccess : 0],
    ...["ws", "read", "alter", "create", "update", "delete", "actions", "client_scripts", "configuration"].map(
      (k): [string, Attr] => [`${k}_access`, db(`${k}_access`)],
    ),
    ["scriptable_table", db("scriptable_table")],
    ["sizeclass", dict("sizeclass")],
    ["attributes", dict("attributes")],
    ["plural", generatePlural(label) !== plural ? plural || undefined : undefined],
    ["hint", docText("hint")],
    ["help", docText("help")],
    ["url", docText("url")],
    ["url_target", docText("url_target")],
  ];
  const columns = model.columns.map((c) => columnElement(model, c));
  return {
    path: `dictionary/${model.name}.xml`,
    content: ['<?xml version="1.0"?>', "<database>", element("element", attrs, columns, "  "), "</database>"].join("\n"),
  };
}

function field(name: string, value: string, attrs: Record<string, string> = {}): string {
  const rendered = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`)
    .join("");
  return value === "" ? `      <${name}${rendered}/>` : `      <${name}${rendered}>${escapeXmlText(value)}</${name}>`;
}

const CHOICE_PROPERTIES = [
  "label",
  "value",
  "sequence",
  "dependent_value",
  "hint",
  "inactive",
  "inactive_on_update",
  "language",
  "synonyms",
];

/**
 * `author_elective_update/sys_choice_<table>_<column>.xml`, the legacy choice
 * set composite of a Table() column or a ChoiceSet().
 */
export function choiceSetFile(
  model: Pick<TableFileModel, "name" | "scope" | "scopeId">,
  column: Pick<TableFileColumn, "choices" | "choiceSet">,
): EmittedFile | undefined {
  const set = column.choiceSet;
  if (set === undefined) return undefined;
  const element = String(set.fields.get("element"));
  const updateName = `sys_choice_${model.name}_${element}`;
  const lines = [
    '<?xml version="1.0"?>',
    "<record_update>",
    `  <sys_choice_set action="INSERT_OR_UPDATE" field="${escapeXmlAttribute(element)}" table="${escapeXmlAttribute(model.name)}" version="3" apply_defaults="true">`,
    '    <sys_choice_set action="INSERT_OR_UPDATE" apply_defaults="true">',
    field("sys_id", set.id.getValue()),
    field("element", element),
    field("sys_update_name", updateName),
    field("name", model.name),
    field("sys_class_name", "sys_choice_set"),
    field("sys_scope", model.scopeId, { display_value: model.scope }),
    field("sys_package", model.scopeId, { display_value: model.scope, source: model.scopeId }),
    field("sys_name", element),
    "    </sys_choice_set>",
  ];
  for (const choice of column.choices) {
    lines.push(
      '    <sys_choice action="INSERT_OR_UPDATE" apply_defaults="true">',
      field("sys_id", choice.id.getValue()),
      field("name", model.name),
      field("element", element),
    );
    for (const prop of CHOICE_PROPERTIES) {
      const value = choice.fields.get(prop);
      if (value !== undefined) lines.push(field(prop, text(value) as string));
    }
    lines.push("    </sys_choice>");
  }
  lines.push("  </sys_choice_set>", "</record_update>");
  return { path: `author_elective_update/${updateName}.xml`, content: lines.join("\n") };
}
