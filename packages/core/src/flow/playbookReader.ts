// SPDX-License-Identifier: GPL-3.0-or-later
import type { FlowRow } from "./flowDocument.js";
import { FLOW_PAGE_SIZE, readAll, type FlowReadClient } from "./flowReader.js";
import {
  assemblePlaybookDocument,
  PLAYBOOK_VARIABLE_DOCUMENTS,
  type PlaybookDocument,
  type PlaybookRows,
} from "./playbookDocument.js";

/**
 * Reads every row of one Process Automation Designer playbook through the
 * Table API. Read-only: nothing here writes to the instance. Runtime tables
 * (`*_context`, `*_execution`, `*_log`, execution history) are never read; the
 * document describes the definition only.
 */

/** Where each part of a playbook lives, and the column that links it to the playbook. */
export const PLAYBOOK_TABLES = {
  lanes: { table: "sys_pd_lane", link: "process_definition" },
  activities: { table: "sys_pd_activity", link: "process_definition" },
  triggers: { table: "sys_pd_trigger_instance", link: "process_definition" },
  inputs: { table: "sys_pd_process_input", link: "model" },
  outputs: { table: "sys_pd_process_output", link: "model" },
  variants: { table: "sys_pd_process_variant", link: "process_definition" },
  timers: { table: "sys_pd_timer_attributes", link: "process_definition" },
} as const satisfies Record<Exclude<keyof PlaybookRows, "process" | "values">, { table: string; link: string }>;

/** The columns read from `sys_variable_value`, dot-walking to the variable's dictionary entry. */
export const PLAYBOOK_VALUE_FIELDS = [
  "sys_id",
  "document",
  "document_key",
  "order",
  "value",
  "variable",
  "variable.element",
  "variable.internal_type",
  "variable.name",
].join(",");

/** sys_ids per `document_keyIN` query: keeps the URL far below the 414 limit. */
export const PLAYBOOK_VALUE_CHUNK = 50;

const SYS_ID = /^[0-9a-f]{32}$/;

const sysIdsOf = (rows: readonly FlowRow[]): string[] =>
  rows.map((row) => row.sys_id).filter((id): id is string => typeof id === "string" && SYS_ID.test(id));

async function readValues(
  client: FlowReadClient,
  document: string,
  ids: readonly string[],
  pageSize: number
): Promise<FlowRow[]> {
  const rows: FlowRow[] = [];
  for (let i = 0; i < ids.length; i += PLAYBOOK_VALUE_CHUNK) {
    const chunk = ids.slice(i, i + PLAYBOOK_VALUE_CHUNK).join(",");
    rows.push(
      ...(await readAll(client, "sys_variable_value", `document=${document}^document_keyIN${chunk}`, pageSize, PLAYBOOK_VALUE_FIELDS))
    );
  }
  return rows;
}

/** Read the rows of the playbook with the given sys_id. Throws if it does not exist. */
export async function readPlaybookRows(
  client: FlowReadClient,
  processSysId: string,
  pageSize: number = FLOW_PAGE_SIZE
): Promise<PlaybookRows> {
  if (!SYS_ID.test(processSysId)) {
    throw new Error(`"${processSysId}" is not a sys_id (32 lowercase hex characters).`);
  }
  const [process] = await readAll(client, "sys_pd_process_definition", `sys_id=${processSysId}`, 1);
  if (process === undefined) {
    throw new Error(`Playbook ${processSysId} was not found in sys_pd_process_definition.`);
  }

  // Sequential on purpose, as for flows: a parallel burst trips rate limits.
  const parts = {} as Omit<PlaybookRows, "process" | "values">;
  for (const [key, { table, link }] of Object.entries(PLAYBOOK_TABLES) as [
    keyof typeof PLAYBOOK_TABLES,
    { table: string; link: string },
  ][]) {
    parts[key] = await readAll(client, table, `${link}=${processSysId}`, pageSize);
  }

  const owners: [string, FlowRow[]][] = [
    [PLAYBOOK_VARIABLE_DOCUMENTS.process, [process]],
    [PLAYBOOK_VARIABLE_DOCUMENTS.lanes, parts.lanes],
    [PLAYBOOK_VARIABLE_DOCUMENTS.activities, parts.activities],
    [PLAYBOOK_VARIABLE_DOCUMENTS.triggers, parts.triggers],
  ];
  const values: FlowRow[] = [];
  for (const [document, rows] of owners) values.push(...(await readValues(client, document, sysIdsOf(rows), pageSize)));
  return { process, ...parts, values };
}

/** Read one playbook and assemble it into a document. */
export async function readPlaybookDocument(
  client: FlowReadClient,
  processSysId: string,
  pageSize?: number
): Promise<PlaybookDocument> {
  return assemblePlaybookDocument(await readPlaybookRows(client, processSysId, pageSize));
}
