// SPDX-License-Identifier: GPL-3.0-or-later
import type { FlowDocument, FlowPayload, FlowRecord, FlowStep } from "./flowDocument.js";

/**
 * Withholds secret values from a flow document before it reaches the working
 * tree. A flow input, output or variable whose `internal_type` is a secret type
 * loses its `default_value`, and inside decoded payloads every object that says
 * it is secret-typed (`type` / `internal_type`, directly or on its `parameter`)
 * loses its value columns. A `sys_variable_value` input of the older step model
 * loses its `value` when the input it fills (`variable.internal_type`) is
 * secret-typed. Each redaction is listed in the document's `warnings`.
 *
 * The rule can only see what the rows say: a step input whose type is defined on
 * the action (not in the step's payload) carries no type here. Documents are
 * read-only and never pushed, so a redacted value costs nothing on the way back.
 */

/** The dictionary types that hold a credential (see UNSAFE_VALUE_INTERNAL_TYPES). */
export const FLOW_SECRET_TYPES: ReadonlySet<string> = new Set([
  "password",
  "password2",
  "glide_encrypted",
  "encrypted_text",
  "masked",
]);

const VALUE_KEYS = ["value", "displayValue", "display_value", "default_value"];

export const redactedMarker = (type: string): string => `<redacted:${type}>`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function secretTypeOf(node: Record<string, unknown>): string | undefined {
  const parameter = isObject(node.parameter) ? node.parameter : {};
  for (const candidate of [node.type, node.internal_type, parameter.type, parameter.internal_type]) {
    if (typeof candidate === "string" && FLOW_SECRET_TYPES.has(candidate)) return candidate;
  }
  return undefined;
}

function redactValue(value: unknown, count: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, count));
  if (!isObject(value)) return value;
  const type = secretTypeOf(value);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (type !== undefined && VALUE_KEYS.includes(key) && inner !== "" && inner != null) {
      out[key] = redactedMarker(type);
      count.n++;
    } else {
      out[key] = redactValue(inner, count);
    }
  }
  return out;
}

export function redactRecord<T extends FlowRecord>(record: T, label: string, warnings: string[]): T {
  let fields = record.fields;
  const type = fields.internal_type;
  if (FLOW_SECRET_TYPES.has(type) && fields.default_value !== undefined) {
    fields = { ...fields, default_value: redactedMarker(type) };
    warnings.push(`${label} ${record.sys_id}: default_value withheld (${type})`);
  }
  let payloads = record.payloads;
  if (payloads !== undefined) {
    const next: Record<string, FlowPayload> = {};
    for (const [column, payload] of Object.entries(payloads)) {
      // An undecoded payload is raw text with no structure to read a type from.
      if (payload.format === "unknown") {
        next[column] = payload;
        continue;
      }
      const count = { n: 0 };
      const value = redactValue(payload.value, count);
      next[column] = count.n > 0 ? { ...payload, value } : payload;
      if (count.n > 0) warnings.push(`${label} ${record.sys_id}: ${count.n} secret value(s) withheld from ${column}`);
    }
    payloads = next;
  }
  const variableValues = record.variableValues?.map((entry) => {
    const inputType = entry.fields["variable.internal_type"];
    if (!FLOW_SECRET_TYPES.has(inputType) || entry.fields.value === undefined) return entry;
    const name = entry.fields["variable.element"] ?? entry.fields.variable ?? entry.sys_id;
    warnings.push(`${label} ${record.sys_id}: input ${name} withheld (${inputType})`);
    return { ...entry, fields: { ...entry.fields, value: redactedMarker(inputType) } };
  });
  return {
    ...record,
    fields,
    ...(payloads !== undefined ? { payloads } : {}),
    ...(variableValues !== undefined ? { variableValues } : {}),
  };
}

function redactSteps(steps: FlowStep[], warnings: string[]): FlowStep[] {
  return steps.map((step) => ({
    ...redactRecord(step, step.kind, warnings),
    children: redactSteps(step.children, warnings),
  }));
}

/** A copy of `doc` with secret values replaced by `<redacted:type>`. */
export function redactFlowSecrets(doc: FlowDocument): FlowDocument {
  const warnings = [...doc.warnings];
  const records = (rows: FlowRecord[], label: string) => rows.map((row) => redactRecord(row, label, warnings));
  return {
    ...doc,
    flow: redactRecord(doc.flow, "flow", warnings),
    triggers: records(doc.triggers, "trigger"),
    inputs: records(doc.inputs, "input"),
    outputs: records(doc.outputs, "output"),
    variables: records(doc.variables, "variable"),
    stages: records(doc.stages, "stage"),
    steps: redactSteps(doc.steps, warnings),
    warnings,
  };
}
