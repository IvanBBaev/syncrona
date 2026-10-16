// SPDX-License-Identifier: GPL-3.0-or-later
import { detectFlowValues, GZIP_BASE64_PREFIX, type FlowValuesFormat } from "./flowValues.js";

/**
 * Assembles the rows Flow Designer stores for one flow into a single document
 * that can be written as `<flow>.flow.json` and diffed in git.
 *
 * The definition is spread over several tables: the `sys_hub_flow` row itself,
 * one row per trigger, action, logic and subflow step (`*_instance_v2`), and the
 * flow's inputs, outputs, variables and stages. Steps form a tree through
 * `ui_id` / `parent_ui_id`, ordered by `order`. The payload columns of those rows
 * (`values`, `trigger_inputs`, ...) are decoded so the document shows the
 * configuration, not a base64 blob.
 *
 * The document is lossless for everything except audit stamps: every other
 * non-empty column is kept, and each payload records the format it was stored
 * in, so a later writer can encode it back. Assembly is pure and never throws;
 * anything that does not fit (a missing parent, a cycle, an undecodable payload)
 * is kept in the document and reported in `warnings`.
 */

export const FLOW_DOCUMENT_SCHEMA = "syncrona.flow/1";

/** A Table API row; values are strings, or `{ value }` for references. */
export type FlowRow = Record<string, unknown>;

/** Every row of one flow, as read from the instance. */
export type FlowRows = {
  flow: FlowRow;
  triggers: FlowRow[];
  actions: FlowRow[];
  logic: FlowRow[];
  subflows: FlowRow[];
  inputs: FlowRow[];
  outputs: FlowRow[];
  variables: FlowRow[];
  stages: FlowRow[];
};

/** A decoded payload column. An undecodable one keeps its raw text in `value`. */
export type FlowPayload = { format: FlowValuesFormat; value: unknown; reason?: string };

export type FlowRecord = {
  sys_id: string;
  fields: Record<string, string>;
  payloads?: Record<string, FlowPayload>;
};

export type FlowStepKind = "action" | "logic" | "subflow";

export type FlowStep = FlowRecord & {
  kind: FlowStepKind;
  ui_id: string;
  order: number | null;
  children: FlowStep[];
};

export type FlowDocument = {
  schema: typeof FLOW_DOCUMENT_SCHEMA;
  flow: FlowRecord;
  triggers: FlowRecord[];
  inputs: FlowRecord[];
  outputs: FlowRecord[];
  variables: FlowRecord[];
  stages: FlowRecord[];
  steps: FlowStep[];
  warnings: string[];
};

/** Columns that change on every save without changing the flow. */
const AUDIT_COLUMNS = new Set([
  "sys_created_by",
  "sys_created_on",
  "sys_mod_count",
  "sys_tags",
  "sys_updated_by",
  "sys_updated_on",
]);

/** Columns known to hold a JSON or base64 + gzip JSON payload. */
export const FLOW_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set([
  "flow_variables_assigned",
  "outputs_assigned",
  "subflow_inputs",
  "trigger_inputs",
  "values",
]);

/** Columns lifted out of `fields` on a step, or redundant with the document. */
const STEP_LIFTED = new Set(["sys_id", "ui_id", "parent_ui_id", "order", "flow"]);
const CHILD_LIFTED = new Set(["sys_id", "flow", "model"]);

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const inner = (value as { value?: unknown }).value;
    return inner == null ? "" : String(inner);
  }
  return String(value);
}

function toRecord(row: FlowRow, lifted: ReadonlySet<string>, warnings: string[], label: string): FlowRecord {
  const fields: Record<string, string> = {};
  const payloads: Record<string, FlowPayload> = {};
  for (const [column, raw] of Object.entries(row)) {
    if (lifted.has(column) || AUDIT_COLUMNS.has(column)) continue;
    const text = cellText(raw);
    if (text === "") continue;
    const known = FLOW_PAYLOAD_COLUMNS.has(column);
    if (!known && !text.startsWith(GZIP_BASE64_PREFIX)) {
      fields[column] = text;
      continue;
    }
    const detected = detectFlowValues(text);
    if (detected.decoded) {
      payloads[column] = { format: detected.format, value: detected.value };
    } else if (known) {
      payloads[column] = { format: "unknown", value: text, reason: detected.reason };
      warnings.push(`${label}: ${column} could not be decoded (${detected.reason})`);
    } else {
      // An ordinary column that merely starts like gzip; keep it as text.
      fields[column] = text;
    }
  }
  const record: FlowRecord = { sys_id: cellText(row.sys_id), fields };
  if (Object.keys(payloads).length > 0) record.payloads = payloads;
  return record;
}

function parseOrder(value: unknown): number | null {
  const text = cellText(value).trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Sorting by UTF-16 code unit, not by locale: the output must not depend on the
// ICU data of the Node.js that generated it.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byOrder(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareSteps(a: FlowStep, b: FlowStep): number {
  return byOrder(a.order, b.order) || byCodeUnit(a.ui_id, b.ui_id) || byCodeUnit(a.sys_id, b.sys_id);
}

function sortedRecords(rows: readonly FlowRow[], tieColumn: string, warnings: string[], label: string): FlowRecord[] {
  return rows
    .map((row) => ({
      order: parseOrder(row.order),
      tie: cellText(row[tieColumn]),
      record: toRecord(row, CHILD_LIFTED, warnings, `${label} ${cellText(row.sys_id)}`),
    }))
    .sort(
      (a, b) => byOrder(a.order, b.order) || byCodeUnit(a.tie, b.tie) || byCodeUnit(a.record.sys_id, b.record.sys_id)
    )
    .map((entry) => entry.record);
}

function sortTree(steps: FlowStep[]): void {
  steps.sort(compareSteps);
  for (const step of steps) sortTree(step.children);
}

// Every step has at most one parent and roots have none, so a walk from the
// roots visits each reachable step exactly once.
function collectReachable(roots: readonly FlowStep[], seen: Set<FlowStep>): void {
  const stack = [...roots];
  while (stack.length > 0) {
    const step = stack.pop() as FlowStep;
    seen.add(step);
    stack.push(...step.children);
  }
}

function buildStepTree(rows: FlowRows, warnings: string[]): FlowStep[] {
  const kinds: [FlowStepKind, FlowRow[]][] = [
    ["action", rows.actions],
    ["logic", rows.logic],
    ["subflow", rows.subflows],
  ];
  const all: { step: FlowStep; parent: string }[] = [];
  for (const [kind, kindRows] of kinds) {
    for (const row of kindRows) {
      const sysId = cellText(row.sys_id);
      const record = toRecord(row, STEP_LIFTED, warnings, `${kind} ${sysId}`);
      const step: FlowStep = { kind, ui_id: cellText(row.ui_id), order: parseOrder(row.order), ...record, children: [] };
      all.push({ step, parent: cellText(row.parent_ui_id) });
    }
  }

  const byUiId = new Map<string, FlowStep>();
  for (const { step } of all) {
    if (step.ui_id === "") {
      warnings.push(`${step.kind} ${step.sys_id} has no ui_id; placed at the top level`);
    } else if (byUiId.has(step.ui_id)) {
      warnings.push(`${step.kind} ${step.sys_id} repeats ui_id ${step.ui_id}; placed at the top level`);
    } else {
      byUiId.set(step.ui_id, step);
    }
  }

  const roots: FlowStep[] = [];
  const parentOf = new Map<FlowStep, FlowStep>();
  for (const { step, parent } of all) {
    // A step without a usable ui_id was already reported above.
    if (parent === "" || byUiId.get(step.ui_id) !== step) {
      roots.push(step);
      continue;
    }
    const owner = byUiId.get(parent);
    if (owner === undefined || owner === step) {
      warnings.push(
        owner === step
          ? `${step.kind} ${step.sys_id} is its own parent; placed at the top level`
          : `${step.kind} ${step.sys_id} names parent ${parent}, which is not a step of this flow; placed at the top level`
      );
      roots.push(step);
      continue;
    }
    owner.children.push(step);
    parentOf.set(step, owner);
  }

  // Steps whose parents form a cycle are reachable from no root. Lift them one
  // at a time (in sorted order, so the choice is deterministic) until none are
  // left, cutting each from its parent so the tree stays finite.
  for (;;) {
    const seen = new Set<FlowStep>();
    collectReachable(roots, seen);
    const stranded = all.map((entry) => entry.step).filter((step) => !seen.has(step));
    if (stranded.length === 0) break;
    const lifted = stranded.sort(compareSteps)[0];
    const owner = parentOf.get(lifted) as FlowStep;
    owner.children.splice(owner.children.indexOf(lifted), 1);
    parentOf.delete(lifted);
    roots.push(lifted);
    warnings.push(`${lifted.kind} ${lifted.sys_id} is part of a parent cycle; placed at the top level`);
  }

  sortTree(roots);
  return roots;
}

/** Assemble the rows of one flow into a document. Pure; never throws. */
export function assembleFlowDocument(rows: FlowRows): FlowDocument {
  const warnings: string[] = [];
  const flow = toRecord(rows.flow, new Set(["sys_id"]), warnings, "flow");
  const triggers = sortedRecords(rows.triggers, "ui_id", warnings, "trigger");
  const steps = buildStepTree(rows, warnings);
  return {
    schema: FLOW_DOCUMENT_SCHEMA,
    flow,
    triggers,
    inputs: sortedRecords(rows.inputs, "element", warnings, "input"),
    outputs: sortedRecords(rows.outputs, "element", warnings, "output"),
    variables: sortedRecords(rows.variables, "element", warnings, "variable"),
    stages: sortedRecords(rows.stages, "value", warnings, "stage"),
    steps,
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
 * Serialize a document deterministically: object keys sorted by code unit,
 * array order kept, two-space indent, trailing newline. The same flow always
 * produces the same bytes, so a diff shows only real changes.
 */
export function serializeFlowDocument(doc: FlowDocument): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}
