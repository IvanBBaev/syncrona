// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test() → sys_atf_test, plus one composite sys_atf_step file per step of its
// steps function. A step file writes the step, one sys_variable_value per input
// variable of its step configuration (coalesced on step and variable) and one
// sys_element_mapping per input that refers to an earlier step's output
// (coalesced on step, variable table and field), as the SDK's TestPlugin does.
// Steps the SDK skips (unknown categories and steps) are skipped with the same
// diagnostics; anything the SDK would write as a guess is an error instead.

import type { FluentStep, FluentStepOutput, FluentValue } from "../evaluate";
import { FluentCompileError } from "../diagnostics";
import type { CompiledRecord, FieldValue } from "../record";
import { RecordId } from "../record";
import { formatDuration, type DurationData } from "../time";
import { STEP_CONFIGS, type StepConfig, type StepVariable } from "./atf/stepConfigs";
import { element } from "./list";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** The options every step takes besides its configuration's input variables. */
const STEP_OPTIONS = ["$id", "active", "description", "notes", "timeout", "warning"];
const DURATION_FIELDS = ["days", "hours", "minutes", "seconds"];
/** Input types written as a comma-separated list, the only ones that take an array. */
const LIST_TYPES = new Set(["field_list", "glide_list", "slushbucket"]);
/** Input types written from an object of field values, the only ones that take an object. */
const OBJECT_TYPES = new Set(["simple_name_values", "template_value"]);

interface ResolvedStep {
  step: FluentStep;
  config: StepConfig;
  options: Options;
  record?: CompiledRecord;
}

type Scalar = string | number | boolean;
/** A step input as the SDK serializes it: plain JavaScript values, step outputs as GEM expressions. */
type InputValue = Scalar | Scalar[] | Record<string, Scalar>;

/** The configuration of a step call, or undefined (reported) for a step the SDK skips. */
function stepConfig(ctx: BuildContext, step: FluentStep): { category: string; name: string; config: StepConfig } | undefined {
  const [category, name] = step.path;
  if (!category || !name) {
    ctx.report("hint", "Invalid ATF step", step.loc);
    return undefined;
  }
  const steps = lookup(STEP_CONFIGS, category);
  if (!steps) {
    ctx.report("warning", `Unknown category: ${category}`, step.loc);
    return undefined;
  }
  const config = lookup(steps, name);
  if (!config) {
    ctx.report("warning", `Unknown step: ${name}`, step.loc);
    return undefined;
  }
  return { category, name, config };
}

/** The step's timeout: its configuration's default, or a duration object as a glide_duration value. */
function timeout(o: Options, ctx: BuildContext, config: StepConfig): string | undefined {
  const value = o.get("timeout");
  if (value === undefined) return config.defaultTimeout;
  if (value.kind === "helper" && value.name === "Duration") {
    ctx.report(
      "hint",
      "The SDK writes a Duration() step timeout as an empty timeout; give it as a plain object ({ minutes: 1 }) to set it.",
      value.loc,
    );
    return undefined;
  }
  const d = o.sub(value, "timeout.", DURATION_FIELDS);
  const data: DurationData = {};
  for (const field of DURATION_FIELDS) {
    const n = d.get(field);
    if (n === undefined) continue;
    if (n.kind !== "number") o.error(`fields in Duration object can only contain numbers, got ${n.kind}`, n);
    data[field as keyof DurationData] = n.value;
  }
  return formatDuration(data);
}

/** `{{step['<id>'].<path>}}`, the GEM expression of a step output. */
function gem(ctx: BuildContext, steps: readonly ResolvedStep[], output: FluentStepOutput): string {
  const source = steps.find((s) => s.step === output.step)?.record;
  if (!source) ctx.report("error", "Invalid expression, expecting a reference to an ATF step", output.loc);
  return `{{step['${source?.id.getValue()}'].${output.path.join(".")}}}`;
}

/** A step output or a template of step outputs as its GEM expression; undefined for any other value. */
function gemOf(ctx: BuildContext, steps: readonly ResolvedStep[], value: FluentValue): string | undefined {
  if (value.kind === "stepOutput") return gem(ctx, steps, value);
  if (value.kind === "stepTemplate") return value.head + value.spans.map((s) => gem(ctx, steps, s.output) + s.literal).join("");
  return undefined;
}

/** A record as a reference input stores it: its sys_id, `REL:<sys_id>` for a relationship. */
function referenceValue(record: CompiledRecord): string {
  const id = record.id.getValue();
  return record.table === "sys_relationship" ? `REL:${id}` : id;
}

/** The value of one input variable and whether it refers to an earlier step's output. */
function inputValue(
  o: Options,
  ctx: BuildContext,
  steps: readonly ResolvedStep[],
  key: string,
  variable: StepVariable,
): { value: InputValue | undefined; mapped: boolean } {
  const raw = o.get(key);
  if (raw === undefined) return { value: undefined, mapped: false };
  const name = `${o.call.api}(): '${o.path}${key}'`;
  // An object type's value must be an object: the SDK would write a string as nothing or as garbage.
  if (OBJECT_TYPES.has(variable.type) !== (raw.kind === "object")) {
    o.error(`${name} must ${OBJECT_TYPES.has(variable.type) ? "" : "not "}be an object.`, raw);
  }
  const expression = gemOf(ctx, steps, raw);
  if (expression !== undefined) return { value: expression, mapped: true };
  switch (raw.kind) {
    case "string":
    case "number":
    case "boolean":
      return { value: raw.value, mapped: false };
    case "call":
      return { value: referenceValue(ctx.recordOf(raw)), mapped: false };
    case "array": {
      if (!LIST_TYPES.has(variable.type)) o.error(`${name} must not be an array.`, raw);
      const items = raw.items.map((item) => {
        if (item.kind === "string" || item.kind === "number" || item.kind === "boolean") return item.value;
        if (item.kind === "call") return referenceValue(ctx.recordOf(item));
        return o.error(`${name} must hold strings, numbers, booleans or records.`, item);
      });
      return { value: items, mapped: false };
    }
    case "object": {
      let mapped = false;
      const fields: Record<string, Scalar> = {};
      for (const [field, value] of raw.props) {
        const fieldGem = gemOf(ctx, steps, value);
        mapped ||= fieldGem !== undefined;
        if (fieldGem !== undefined) fields[field] = fieldGem;
        else if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") fields[field] = value.value;
        else o.error(`${o.call.api}(): '${o.path}${key}.${field}' must be a string, number, boolean or step output.`, value);
      }
      return { value: fields, mapped };
    }
    default:
      return o.error(`${name} must be a string, number, boolean, record or step output.`, raw);
  }
}

/** The SDK's `serializeValueToRecord`: an input value as the variable's type stores it. */
function serialize(value: InputValue | undefined, variable: StepVariable): Scalar | undefined {
  const v = value === undefined ? variable.default : value;
  switch (variable.type) {
    case "simple_name_values":
      return v === undefined || Object.keys(v).length === 0 ? "" : JSON.stringify(v);
    case "template_value":
      return (
        v &&
        Object.entries(v)
          .map(([k, x]) => `${k}=${String(x).replaceAll("^", "^^")}`)
          .concat("EQ")
          .join("^")
      );
    case "string":
      return (v as Scalar | undefined) || undefined;
    case "boolean":
      return v ? 1 : 0;
    default:
      // Only list types take an array; any other value is written as it is.
      return Array.isArray(v) ? v.join(",") : (v as Scalar | undefined);
  }
}

function text(value: FieldValue): string {
  if (value === undefined) return "";
  return value instanceof RecordId ? value.getValue() : String(value);
}

/** The fields of a record element after its sys_id, in the order the file writes them. */
function fieldLines(record: CompiledRecord, names: readonly string[], ctx: BuildContext, policy: string | undefined): string[] {
  return [
    ...names.map((name) => element("    ", name, text(record.fields.get(name)))),
    element("    ", "sys_scope", ctx.scopeId),
    element("    ", "sys_update_name", text(record.fields.get("sys_update_name"))),
    ...(policy ? [element("    ", "sys_policy", policy)] : []),
  ];
}

const STEP_FIELDS = ["active", "description", "display_name", "notes", "order", "step_config", "table", "test", "timeout", "warning_message"];
const VARIABLE_FIELDS = ["document", "document_key", "value", "variable", "order"];
const MAPPING_FIELDS = ["field", "id", "table", "value"];
const INSERT = 'action="INSERT_OR_UPDATE" apply_defaults="true"';

/** The composite `sys_atf_step_<id>.xml` file of one step. */
function stepFile(
  step: CompiledRecord,
  variables: readonly CompiledRecord[],
  mappings: readonly CompiledRecord[],
  ctx: BuildContext,
  policy: string | undefined,
): string {
  const id = step.id.getValue();
  const lines = [
    '<?xml version="1.0"?>',
    '<record_update table="sys_atf_step">',
    `  <sys_atf_step ${INSERT}>`,
    element("    ", "sys_id", id),
    element("    ", "sys_scope", ctx.scopeId, { display_value: ctx.scope }),
    ...fieldLines(step, STEP_FIELDS, ctx, policy),
    "  </sys_atf_step>",
    element("  ", "sys_variable_value", "", {
      action: "delete_multiple",
      query: `document_key=${id}`,
    }),
  ];
  for (const variable of variables) {
    lines.push(
      `  <sys_variable_value ${INSERT}>`,
      element("    ", "sys_id", variable.id.getValue()),
      ...fieldLines(variable, VARIABLE_FIELDS, ctx, policy),
      "  </sys_variable_value>",
    );
  }
  if (mappings.length > 0)
    lines.push(
      element("  ", "sys_element_mapping", "", {
        action: "delete_multiple",
        query: `id=${id}`,
      }),
    );
  for (const mapping of mappings) {
    lines.push(
      `  <sys_element_mapping ${INSERT}>`,
      element("    ", "sys_id", mapping.id.getValue()),
      ...fieldLines(mapping, MAPPING_FIELDS, ctx, policy),
      "  </sys_element_mapping>",
    );
  }
  lines.push("</record_update>");
  return lines.join("\n");
}

/** The steps of the steps function, minus the ones the SDK skips. */
function resolveSteps(o: Options, ctx: BuildContext): ResolvedStep[] {
  const fn = o.call.args[1];
  if (fn === undefined) return [];
  if (fn.kind !== "steps") return o.error("Test(): the second argument must be the steps function, (atf) => { ... }.", fn);
  const resolved: ResolvedStep[] = [];
  for (const step of fn.steps) {
    const found = stepConfig(ctx, step);
    if (!found) continue;
    const [arg] = step.args;
    if (step.args.length !== 1) throw new FluentCompileError(`Test(): step '${found.category}.${found.name}' takes one options object.`, step.loc);
    const options = o.sub(arg, `${found.category}.${found.name}.`, [...Object.keys(found.config.variables), ...STEP_OPTIONS]);
    resolved.push({ step, config: found.config, options });
  }
  return resolved;
}

export const test: ArtefactSpec = {
  properties: ["name", "active", "description", "failOnServerError"],
  extraArguments: 1,
  build(o, ctx) {
    const steps = resolveSteps(o, ctx);
    const record = ctx.factory.createRecord({
      table: "sys_atf_test",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        active: o.boolean("active") ?? true,
        description: o.string("description") ?? "",
        fail_on_server_error: o.boolean("failOnServerError") ?? false,
      },
    });
    for (const [index, s] of steps.entries()) {
      const table = s.options.get("table");
      s.record = ctx.factory.createRecord({
        table: "sys_atf_step",
        source: s.step.loc,
        installCategory: o.installCategory,
        explicitId: s.options.explicitId(),
        emit: false,
        fields: {
          active: s.options.boolean("active") ?? true,
          description: s.options.string("description"),
          display_name: s.config.name,
          notes: s.options.string("notes"),
          order: index + 1,
          step_config: s.config.stepConfigId,
          table: table?.kind === "string" ? table.value : undefined,
          test: record,
          timeout: timeout(s.options, ctx, s.config),
          warning_message: s.options.string("warning"),
        },
      });
    }
    const policy = o.protectionPolicy();
    for (const s of steps) {
      const step = s.record!;
      const variables: CompiledRecord[] = [];
      const mappings: CompiledRecord[] = [];
      for (const [key, variable] of Object.entries(s.config.variables)) {
        const { value, mapped } = inputValue(s.options, ctx, steps, key, variable);
        const serialized = serialize(value, variable);
        // The mapping is created first, as the SDK creates it, so new keys come out in the same order.
        if (mapped) {
          mappings.push(
            ctx.factory.createRecord({
              table: "sys_element_mapping",
              source: s.step.loc,
              installCategory: o.installCategory,
              emit: false,
              fields: {
                field: variable.field,
                id: step,
                table: `var__m_atf_input_variable_${s.config.stepConfigId}`,
                value: serialized,
              },
            }),
          );
        }
        variables.push(
          ctx.factory.createRecord({
            table: "sys_variable_value",
            source: s.step.loc,
            installCategory: o.installCategory,
            emit: false,
            fields: {
              document: "sys_atf_step",
              document_key: step,
              value: serialized,
              variable: variable.inputVariableId,
              order: variable.order,
            },
          }),
        );
      }
      record.children.push(step, ...variables, ...mappings);
      ctx.emitFile(`${o.installCategory}/sys_atf_step_${step.id.getValue()}.xml`, stepFile(step, variables, mappings, ctx, policy));
    }
    return record;
  },
};
