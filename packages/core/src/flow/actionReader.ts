// SPDX-License-Identifier: GPL-3.0-or-later
import { assembleActionDocument, type ActionDocument, type ActionRows } from "./actionDocument.js";
import type { FlowRow } from "./flowDocument.js";
import {
  FLOW_PAGE_SIZE,
  readAll,
  SCOPE_NAME,
  SYS_ID,
  VARIABLE_VALUE_KEYS_PER_QUERY,
  type FlowListing,
  type FlowReadClient,
} from "./flowReader.js";

/**
 * Reads every row of one custom Flow Designer action through the Table API.
 * Read-only, like the flow reader: nothing here writes to the instance.
 */

export const ACTION_TABLE = "sys_hub_action_type_definition";

/** The `sys_variable_value` columns read, with the step-input definition each value fills. */
export const STEP_VALUE_FIELDS =
  "sys_id,document,document_key,order,value,variable,variable.element,variable.internal_type";

/** Read the rows of the action with the given sys_id. Throws if it does not exist. */
export async function readActionRows(
  client: FlowReadClient,
  actionSysId: string,
  pageSize: number = FLOW_PAGE_SIZE
): Promise<ActionRows> {
  if (!SYS_ID.test(actionSysId)) {
    throw new Error(`"${actionSysId}" is not a sys_id (32 lowercase hex characters).`);
  }
  const [action] = await readAll(client, ACTION_TABLE, `sys_id=${actionSysId}`, 1);
  if (action === undefined) throw new Error(`Action ${actionSysId} was not found in ${ACTION_TABLE}.`);

  // Sequential on purpose, as in readFlowRows.
  const inputs = await readAll(client, "sys_hub_action_input", `model=${actionSysId}`, pageSize);
  const outputs = await readAll(client, "sys_hub_action_output", `model=${actionSysId}`, pageSize);
  // The action's own output mappings. Rows on `var__m_sys_hub_action_input_*`
  // map an action instance's inputs inside a flow and are not part of the action.
  const outputMappings = await readAll(
    client,
    "sys_element_mapping",
    `id=${actionSysId}^tableSTARTSWITHvar__m_sys_hub_action_output_`,
    pageSize
  );
  const steps = await readAll(client, "sys_hub_step_instance", `action=${actionSysId}`, pageSize);
  const stepIds = steps.map((row) => row.sys_id).filter((id): id is string => typeof id === "string" && SYS_ID.test(id));
  const none: FlowRow[] = [];
  if (stepIds.length === 0) {
    return { action, inputs, outputs, outputMappings, steps, stepInputs: none, stepOutputs: none, stepValues: none, stepMappings: none };
  }
  // An action with many steps would make one IN list longer than a URL may be,
  // so the step ids go out in batches, as in readFlowRows.
  const byStep = async (table: string, condition: string, fields?: string): Promise<FlowRow[]> => {
    const out: FlowRow[] = [];
    for (let i = 0; i < stepIds.length; i += VARIABLE_VALUE_KEYS_PER_QUERY) {
      const ids = stepIds.slice(i, i + VARIABLE_VALUE_KEYS_PER_QUERY).join(",");
      out.push(...(await readAll(client, table, `${condition}${ids}`, pageSize, fields)));
    }
    return out;
  };
  return {
    action,
    inputs,
    outputs,
    outputMappings,
    steps,
    stepInputs: await byStep("sys_hub_step_ext_input", "modelIN"),
    stepOutputs: await byStep("sys_hub_step_ext_output", "modelIN"),
    stepValues: await byStep("sys_variable_value", "document=sys_hub_step_instance^document_keyIN", STEP_VALUE_FIELDS),
    stepMappings: await byStep("sys_element_mapping", "idIN"),
  };
}

/** Read one action and assemble it into a document. */
export async function readActionDocument(
  client: FlowReadClient,
  actionSysId: string,
  pageSize?: number
): Promise<ActionDocument> {
  return assembleActionDocument(await readActionRows(client, actionSysId, pageSize));
}

/** List the custom actions of the application with the given scope name. */
export async function listScopeActions(
  client: FlowReadClient,
  scope: string,
  pageSize: number = FLOW_PAGE_SIZE
): Promise<FlowListing[]> {
  if (!SCOPE_NAME.test(scope)) throw new Error(`"${scope}" is not a scope name.`);
  const rows = await readAll(client, ACTION_TABLE, `sys_scope.scope=${scope}`, pageSize, "sys_id,name,internal_name");
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return rows
    .map((row) => ({ sys_id: text(row.sys_id), name: text(row.name), internal_name: text(row.internal_name) }))
    .filter((action) => SYS_ID.test(action.sys_id));
}
