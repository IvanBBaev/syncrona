// SPDX-License-Identifier: GPL-3.0-or-later
import type { FlowPayload, FlowRow } from "./flowDocument.js";
import { FLOW_SECRET_TYPES, redactedMarker, redactPayloads, withholdColumn } from "./flowSecrets.js";
import { detectFlowValues, GZIP_BASE64_PREFIX } from "./flowValues.js";

/**
 * WP2c: one Process Automation Designer playbook (`sys_pd_process_definition`)
 * as a single diffable document. Read-only, like the flow document: nothing
 * reads it back.
 *
 * A playbook's `glide_var` columns (`launcher_inputs`, a lane's
 * `start_rule_vars`, an activity's `inputs` / `outputs` / `type_vals`, a
 * trigger's `trigger_inputs` / `playbook_inputs`) come back empty from the
 * Table API. Their values live in `sys_variable_value`, keyed by `document`
 * (the table) and `document_key` (the row); the document attaches them to their
 * row as `variables`.
 *
 * Secrets never reach the document: a variable value or a process input
 * `default_value` whose type is a secret type becomes `<redacted:type>`, and
 * each one is listed in `warnings`.
 */

export const PLAYBOOK_DOCUMENT_SCHEMA = "syncrona.playbook/1";

/** The rows of one playbook, as read from the instance. */
export type PlaybookRows = {
  process: FlowRow;
  lanes: FlowRow[];
  activities: FlowRow[];
  triggers: FlowRow[];
  inputs: FlowRow[];
  outputs: FlowRow[];
  variants: FlowRow[];
  timers: FlowRow[];
  /**
   * `sys_variable_value` rows of the process, its lanes, activities and
   * triggers, with the dot-walked `variable.element`, `variable.internal_type`
   * and `variable.name` columns.
   */
  values: FlowRow[];
};

/** One `sys_variable_value` of a row, named by its dictionary entry. */
export type PlaybookVariable = {
  element: string;
  /** The variable's model, e.g. `var__m_sys_pd_activity_type_prop_<sys_id>`. */
  model: string;
  /** sys_id of the variable's dictionary entry. */
  variable: string;
  type: string;
  order: number | null;
  value: string;
};

export type PlaybookRecord = {
  sys_id: string;
  fields: Record<string, string>;
  payloads?: Record<string, FlowPayload>;
  variables?: PlaybookVariable[];
};

export type PlaybookLane = PlaybookRecord & { order: number | null; activities: PlaybookRecord[] };

export type PlaybookDocument = {
  schema: typeof PLAYBOOK_DOCUMENT_SCHEMA;
  process: PlaybookRecord;
  triggers: PlaybookRecord[];
  inputs: PlaybookRecord[];
  outputs: PlaybookRecord[];
  variants: PlaybookRecord[];
  timers: PlaybookRecord[];
  lanes: PlaybookLane[];
  /** Activities whose lane is not a lane of this playbook. */
  unassigned: PlaybookRecord[];
  warnings: string[];
};

/** The tables whose rows carry `glide_var` values in `sys_variable_value`. */
export const PLAYBOOK_VARIABLE_DOCUMENTS = {
  process: "sys_pd_process_definition",
  lanes: "sys_pd_lane",
  activities: "sys_pd_activity",
  triggers: "sys_pd_trigger_instance",
} as const satisfies Partial<Record<keyof PlaybookRows, string>>;

/** Columns known to hold a JSON payload. */
export const PLAYBOOK_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set(["designer_state", "permission"]);

const AUDIT_COLUMNS = new Set([
  "sys_created_by",
  "sys_created_on",
  "sys_mod_count",
  "sys_tags",
  "sys_updated_by",
  "sys_updated_on",
]);

const PROCESS_LIFTED = new Set(["sys_id"]);
const CHILD_LIFTED = new Set(["sys_id", "process_definition", "model"]);
const LANE_LIFTED = new Set([...CHILD_LIFTED, "order"]);
const ACTIVITY_LIFTED = new Set([...CHILD_LIFTED, "lane"]);

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const inner = (value as { value?: unknown }).value;
    return inner == null ? "" : String(inner);
  }
  return String(value);
}

function parseOrder(value: unknown): number | null {
  const text = cellText(value).trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// By UTF-16 code unit, not by locale: the output must not depend on ICU data.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byOrder(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function toVariable(row: FlowRow): PlaybookVariable {
  return {
    element: cellText(row["variable.element"]),
    model: cellText(row["variable.name"]),
    variable: cellText(row.variable),
    type: cellText(row["variable.internal_type"]),
    order: parseOrder(row.order),
    value: cellText(row.value),
  };
}

function compareVariables(a: PlaybookVariable, b: PlaybookVariable): number {
  return (
    byCodeUnit(a.model, b.model) ||
    byOrder(a.order, b.order) ||
    byCodeUnit(a.element, b.element) ||
    byCodeUnit(a.variable, b.variable) ||
    byCodeUnit(a.value, b.value)
  );
}

/** `sys_variable_value` rows grouped by `<document>:<document_key>`. */
function groupValues(values: readonly FlowRow[]): Map<string, PlaybookVariable[]> {
  const groups = new Map<string, PlaybookVariable[]>();
  for (const row of values) {
    const key = `${cellText(row.document)}:${cellText(row.document_key)}`;
    const group = groups.get(key) ?? [];
    group.push(toVariable(row));
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort(compareVariables);
  return groups;
}

function redactVariables(variables: PlaybookVariable[], label: string, warnings: string[]): PlaybookVariable[] {
  return variables.map((variable) => {
    if (!FLOW_SECRET_TYPES.has(variable.type) || variable.value === "") return variable;
    warnings.push(`${label}: ${variable.element || variable.variable} withheld (${variable.type})`);
    return { ...variable, value: redactedMarker(variable.type) };
  });
}

type RecordContext = {
  lifted: ReadonlySet<string>;
  document?: string;
  groups: Map<string, PlaybookVariable[]>;
  warnings: string[];
  label: string;
};

function toRecord(row: FlowRow, ctx: RecordContext): PlaybookRecord {
  const sysId = cellText(row.sys_id);
  const label = `${ctx.label} ${sysId}`;
  const fields: Record<string, string> = {};
  const payloads: Record<string, FlowPayload> = {};
  for (const [column, raw] of Object.entries(row)) {
    if (ctx.lifted.has(column) || AUDIT_COLUMNS.has(column)) continue;
    const text = cellText(raw);
    if (text === "") continue;
    const known = PLAYBOOK_PAYLOAD_COLUMNS.has(column);
    if (!known && !text.startsWith(GZIP_BASE64_PREFIX)) {
      fields[column] = text;
      continue;
    }
    const detected = detectFlowValues(text);
    if (detected.decoded) {
      payloads[column] = { format: detected.format, value: detected.value };
    } else if (known) {
      payloads[column] = { format: "unknown", value: text, reason: detected.reason };
      ctx.warnings.push(`${label}: ${column} could not be decoded (${detected.reason})`);
    } else {
      fields[column] = text;
    }
  }
  let record: PlaybookRecord = { sys_id: sysId, fields };
  if (Object.keys(payloads).length > 0) record.payloads = payloads;
  const type = fields.internal_type;
  const withheld = type !== undefined && FLOW_SECRET_TYPES.has(type) ? withholdColumn(record, "default_value", type) : undefined;
  if (withheld !== undefined) {
    record = withheld;
    ctx.warnings.push(`${label}: default_value withheld (${type})`);
  }
  if (record.payloads !== undefined) record.payloads = redactPayloads(record.payloads, label, ctx.warnings);
  if (ctx.document !== undefined) {
    const variables = ctx.groups.get(`${ctx.document}:${sysId}`);
    if (variables !== undefined) record.variables = redactVariables(variables, label, ctx.warnings);
  }
  return record;
}

type Sortable<T> = { order: number | null; tie: string; record: T };

function sortRecords<T extends { sys_id: string }>(entries: Sortable<T>[]): T[] {
  return entries
    .sort((a, b) => byOrder(a.order, b.order) || byCodeUnit(a.tie, b.tie) || byCodeUnit(a.record.sys_id, b.record.sys_id))
    .map((entry) => entry.record);
}

function sortedRecords(rows: readonly FlowRow[], tieColumn: string, ctx: Omit<RecordContext, "lifted">): PlaybookRecord[] {
  return sortRecords(
    rows.map((row) => ({
      order: parseOrder(row.order),
      tie: cellText(row[tieColumn]),
      record: toRecord(row, { ...ctx, lifted: CHILD_LIFTED }),
    }))
  );
}

/** Assemble the rows of one playbook into a document. Pure; never throws. */
export function assemblePlaybookDocument(rows: PlaybookRows): PlaybookDocument {
  const warnings: string[] = [];
  const groups = groupValues(rows.values);
  const docs = PLAYBOOK_VARIABLE_DOCUMENTS;

  const process = toRecord(rows.process, { lifted: PROCESS_LIFTED, document: docs.process, groups, warnings, label: "process" });

  const lanes: PlaybookLane[] = sortRecords(
    rows.lanes.map((row) => {
      const order = parseOrder(row.order);
      const record = toRecord(row, { lifted: LANE_LIFTED, document: docs.lanes, groups, warnings, label: "lane" });
      return { order, tie: cellText(row.name), record: { ...record, order, activities: [] as PlaybookRecord[] } };
    })
  );
  const laneById = new Map(lanes.map((lane) => [lane.sys_id, lane]));

  const placed = new Map<PlaybookLane | undefined, Sortable<PlaybookRecord>[]>();
  for (const row of rows.activities) {
    const record = toRecord(row, { lifted: ACTIVITY_LIFTED, document: docs.activities, groups, warnings, label: "activity" });
    const laneId = cellText(row.lane);
    const lane = laneById.get(laneId);
    if (lane === undefined) {
      warnings.push(
        laneId === ""
          ? `activity ${record.sys_id} has no lane; listed under unassigned`
          : `activity ${record.sys_id} names lane ${laneId}, which is not a lane of this playbook; listed under unassigned`
      );
      // The lane it names is kept, so the document still shows where it pointed.
      if (laneId !== "") record.fields.lane = laneId;
    }
    const list = placed.get(lane) ?? [];
    list.push({ order: parseOrder(row.order), tie: cellText(row.label), record });
    placed.set(lane, list);
  }
  for (const lane of lanes) lane.activities = sortRecords(placed.get(lane) ?? []);

  return {
    schema: PLAYBOOK_DOCUMENT_SCHEMA,
    process,
    triggers: sortedRecords(rows.triggers, "name", { document: docs.triggers, groups, warnings, label: "trigger" }),
    inputs: sortedRecords(rows.inputs, "element", { groups, warnings, label: "input" }),
    outputs: sortedRecords(rows.outputs, "element", { groups, warnings, label: "output" }),
    variants: sortedRecords(rows.variants, "name", { groups, warnings, label: "variant" }),
    timers: sortedRecords(rows.timers, "sys_id", { groups, warnings, label: "timer" }),
    lanes,
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
export function serializePlaybookDocument(doc: PlaybookDocument): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}
