// SPDX-License-Identifier: GPL-3.0-or-later
//
// ImportSet() → sys_transform_map with a sys_transform_entry per field
// mapping (coalesced on the map and the target field) and a
// sys_transform_script per transform script.
//
// Like the SDK, a script left out is written as the instance's default
// template (as plain text, a given script as CDATA), and a field mapping
// given as a string copies its source field with every option at its default.

import { CData, type CreateRecordOptions } from "../record";
import { lookup, type ArtefactSpec, type Options } from "./shared";

const ENFORCE_MANDATORY_FIELDS: Record<string, string> = {
  onlyMappedFields: "Only Mapped Fields",
  allFields: "All Fields",
  no: "No",
};

const DEFAULT_MAP_SCRIPT =
  '(function transformRow(source, target, map, log, isUpdate) {\n\n\t// Add your code here\n\n})(source, target, map, log, action==="update");';
const DEFAULT_ENTRY_SCRIPT =
  'answer = (function transformEntry(source) {\n\n    // Add your code here\n    return ""; // return the value to be put into the target field\n\n})(source);';
const DEFAULT_SCRIPT =
  "(function runTransformScript(source, map, log, target /*undefined onStart*/ ) {\n\n    // Add your code here\n\n})(source, map, log, target);";

const FIELD_PROPERTIES = [
  "sourceField",
  "choiceAction",
  "dateFormat",
  "referenceValueField",
  "useSourceScript",
  "sourceScript",
  "coalesce",
  "coalesceCaseSensitive",
  "coalesceEmptyFields",
];

/** A script given as CDATA, the default template as plain text. */
function script(o: Options, key: string, fallback: string): CData | string {
  const value = o.string(key);
  return value === undefined ? fallback : new CData(value);
}

export const importSet: ArtefactSpec = {
  properties: [
    "name",
    "targetTable",
    "sourceTable",
    "order",
    "active",
    "runBusinessRules",
    "enforceMandatoryFields",
    "copyEmptyFields",
    "createOnEmptyCoalesce",
    "mapCoalesce",
    "fields",
    "scripts",
    "runScript",
    "script",
  ],
  build(o, ctx) {
    if (!o.boolean("runScript") && o.get("script")) {
      o.error(
        "Property 'script' cannot be used when 'runScript' is false or undefined. Remove the 'script' property or set 'runScript: true'.",
        o.get("script"),
      );
    }
    const sourceTable = o.string("sourceTable");
    const targetTable = o.string("targetTable") ?? "";
    const map = ctx.factory.createRecord({
      table: "sys_transform_map",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name"),
        source_table: sourceTable,
        target_table: targetTable,
        active: o.boolean("active") ?? false,
        run_business_rules: o.boolean("runBusinessRules") ?? false,
        enforce_mandatory_fields: lookup(ENFORCE_MANDATORY_FIELDS, o.string("enforceMandatoryFields") ?? "") ?? "No",
        copy_empty_fields: o.boolean("copyEmptyFields") ?? false,
        create_new_record_on_empty_coalesce_fields: o.boolean("createOnEmptyCoalesce") ?? false,
        script: script(o, "script", DEFAULT_MAP_SCRIPT),
        run_script: o.boolean("runScript") ?? false,
        coalesce: o.boolean("mapCoalesce") ?? false,
        order: o.number("order") ?? 100,
      },
    });
    const child = (table: string, explicitId: string | number | undefined, fields: CreateRecordOptions["fields"]) =>
      map.children.push(ctx.factory.createRecord({ table, source: o.call.loc, installCategory: o.installCategory, explicitId, fields }));

    const fields = o.get("fields");
    const mappings = fields === undefined ? [] : fields.kind === "object" ? fields.props : o.error("ImportSet(): 'fields' must be an object.", fields);
    for (const [target, value] of mappings) {
      const entry = { map, target_field: target, source_table: sourceTable, target_table: targetTable };
      if (value.kind === "string") {
        child("sys_transform_entry", undefined, {
          ...entry,
          source_field: value.value,
          choice_action: "",
          source_script: DEFAULT_ENTRY_SCRIPT,
          use_source_script: false,
          date_format: "",
          reference_value_field: "",
          coalesce: false,
          coalesce_case_sensitive: false,
          coalesce_empty_fields: false,
        });
        continue;
      }
      if (value.kind !== "object") o.error(`ImportSet(): 'fields.${target}' must be a source field name or a field mapping object.`, value);
      const f = o.sub(value, `fields.${target}.`, FIELD_PROPERTIES);
      const coalesce = f.boolean("coalesce") ?? false;
      for (const key of ["coalesceCaseSensitive", "coalesceEmptyFields"]) {
        if (!coalesce && f.get(key)) {
          f.error(
            `Field '${target}': Property '${key}' cannot be used when 'coalesce' is false or undefined. Remove the '${key}' property or set 'coalesce: true'.`,
            f.get(key),
          );
        }
      }
      const useSourceScript = f.boolean("useSourceScript") ?? false;
      const sourceScript = f.get("sourceScript");
      if (!useSourceScript && sourceScript) {
        ctx.report(
          "hint",
          `Field '${target}': 'sourceScript' has no effect when 'useSourceScript' is false. The script will be saved but will not run until 'useSourceScript' is set to true.`,
          sourceScript.loc,
        );
      }
      if (useSourceScript && !sourceScript) {
        ctx.report(
          "hint",
          `Field '${target}': No 'sourceScript' provided — the default transform entry script will be used. Add a 'sourceScript' to define the transformation logic.`,
          f.get("useSourceScript")!.loc,
        );
      }
      child("sys_transform_entry", undefined, {
        ...entry,
        source_field: f.string("sourceField") ?? "",
        choice_action: f.string("choiceAction") ?? "",
        source_script: script(f, "sourceScript", DEFAULT_ENTRY_SCRIPT),
        use_source_script: useSourceScript,
        date_format: f.string("dateFormat") ?? "",
        reference_value_field: f.string("referenceValueField") ?? "",
        coalesce,
        coalesce_case_sensitive: f.boolean("coalesceCaseSensitive") ?? false,
        coalesce_empty_fields: f.boolean("coalesceEmptyFields") ?? false,
      });
    }

    (o.array("scripts") ?? []).forEach((item, i) => {
      const s = o.sub(item, `scripts[${i}].`, ["$id", "active", "order", "when", "script"]);
      child("sys_transform_script", s.explicitId(), {
        map,
        active: s.boolean("active") ?? true,
        order: s.number("order") ?? 100,
        when: s.string("when") ?? "onAfter",
        script: script(s, "script", DEFAULT_SCRIPT),
      });
    });
    return map;
  },
};
