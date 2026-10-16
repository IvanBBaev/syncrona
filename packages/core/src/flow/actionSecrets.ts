// SPDX-License-Identifier: GPL-3.0-or-later
import type { ActionDocument, ActionStep } from "./actionDocument.js";
import type { FlowRecord } from "./flowDocument.js";
import { FLOW_SECRET_TYPES, redactedMarker, redactRecord } from "./flowSecrets.js";

/**
 * Withholds secret values from an action document, by the rules of
 * redactFlowSecrets. A step's static value (`sys_variable_value`) also loses
 * its `value` when the step input it fills is secret-typed — a REST step's
 * password, say — which the value row names as `variable.internal_type`.
 */

function redactStepValue(record: FlowRecord, warnings: string[]): FlowRecord {
  const type = record.fields["variable.internal_type"];
  if (type === undefined || !FLOW_SECRET_TYPES.has(type) || record.fields.value === undefined) return record;
  warnings.push(`step value ${record.sys_id}: value withheld (${type})`);
  return { ...record, fields: { ...record.fields, value: redactedMarker(type) } };
}

/** A copy of `doc` with secret values replaced by `<redacted:type>`. */
export function redactActionSecrets(doc: ActionDocument): ActionDocument {
  const warnings = [...doc.warnings];
  const records = (rows: FlowRecord[], label: string) => rows.map((row) => redactRecord(row, label, warnings));
  const action = redactRecord(doc.action, "action", warnings);
  const inputs = records(doc.inputs, "input");
  const outputs = records(doc.outputs, "output");
  const steps = doc.steps.map(
    (step): ActionStep => ({
      ...redactRecord(step, "step", warnings),
      inputs: records(step.inputs, "step input"),
      outputs: records(step.outputs, "step output"),
      values: step.values.map((value) => redactStepValue(value, warnings)),
      mappings: step.mappings,
    })
  );
  return {
    ...doc,
    action,
    inputs,
    outputs,
    steps,
    warnings,
  };
}
