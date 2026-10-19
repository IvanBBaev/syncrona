// SPDX-License-Identifier: GPL-3.0-or-later
//
// ChoiceSet() → sys_choice_set and its sys_choice rows, for a field the app
// does not own. Like a Table() column's choices, they are written by the
// legacy (version 3) choice set file, not as record updates. Once every call
// is built, the set is checked the way the SDK inspects it: the field must not
// be one of the project's columns and, in a scoped app, the table must be one
// of the project's tables.

import type { FluentValue } from "../evaluate";
import type { CompiledRecord, FieldValue } from "../record";
import { Options, type ArtefactSpec, type BuildContext } from "./shared";
import { choiceSetFile } from "./tableFiles";

const CHOICE = ["label", "sequence", "hint", "inactive", "inactiveOnUpdate", "dependentValue", "synonyms", "language"];
/** The options every other API takes, which ChoiceSet() does not. */
const UNSUPPORTED = ["$id", "$meta", "$override", "protectionPolicy"];

function nonEmpty(o: Options, key: string): string {
  const value = o.requiredString(key);
  if (value === "") o.error(`ChoiceSet(): '${key}' must not be empty.`, o.get(key));
  return value;
}

/** The sys_choice fields of a choice object (one entry of an array, or the value itself). */
function choiceFields(o: Options, ctx: BuildContext, value: string, entry: FluentValue, path: string, labelAt: FluentValue): Record<string, FieldValue> {
  const c: Options = o.sub(entry, path, CHOICE);
  const label = c.get("label");
  if (label?.kind !== "string") {
    ctx.report("error", `Choice '${value}' is missing the required 'label' property.`, labelAt.loc);
  }
  const dependentValue = c.get("dependentValue");
  if (dependentValue !== undefined && dependentValue.kind !== "string" && dependentValue.kind !== "number") {
    return c.error(`ChoiceSet(): '${path}dependentValue' must be a string or a number.`, dependentValue);
  }
  return {
    label: label?.kind === "string" ? label.value : undefined,
    sequence: c.number("sequence"),
    inactive: c.boolean("inactive") ?? false,
    inactive_on_update: c.boolean("inactiveOnUpdate") ?? false,
    language: c.string("language") ?? ctx.defaultLanguage,
    dependent_value: dependentValue === undefined ? "" : String(dependentValue.value),
    synonyms: c.stringArray("synonyms")?.join(",") ?? "",
    hint: c.string("hint") ?? "",
  };
}

export const choiceSet: ArtefactSpec = {
  properties: ["table", "field", "choices"],
  build(o, ctx) {
    for (const key of UNSUPPORTED) {
      const value = o.object.props.get(key);
      if (value !== undefined) o.error(`ChoiceSet() has no property '${key}'.`, value);
    }
    if (ctx.choiceSetConfigError) o.error(ctx.choiceSetConfigError);
    const table = nonEmpty(o, "table");
    const element = nonEmpty(o, "field");
    ctx.dictionary.refer("ChoiceSet", table, o.call.loc, { name: element, location: o.get("field")!.loc });

    const set = ctx.factory.createRecord({
      table: "sys_choice_set",
      source: o.call.loc,
      installCategory: "update",
      emit: false,
      updateName: `sys_choice_${table}_${element}`,
      fields: { name: table, element },
    });
    const create = (loc: FluentValue["loc"], fields: Record<string, FieldValue>): CompiledRecord =>
      ctx.factory.createRecord({
        table: "sys_choice",
        source: loc,
        installCategory: "update",
        emit: false,
        fields: { name: table, element, ...fields },
      });

    const choices = o.get("choices");
    if (choices !== undefined && choices.kind !== "object") return o.error("ChoiceSet(): 'choices' must be an object.", choices);
    [...(choices?.props ?? [])].forEach(([value, choice], idx) => {
      if (choice.kind === "string") {
        set.children.push(
          create(choice.loc, {
            value,
            label: choice.value,
            sequence: idx + 1,
            inactive: false,
            inactive_on_update: false,
            language: ctx.defaultLanguage,
            dependent_value: "",
            synonyms: "",
            hint: "",
          }),
        );
        return;
      }
      const entries = choice.kind === "array" ? choice.items.map((item: FluentValue, i: number) => [item, `choices.${value}[${i}].`] as const) : [[choice, `choices.${value}.`] as const];
      for (const [entry, path] of entries) {
        if (entry.kind !== "object") o.error(`ChoiceSet(): '${path.slice(0, -1)}' must be a string, a choice object or an array of them.`, entry);
        set.children.push(create(entry.loc, { value, ...choiceFields(o, ctx, value, entry, path, choice) }));
      }
    });

    ctx.emitFile(...emitted(ctx, table, set));
    ctx.inspect((records) => {
      const defines = (t: string, keys: Record<string, string>) =>
        records.some((r) => r.table === t && Object.entries(keys).every(([k, v]) => r.fields.get(k) === v));
      if (defines("sys_dictionary", { name: table, element })) {
        ctx.report(
          "error",
          `Field '${element}' is defined on '${table}' which is owned by this project. Use inline choices in the Table API instead of ChoiceSet.`,
          o.call.loc,
        );
      } else if (ctx.scope !== "global" && !defines("sys_db_object", { name: table })) {
        ctx.report(
          "error",
          `ChoiceSet on table '${table}' is not allowed from scoped app '${ctx.scope}'. Only tables defined in your scope are allowed. Create a table in your scope that extends '${table}' and add choices to it.`,
          o.call.loc,
        );
      }
    });
    return set;
  },
};

function emitted(ctx: BuildContext, table: string, set: CompiledRecord): [string, string] {
  // A choice set always has its sys_choice_set record, so the file is always written.
  const file = choiceSetFile({ name: table, scope: ctx.scope, scopeId: ctx.scopeId }, { choices: set.children, choiceSet: set })!;
  return [file.path, file.content];
}
