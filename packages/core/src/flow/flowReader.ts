// SPDX-License-Identifier: GPL-3.0-or-later
import { withStableOrder } from "../manifestBuilder.js";
import { NonApiResponseError, type SNClient } from "../snClient.js";
import { assembleFlowDocument, type FlowDocument, type FlowRow, type FlowRows } from "./flowDocument.js";

/**
 * Reads every row of one Flow Designer flow through the Table API. Read-only:
 * nothing here writes to the instance. Flows are written through an
 * application install, never by patching these tables row by row.
 */

export type FlowReadClient = Pick<SNClient, "tableAPIGet">;

/** Where each part of a flow lives, and the column that links it to the flow. */
export const FLOW_TABLES = {
  triggers: { table: "sys_hub_trigger_instance_v2", link: "flow" },
  actions: { table: "sys_hub_action_instance_v2", link: "flow" },
  logic: { table: "sys_hub_flow_logic_instance_v2", link: "flow" },
  subflows: { table: "sys_hub_sub_flow_instance_v2", link: "flow" },
  inputs: { table: "sys_hub_flow_input", link: "model" },
  outputs: { table: "sys_hub_flow_output", link: "model" },
  variables: { table: "sys_hub_flow_variable", link: "model" },
  stages: { table: "sys_hub_flow_stage", link: "flow" },
} as const satisfies Record<Exclude<keyof FlowRows, "flow" | "variableValues">, { table: string; link: string }>;

/**
 * The tables of the older step model, linked by `flow` as well. Older flows
 * (many shipped ones among them) have rows only here. A migrated flow keeps
 * its pre-migration rows here too, as stale copies of its v2 rows with the
 * same ui_ids, so the older tables are read only where the v2 ones are empty:
 * the trigger on its own, and the steps (actions, logic, subflows) as a group,
 * since one flow's steps share one tree.
 */
export const LEGACY_FLOW_TABLES = {
  triggers: "sys_hub_trigger_instance",
  actions: "sys_hub_action_instance",
  logic: "sys_hub_flow_logic",
  subflows: "sys_hub_sub_flow_instance",
} as const satisfies Partial<Record<keyof typeof FLOW_TABLES, string>>;

/**
 * The columns read from `sys_variable_value`, the inputs of the older model.
 * The dot-walked input name and type travel with each value so a secret-typed
 * input can be withheld without another read.
 */
export const VARIABLE_VALUE_FIELDS =
  "sys_id,document,document_key,order,value,variable,variable.element,variable.internal_type";

/** How many owner sys_ids one `sys_variable_value` query names, to keep URLs short. */
export const VARIABLE_VALUE_KEYS_PER_QUERY = 100;

export const FLOW_PAGE_SIZE = 500;
export const FLOW_MAX_PAGES = 1000;

const READ_PARAMS = { params: { sysparm_exclude_reference_link: "true" } };
export const SYS_ID = /^[0-9a-f]{32}$/;

function totalCount(headers: unknown): number | undefined {
  const raw = (headers as Record<string, unknown> | null | undefined)?.["x-total-count"];
  const total = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isSafeInteger(total) ? total : undefined;
}

export async function readAll(
  client: FlowReadClient,
  table: string,
  query: string,
  pageSize: number,
  fields = ""
): Promise<FlowRow[]> {
  const ordered = withStableOrder(query);
  const rows: FlowRow[] = [];
  for (let page = 0; page < FLOW_MAX_PAGES; page++) {
    const resp = await client.tableAPIGet(table, ordered, fields, pageSize, rows.length, READ_PARAMS);
    const data: unknown = resp.data;
    const result = (data as { result?: unknown } | null)?.result;
    if (!Array.isArray(result)) {
      const contentType = resp.headers?.["content-type"];
      const snippet = typeof data === "string" ? data.slice(0, 120).replace(/\s+/g, " ").trim() : "";
      throw new NonApiResponseError(typeof contentType === "string" ? contentType : undefined, snippet);
    }
    rows.push(...(result as FlowRow[]));
    const total = totalCount(resp.headers);
    if (result.length === 0 || (total !== undefined && rows.length >= total)) return rows;
  }
  throw new Error(
    `Reading ${table} did not finish within ${FLOW_MAX_PAGES} pages of ${pageSize} rows; ` +
      "the instance may be ignoring sysparm_offset."
  );
}

/** Read the rows of the flow with the given sys_id. Throws if it does not exist. */
export async function readFlowRows(
  client: FlowReadClient,
  flowSysId: string,
  pageSize: number = FLOW_PAGE_SIZE
): Promise<FlowRows> {
  if (!SYS_ID.test(flowSysId)) {
    throw new Error(`"${flowSysId}" is not a sys_id (32 lowercase hex characters).`);
  }
  const [flow] = await readAll(client, "sys_hub_flow", `sys_id=${flowSysId}`, 1);
  if (flow === undefined) throw new Error(`Flow ${flowSysId} was not found in sys_hub_flow.`);

  // Sequential on purpose: a dozen small reads, and a parallel burst is what
  // trips instance rate limits first.
  const parts = {} as Required<Omit<FlowRows, "flow">>;
  for (const [key, { table, link }] of Object.entries(FLOW_TABLES) as [keyof typeof FLOW_TABLES, { table: string; link: string }][]) {
    parts[key] = await readAll(client, table, `${link}=${flowSysId}`, pageSize);
  }
  parts.variableValues = [];
  const v2Steps = parts.actions.length + parts.logic.length + parts.subflows.length;
  for (const [key, table] of Object.entries(LEGACY_FLOW_TABLES) as [keyof typeof LEGACY_FLOW_TABLES, string][]) {
    if (key === "triggers" ? parts.triggers.length > 0 : v2Steps > 0) continue;
    const legacy = await readAll(client, table, `flow=${flowSysId}`, pageSize);
    if (legacy.length === 0) continue;
    parts[key] = legacy;
    // The ids go into an encoded query; only well-formed sys_ids may.
    const owners = legacy.map((row) => row.sys_id).filter((id): id is string => typeof id === "string" && SYS_ID.test(id));
    for (let i = 0; i < owners.length; i += VARIABLE_VALUE_KEYS_PER_QUERY) {
      const keys = owners.slice(i, i + VARIABLE_VALUE_KEYS_PER_QUERY).join(",");
      parts.variableValues.push(
        ...(await readAll(client, "sys_variable_value", `document=${table}^document_keyIN${keys}`, pageSize, VARIABLE_VALUE_FIELDS))
      );
    }
  }
  return { flow, ...parts };
}

/** Read one flow and assemble it into a document. */
export async function readFlowDocument(
  client: FlowReadClient,
  flowSysId: string,
  pageSize?: number
): Promise<FlowDocument> {
  return assembleFlowDocument(await readFlowRows(client, flowSysId, pageSize));
}

/** A flow or subflow as listed for a scope: enough to name its file. */
export type FlowListing = { sys_id: string; name: string; internal_name: string };

export const SCOPE_NAME = /^[A-Za-z0-9_]+$/;

/** List the flows and subflows of the application with the given scope name. */
export async function listScopeFlows(
  client: FlowReadClient,
  scope: string,
  pageSize: number = FLOW_PAGE_SIZE
): Promise<FlowListing[]> {
  // The scope goes into an encoded query; `^` or `=` in it would add conditions.
  if (!SCOPE_NAME.test(scope)) throw new Error(`"${scope}" is not a scope name.`);
  const rows = await readAll(client, "sys_hub_flow", `sys_scope.scope=${scope}`, pageSize, "sys_id,name,internal_name");
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return rows
    .map((row) => ({ sys_id: text(row.sys_id), name: text(row.name), internal_name: text(row.internal_name) }))
    .filter((flow) => SYS_ID.test(flow.sys_id));
}
