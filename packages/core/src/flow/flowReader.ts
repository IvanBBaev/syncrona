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
} as const satisfies Record<Exclude<keyof FlowRows, "flow">, { table: string; link: string }>;

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

  // Sequential on purpose: eight small reads, and a parallel burst is what trips
  // instance rate limits first.
  const parts = {} as Omit<FlowRows, "flow">;
  for (const [key, { table, link }] of Object.entries(FLOW_TABLES) as [keyof typeof FLOW_TABLES, { table: string; link: string }][]) {
    parts[key] = await readAll(client, table, `${link}=${flowSysId}`, pageSize);
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
