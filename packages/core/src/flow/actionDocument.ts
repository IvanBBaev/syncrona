// SPDX-License-Identifier: GPL-3.0-or-later
import {
  byCodeUnit,
  byOrder,
  cellText,
  CHILD_LIFTED,
  FLOW_PAYLOAD_COLUMNS,
  parseOrder,
  sortKeys,
  toRecord,
  type FlowRecord,
  type FlowRow,
} from "./flowDocument.js";

/**
 * Assembles the rows Flow Designer stores for one custom action into a single
 * document that can be written as `<action>.action.json` and diffed in git.
 *
 * An action (`sys_hub_action_type_definition`) keeps its inputs and outputs in
 * `sys_hub_action_input` / `sys_hub_action_output` (linked by `model`) and its
 * steps in `sys_hub_step_instance` (linked by `action`). Each step carries:
 *
 *   - the inputs and outputs the action author added to it
 *     (`sys_hub_step_ext_input` / `sys_hub_step_ext_output`, linked by `model`),
 *   - its static input values — a Script step's script, a Create Record step's
 *     table — in `sys_variable_value` (`document_key` = the step), and
 *   - its data-pill input mappings in `sys_element_mapping` (`id` = the step).
 *
 * The action's own output mappings (`{{step[<cid>].x}}`) are `sys_element_mapping`
 * rows with `id` = the action. Like the flow document, this one is lossless for
 * everything except audit stamps, pure, and never throws: rows that do not fit
 * are reported in `warnings`.
 */

export const ACTION_DOCUMENT_SCHEMA = "syncrona.action/1";

/** Every row of one action, as read from the instance. */
export type ActionRows = {
  action: FlowRow;
  inputs: FlowRow[];
  outputs: FlowRow[];
  outputMappings: FlowRow[];
  steps: FlowRow[];
  stepInputs: FlowRow[];
  stepOutputs: FlowRow[];
  stepValues: FlowRow[];
  stepMappings: FlowRow[];
};

export type ActionStep = FlowRecord & {
  order: number | null;
  inputs: FlowRecord[];
  outputs: FlowRecord[];
  values: FlowRecord[];
  mappings: FlowRecord[];
};

export type ActionDocument = {
  schema: typeof ACTION_DOCUMENT_SCHEMA;
  action: FlowRecord;
  inputs: FlowRecord[];
  outputs: FlowRecord[];
  outputMappings: FlowRecord[];
  steps: ActionStep[];
  warnings: string[];
};

/** The action row's `label_cache` holds JSON; the flow payload columns may appear too. */
const ACTION_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set([...FLOW_PAYLOAD_COLUMNS, "label_cache"]);

const STEP_LIFTED = new Set(["sys_id", "order", "action"]);
const VALUE_LIFTED = new Set(["sys_id", "document", "document_key"]);
const MAPPING_LIFTED = new Set(["sys_id", "id"]);

type Keyed = { order: number | null; ties: string[]; record: FlowRecord };

function sortKeyed(entries: Keyed[]): FlowRecord[] {
  return entries
    .sort((a, b) => {
      const order = byOrder(a.order, b.order);
      if (order !== 0) return order;
      for (let i = 0; i < a.ties.length; i++) {
        const tie = byCodeUnit(a.ties[i], b.ties[i]);
        if (tie !== 0) return tie;
      }
      return byCodeUnit(a.record.sys_id, b.record.sys_id);
    })
    .map((entry) => entry.record);
}

function records(
  rows: readonly FlowRow[],
  lifted: ReadonlySet<string>,
  ties: readonly string[],
  warnings: string[],
  label: string
): FlowRecord[] {
  return sortKeyed(
    rows.map((row) => ({
      order: parseOrder(row.order),
      ties: ties.map((column) => cellText(row[column])),
      record: toRecord(row, lifted, warnings, `${label} ${cellText(row.sys_id)}`),
    }))
  );
}

/** Group `rows` by the step their `link` column names; rows naming no step are reported. */
function byStep(
  rows: readonly FlowRow[],
  link: string,
  steps: ReadonlySet<string>,
  warnings: string[],
  label: string
): Map<string, FlowRow[]> {
  const groups = new Map<string, FlowRow[]>();
  for (const row of rows) {
    const step = cellText(row[link]);
    if (!steps.has(step)) {
      warnings.push(`${label} ${cellText(row.sys_id)} names step ${step || "(none)"}, which is not a step of this action; left out`);
      continue;
    }
    const group = groups.get(step);
    if (group === undefined) groups.set(step, [row]);
    else group.push(row);
  }
  return groups;
}

/** Assemble the rows of one action into a document. Pure; never throws. */
export function assembleActionDocument(rows: ActionRows): ActionDocument {
  const warnings: string[] = [];
  const action = toRecord(rows.action, new Set(["sys_id"]), warnings, "action", ACTION_PAYLOAD_COLUMNS);
  const stepIds = new Set(rows.steps.map((row) => cellText(row.sys_id)));
  const inputsOf = byStep(rows.stepInputs, "model", stepIds, warnings, "step input");
  const outputsOf = byStep(rows.stepOutputs, "model", stepIds, warnings, "step output");
  const valuesOf = byStep(rows.stepValues, "document_key", stepIds, warnings, "step value");
  const mappingsOf = byStep(rows.stepMappings, "id", stepIds, warnings, "step mapping");

  const steps = rows.steps
    .map((row): ActionStep => {
      const sysId = cellText(row.sys_id);
      const children = (groups: Map<string, FlowRow[]>) => groups.get(sysId) ?? [];
      return {
        ...toRecord(row, STEP_LIFTED, warnings, `step ${sysId}`),
        order: parseOrder(row.order),
        inputs: records(children(inputsOf), CHILD_LIFTED, ["element"], warnings, "step input"),
        outputs: records(children(outputsOf), CHILD_LIFTED, ["element"], warnings, "step output"),
        values: records(children(valuesOf), VALUE_LIFTED, ["variable.element", "variable"], warnings, "step value"),
        mappings: records(children(mappingsOf), MAPPING_LIFTED, ["table", "field"], warnings, "step mapping"),
      };
    })
    .sort(
      (a, b) =>
        byOrder(a.order, b.order) ||
        byCodeUnit(a.fields.cid ?? "", b.fields.cid ?? "") ||
        byCodeUnit(a.sys_id, b.sys_id)
    );

  return {
    schema: ACTION_DOCUMENT_SCHEMA,
    action,
    inputs: records(rows.inputs, CHILD_LIFTED, ["element"], warnings, "input"),
    outputs: records(rows.outputs, CHILD_LIFTED, ["element"], warnings, "output"),
    outputMappings: records(rows.outputMappings, MAPPING_LIFTED, ["table", "field"], warnings, "output mapping"),
    steps,
    warnings,
  };
}

/** Serialize deterministically, the way serializeFlowDocument does. */
export function serializeActionDocument(doc: ActionDocument): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}
