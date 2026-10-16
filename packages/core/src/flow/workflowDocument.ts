// SPDX-License-Identifier: GPL-3.0-or-later
import { byCodeUnit, byOrder, cellText, parseOrder, toRecord, type FlowRecord, type FlowRow } from "./flowDocument.js";
import { FLOW_SECRET_TYPES, redactedMarker, redactPayloads } from "./flowSecrets.js";

/**
 * WP2f: one legacy Workflow (`wf_workflow`) as a single diffable document,
 * built from its published version (`wf_workflow_version`). Read-only, like the
 * flow and playbook documents: nothing reads it back.
 *
 * An activity's `vars` column is a `glide_var` and comes back empty from the
 * Table API. Its values live in `sys_variable_value` with `document=wf_activity`
 * and `document_key=<activity sys_id>`; the document attaches them to their
 * activity as `variables`. Conditions are nested under the activity they leave
 * from; transitions and stages are listed for the version.
 *
 * Secrets never reach the document: a variable value whose type is a secret
 * type, and a secret-typed value inside a decoded payload, becomes
 * `<redacted:type>`, and each one is listed in `warnings`.
 */

export const WORKFLOW_DOCUMENT_SCHEMA = "syncrona.workflow/1";

/** The rows of one workflow's published version, as read from the instance. */
export type WorkflowRows = {
  workflow: FlowRow;
  version: FlowRow;
  /** sys_ids of further published versions the reader passed over. */
  skippedVersions?: string[];
  stages: FlowRow[];
  activities: FlowRow[];
  conditions: FlowRow[];
  transitions: FlowRow[];
  /**
   * `sys_variable_value` rows of the activities, with the dot-walked
   * `variable.element`, `variable.internal_type` and `variable.name` columns.
   */
  values: FlowRow[];
};

/** One `sys_variable_value` of an activity, named by its dictionary entry. */
export type WorkflowVariable = {
  element: string;
  /** The variable's model, e.g. `var__m_<activity definition sys_id>`. */
  model: string;
  /** sys_id of the variable's dictionary entry. */
  variable: string;
  type: string;
  order: number | null;
  value: string;
};

export type WorkflowRecord = FlowRecord;

export type WorkflowActivity = WorkflowRecord & {
  variables?: WorkflowVariable[];
  conditions: WorkflowRecord[];
};

export type WorkflowDocument = {
  schema: typeof WORKFLOW_DOCUMENT_SCHEMA;
  workflow: WorkflowRecord;
  version: WorkflowRecord;
  stages: WorkflowRecord[];
  activities: WorkflowActivity[];
  transitions: WorkflowRecord[];
  /** Conditions whose activity is not an activity of this version. */
  unassigned: WorkflowRecord[];
  warnings: string[];
};

/** The table whose rows carry `glide_var` values in `sys_variable_value`. */
export const WORKFLOW_VARIABLE_DOCUMENT = "wf_activity";

/** Columns known to hold a JSON payload. */
export const WORKFLOW_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set(["activity_stages", "input"]);

const WORKFLOW_LIFTED = new Set(["sys_id"]);
const VERSION_LIFTED = new Set(["sys_id", "workflow"]);
const CHILD_LIFTED = new Set(["sys_id", "workflow_version"]);
const CONDITION_LIFTED = new Set(["sys_id", "activity"]);
const TRANSITION_LIFTED = new Set(["sys_id"]);

function toVariable(row: FlowRow): WorkflowVariable {
  return {
    element: cellText(row["variable.element"]),
    model: cellText(row["variable.name"]),
    variable: cellText(row.variable),
    type: cellText(row["variable.internal_type"]),
    order: parseOrder(row.order),
    value: cellText(row.value),
  };
}

function compareVariables(a: WorkflowVariable, b: WorkflowVariable): number {
  return (
    byCodeUnit(a.model, b.model) ||
    byOrder(a.order, b.order) ||
    byCodeUnit(a.element, b.element) ||
    byCodeUnit(a.variable, b.variable) ||
    byCodeUnit(a.value, b.value)
  );
}

/** The activities' `sys_variable_value` rows grouped by `document_key`. */
function groupValues(values: readonly FlowRow[]): Map<string, WorkflowVariable[]> {
  const groups = new Map<string, WorkflowVariable[]>();
  for (const row of values) {
    if (cellText(row.document) !== WORKFLOW_VARIABLE_DOCUMENT) continue;
    const key = cellText(row.document_key);
    const group = groups.get(key) ?? [];
    group.push(toVariable(row));
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort(compareVariables);
  return groups;
}

function redactVariables(variables: WorkflowVariable[], label: string, warnings: string[]): WorkflowVariable[] {
  return variables.map((variable) => {
    if (!FLOW_SECRET_TYPES.has(variable.type) || variable.value === "") return variable;
    warnings.push(`${label}: ${variable.element || variable.variable} withheld (${variable.type})`);
    return { ...variable, value: redactedMarker(variable.type) };
  });
}

type Sortable<T> = { keys: (number | null | string)[]; record: T };

function compareKeys(a: (number | null | string)[], b: (number | null | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const diff = typeof x === "string" || typeof y === "string" ? byCodeUnit(String(x), String(y)) : byOrder(x, y);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sortRecords<T extends { sys_id: string }>(entries: Sortable<T>[]): T[] {
  return entries
    .sort((a, b) => compareKeys(a.keys, b.keys) || byCodeUnit(a.record.sys_id, b.record.sys_id))
    .map((entry) => entry.record);
}

const record = (row: FlowRow, lifted: ReadonlySet<string>, warnings: string[], label: string): WorkflowRecord => {
  const name = `${label} ${cellText(row.sys_id)}`;
  const result = toRecord(row, lifted, warnings, name, WORKFLOW_PAYLOAD_COLUMNS);
  // Decoded payloads (an activity's `input`, gzip columns) can carry secret-typed values too.
  if (result.payloads !== undefined) result.payloads = redactPayloads(result.payloads, name, warnings);
  return result;
};

/** Assemble the rows of one workflow version into a document. Pure; never throws. */
export function assembleWorkflowDocument(rows: WorkflowRows): WorkflowDocument {
  const warnings: string[] = [];
  const groups = groupValues(rows.values);

  const workflow = record(rows.workflow, WORKFLOW_LIFTED, warnings, "workflow");
  const version = record(rows.version, VERSION_LIFTED, warnings, "version");
  for (const skipped of rows.skippedVersions ?? []) {
    warnings.push(`version ${skipped} is published too; the document shows version ${version.sys_id}`);
  }

  const activities: WorkflowActivity[] = sortRecords(
    rows.activities.map((row) => {
      const base = record(row, CHILD_LIFTED, warnings, "activity");
      const activity: WorkflowActivity = { ...base, conditions: [] };
      const variables = groups.get(base.sys_id);
      if (variables !== undefined) activity.variables = redactVariables(variables, `activity ${base.sys_id}`, warnings);
      return { keys: [cellText(row.name)], record: activity };
    })
  );
  const activityById = new Map(activities.map((activity) => [activity.sys_id, activity]));

  const placed = new Map<WorkflowActivity | undefined, Sortable<WorkflowRecord>[]>();
  for (const row of rows.conditions) {
    const condition = record(row, CONDITION_LIFTED, warnings, "condition");
    const activityId = cellText(row.activity);
    const activity = activityById.get(activityId);
    if (activity === undefined) {
      warnings.push(
        activityId === ""
          ? `condition ${condition.sys_id} has no activity; listed under unassigned`
          : `condition ${condition.sys_id} names activity ${activityId}, which is not an activity of this version; listed under unassigned`
      );
      // The activity it names is kept, so the document still shows where it pointed.
      if (activityId !== "") condition.fields.activity = activityId;
    }
    const list = placed.get(activity) ?? [];
    list.push({
      keys: [parseOrder(row.order), cellText(row.name)],
      record: condition,
    });
    placed.set(activity, list);
  }
  for (const activity of activities) activity.conditions = sortRecords(placed.get(activity) ?? []);

  const start = version.fields.start;
  if (start !== undefined && !activityById.has(start)) {
    warnings.push(`version ${version.sys_id} starts at activity ${start}, which is not an activity of this version`);
  }

  const transitions = sortRecords(
    rows.transitions.map((row) => {
      const transition = record(row, TRANSITION_LIFTED, warnings, "transition");
      for (const end of ["from", "to"] as const) {
        const target = transition.fields[end];
        if (target === undefined || !activityById.has(target)) {
          warnings.push(
            `transition ${transition.sys_id}: ${end} ${target === undefined ? "is empty" : `names activity ${target}, which is not an activity of this version`}`
          );
        }
      }
      return {
        keys: [cellText(row.from), cellText(row.to), cellText(row.condition)],
        record: transition,
      };
    })
  );

  return {
    schema: WORKFLOW_DOCUMENT_SCHEMA,
    workflow,
    version,
    stages: sortRecords(
      rows.stages.map((row) => ({
        keys: [parseOrder(row.order), cellText(row.name)],
        record: record(row, CHILD_LIFTED, warnings, "stage"),
      }))
    ),
    activities,
    transitions,
    unassigned: sortRecords(placed.get(undefined) ?? []),
    warnings,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a document deterministically: keys sorted by code unit, array order
 * kept, two-space indent, trailing newline.
 */
export function serializeWorkflowDocument(doc: WorkflowDocument): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}
