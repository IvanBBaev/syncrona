// SPDX-License-Identifier: GPL-3.0-or-later
import { cellText, type FlowRow } from "./flowDocument.js";
import {
  FLOW_PAGE_SIZE,
  readAll,
  SCOPE_NAME,
  SYS_ID,
  type FlowReadClient,
} from "./flowReader.js";
import {
  assembleWorkflowDocument,
  WORKFLOW_VARIABLE_DOCUMENT,
  type WorkflowDocument,
  type WorkflowRows,
} from "./workflowDocument.js";

/**
 * Reads the published version of one legacy Workflow through the Table API.
 * Read-only: nothing here writes to the instance. Runtime tables (`wf_context`,
 * `wf_executing`, `wf_history`, `wf_log`, `wf_transition_history`) are never
 * read; the document describes the definition only.
 */

/** Where each part of a version lives, and the condition that links it to the version. */
export const WORKFLOW_TABLES = {
  stages: { table: "wf_stage", link: "workflow_version" },
  activities: { table: "wf_activity", link: "workflow_version" },
  conditions: { table: "wf_condition", link: "activity.workflow_version" },
  transitions: { table: "wf_transition", link: "from.workflow_version" },
} as const satisfies Record<
  Exclude<
    keyof WorkflowRows,
    "workflow" | "version" | "skippedVersions" | "values"
  >,
  { table: string; link: string }
>;

/** The columns read from `sys_variable_value`, dot-walking to the variable's dictionary entry. */
export const WORKFLOW_VALUE_FIELDS = [
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
export const WORKFLOW_VALUE_CHUNK = 50;

const sysIdsOf = (rows: readonly FlowRow[]): string[] =>
  rows
    .map((row) => row.sys_id)
    .filter((id): id is string => typeof id === "string" && SYS_ID.test(id));

/** The newest published version first; sys_id breaks a tie so the pick is stable. */
function newestFirst(a: FlowRow, b: FlowRow): number {
  const at = cellText(a.sys_updated_on);
  const bt = cellText(b.sys_updated_on);
  if (at !== bt) return at < bt ? 1 : -1;
  const ai = cellText(a.sys_id);
  const bi = cellText(b.sys_id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** Read the rows of the published version of the workflow with the given sys_id. */
export async function readWorkflowRows(
  client: FlowReadClient,
  workflowSysId: string,
  pageSize: number = FLOW_PAGE_SIZE,
): Promise<WorkflowRows> {
  if (!SYS_ID.test(workflowSysId)) {
    throw new Error(
      `"${workflowSysId}" is not a sys_id (32 lowercase hex characters).`,
    );
  }
  const [workflow] = await readAll(
    client,
    "wf_workflow",
    `sys_id=${workflowSysId}`,
    1,
  );
  if (workflow === undefined) {
    throw new Error(`Workflow ${workflowSysId} was not found in wf_workflow.`);
  }
  const published = (
    await readAll(
      client,
      "wf_workflow_version",
      `workflow=${workflowSysId}^published=true`,
      pageSize,
    )
  ).filter((row) => SYS_ID.test(cellText(row.sys_id)));
  if (published.length === 0) {
    throw new Error(
      `Workflow ${workflowSysId} has no published version in wf_workflow_version.`,
    );
  }
  const [version, ...others] = published.sort(newestFirst);
  const versionId = cellText(version.sys_id);

  // Sequential on purpose, as for flows: a parallel burst trips rate limits.
  const parts = {} as Pick<WorkflowRows, keyof typeof WORKFLOW_TABLES>;
  for (const [key, { table, link }] of Object.entries(WORKFLOW_TABLES) as [
    keyof typeof WORKFLOW_TABLES,
    { table: string; link: string },
  ][]) {
    parts[key] = await readAll(client, table, `${link}=${versionId}`, pageSize);
  }

  const ids = sysIdsOf(parts.activities);
  const values: FlowRow[] = [];
  for (let i = 0; i < ids.length; i += WORKFLOW_VALUE_CHUNK) {
    const chunk = ids.slice(i, i + WORKFLOW_VALUE_CHUNK).join(",");
    values.push(
      ...(await readAll(
        client,
        "sys_variable_value",
        `document=${WORKFLOW_VARIABLE_DOCUMENT}^document_keyIN${chunk}`,
        pageSize,
        WORKFLOW_VALUE_FIELDS,
      )),
    );
  }
  const rows: WorkflowRows = { workflow, version, ...parts, values };
  if (others.length > 0)
    rows.skippedVersions = others.map((row) => cellText(row.sys_id));
  return rows;
}

/** Read one workflow and assemble its published version into a document. */
export async function readWorkflowDocument(
  client: FlowReadClient,
  workflowSysId: string,
  pageSize?: number,
): Promise<WorkflowDocument> {
  return assembleWorkflowDocument(
    await readWorkflowRows(client, workflowSysId, pageSize),
  );
}

/** A workflow as listed for a scope: enough to name its file. */
export type WorkflowListing = { sys_id: string; name: string };

/** List the workflows of the application with the given scope name. */
export async function listScopeWorkflows(
  client: FlowReadClient,
  scope: string,
  pageSize: number = FLOW_PAGE_SIZE,
): Promise<WorkflowListing[]> {
  // The scope goes into an encoded query; `^` or `=` in it would add conditions.
  if (!SCOPE_NAME.test(scope))
    throw new Error(`"${scope}" is not a scope name.`);
  const rows = await readAll(
    client,
    "wf_workflow",
    `sys_scope.scope=${scope}`,
    pageSize,
    "sys_id,name",
  );
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return rows
    .map((row) => ({ sys_id: text(row.sys_id), name: text(row.name) }))
    .filter((workflow) => SYS_ID.test(workflow.sys_id));
}
