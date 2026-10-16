// SPDX-License-Identifier: GPL-3.0-or-later
import { FLOW_DOCUMENT_SCHEMA, type FlowDocument, type FlowRecord, type FlowStep } from "./flowDocument.js";
import { FLOW_TABLES, LEGACY_FLOW_TABLES } from "./flowReader.js";
import { encodeFlowValues } from "./flowValues.js";

/**
 * Turns a flow document back into the table rows it was assembled from: the
 * reverse of `assembleFlowDocument`, for the WP2 write path. Each row comes out
 * as a `record_update`-shaped record (`table`, `action`, `fields`), which the
 * `@syncrona/fluent` `serializeRecordUpdate` accepts as is, so a package can be
 * built and installed through the native engine. Nothing here talks to an
 * instance.
 *
 * Lifted columns are restored from the document's structure (`flow` / `model`
 * from the flow's sys_id, `parent_ui_id` from a step's place in the tree) and
 * every payload is encoded back in the format it was read in. Audit stamps were
 * never kept and are not written. The flow's snapshot (`latest_snapshot`) is
 * passed through unchanged; regenerating it is the install's job.
 *
 * A trigger or step of the older step model goes back to its own table (named
 * by its `sys_class_name`), and its `variableValues` come out as
 * `sys_variable_value` rows owned by it. Their dot-walked columns
 * (`variable.element`, ...) were read for display and are not written.
 *
 * A document is refused, with every problem listed, when writing it back would
 * lose data: a `<redacted:…>` placeholder would overwrite the real secret, and a
 * step that assembly had to move to the top level no longer says where it
 * belongs.
 */

export type FlowRecordField = { name: string; value: string };

export type FlowRecordUpdate = {
  table: string;
  sys_id: string;
  action: "INSERT_OR_UPDATE" | "DELETE";
  fields: FlowRecordField[];
};

export class FlowEncodeError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The flow document cannot be written back:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "FlowEncodeError";
  }
}

const SYS_ID = /^[0-9a-f]{32}$/;
const REDACTED = /^<redacted:[^>]*>$/;
/** The phrase `assembleFlowDocument` uses when it re-parents a step. */
const RELOCATED = "placed at the top level";

const STEP_TABLES: Record<FlowStep["kind"], string> = {
  action: FLOW_TABLES.actions.table,
  logic: FLOW_TABLES.logic.table,
  subflow: FLOW_TABLES.subflows.table,
};

type Row = { table: string; label: string; record: FlowRecord; lifted: Record<string, string> };

const LEGACY_TABLES: ReadonlySet<string> = new Set(Object.values(LEGACY_FLOW_TABLES));

/** The table a trigger or step was read from: its older-model table, or the v2 one. */
function tableOf(record: FlowRecord, v2Table: string): string {
  const name = record.fields.sys_class_name;
  return name !== undefined && LEGACY_TABLES.has(name) ? name : v2Table;
}

function pushWithValues(rows: Row[], row: Row): void {
  rows.push(row);
  for (const value of row.record.variableValues ?? []) {
    const fields = Object.fromEntries(Object.entries(value.fields).filter(([name]) => !name.includes(".")));
    rows.push({
      table: "sys_variable_value",
      label: "input",
      record: { ...value, fields },
      lifted: { document: row.table, document_key: row.record.sys_id },
    });
  }
}

function collectRows(doc: FlowDocument): Row[] {
  const flowId = doc.flow.sys_id;
  const rows: Row[] = [{ table: "sys_hub_flow", label: "flow", record: doc.flow, lifted: {} }];
  const children = (key: Exclude<keyof typeof FLOW_TABLES, "triggers" | "actions" | "logic" | "subflows">, records: FlowRecord[]) => {
    const { table, link } = FLOW_TABLES[key];
    for (const record of records) rows.push({ table, label: key, record, lifted: { [link]: flowId } });
  };
  for (const record of doc.triggers) {
    const table = tableOf(record, FLOW_TABLES.triggers.table);
    pushWithValues(rows, { table, label: "triggers", record, lifted: { flow: flowId } });
  }
  const walk = (steps: FlowStep[], parent: string) => {
    for (const step of steps) {
      const lifted = {
        flow: flowId,
        ui_id: step.ui_id,
        parent_ui_id: parent,
        order: step.order === null ? "" : String(step.order),
      };
      pushWithValues(rows, { table: tableOf(step, STEP_TABLES[step.kind]), label: step.kind, record: step, lifted });
      walk(step.children, step.ui_id);
    }
  };
  walk(doc.steps, "");
  children("inputs", doc.inputs);
  children("outputs", doc.outputs);
  children("variables", doc.variables);
  children("stages", doc.stages);
  return rows;
}

function findRedacted(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (REDACTED.test(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => findRedacted(item, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) findRedacted(inner, `${path}.${key}`, out);
  }
}

function encodeRow(row: Row, problems: string[]): Map<string, string> {
  const { record } = row;
  const where = `${row.label} ${record.sys_id}`;
  const columns = new Map<string, string>();
  for (const [name, value] of Object.entries(record.fields)) columns.set(name, value);
  for (const [column, payload] of Object.entries(record.payloads ?? {})) {
    if (payload.format === "unknown") {
      if (typeof payload.value === "string") columns.set(column, payload.value);
      else problems.push(`${where}: ${column} is an undecoded payload but its value is not the raw text`);
      continue;
    }
    if (payload.value === undefined && payload.format !== "empty") {
      problems.push(`${where}: ${column} has no value`);
      continue;
    }
    // The value came from JSON.parse, so it always stringifies.
    columns.set(column, encodeFlowValues(payload.value, payload.format));
  }
  for (const [name, value] of Object.entries(row.lifted)) columns.set(name, value);
  const redacted: string[] = [];
  for (const [name, value] of Object.entries(record.fields)) findRedacted(value, name, redacted);
  for (const [column, payload] of Object.entries(record.payloads ?? {})) findRedacted(payload.value, column, redacted);
  for (const path of redacted) problems.push(`${where}: ${path} holds a redacted placeholder, not the value`);
  return columns;
}

type Encoded = { row: Row; columns: Map<string, string> };

function encodeDocument(doc: FlowDocument, problems: string[]): Map<string, Encoded> {
  if (doc.schema !== FLOW_DOCUMENT_SCHEMA) {
    problems.push(`schema is "${String(doc.schema)}", expected "${FLOW_DOCUMENT_SCHEMA}"`);
    return new Map();
  }
  for (const warning of doc.warnings) {
    if (warning.includes(RELOCATED)) problems.push(`its original parent is unknown: ${warning}`);
  }
  const encoded = new Map<string, Encoded>();
  for (const row of collectRows(doc)) {
    const id = row.record.sys_id;
    if (!SYS_ID.test(id)) {
      problems.push(`${row.label} "${id}" does not have a sys_id (32 lowercase hex characters)`);
      continue;
    }
    if (encoded.has(id)) {
      problems.push(`${row.label} ${id} appears more than once`);
      continue;
    }
    encoded.set(id, { row, columns: encodeRow(row, problems) });
  }
  return encoded;
}

function toUpdate({ row, columns }: Encoded, cleared: readonly string[] = []): FlowRecordUpdate {
  const names = [...new Set([...columns.keys(), ...cleared])].sort(); // default sort compares UTF-16 code units, independent of locale
  return {
    table: row.table,
    sys_id: row.record.sys_id,
    action: "INSERT_OR_UPDATE",
    fields: [
      { name: "sys_id", value: row.record.sys_id },
      ...names.map((name) => ({ name, value: columns.get(name) ?? "" })),
    ],
  };
}

/**
 * Every row of the flow as a record, in document order: the flow, triggers,
 * steps depth-first, then inputs, outputs, variables and stages. Fields are
 * sorted by name after `sys_id`. Throws `FlowEncodeError` instead of returning
 * records that would lose data.
 */
export function flowDocumentRecords(doc: FlowDocument): FlowRecordUpdate[] {
  const problems: string[] = [];
  const encoded = encodeDocument(doc, problems);
  if (problems.length > 0) throw new FlowEncodeError(problems);
  return [...encoded.values()].map((entry) => toUpdate(entry));
}

/**
 * The records that turn `base` into `edited`: a changed or new row comes out
 * whole, with a column that `edited` no longer has written as empty, and a row
 * that `edited` dropped comes out as a `DELETE`. Unchanged rows are left out,
 * so only the rows being written need to be free of redacted placeholders.
 * Throws `FlowEncodeError` when either document is unusable, or when the two
 * are different flows.
 */
export function flowDocumentChanges(base: FlowDocument, edited: FlowDocument): FlowRecordUpdate[] {
  const baseProblems: string[] = [];
  const before = encodeDocument(base, baseProblems);
  const problems = baseProblems
    .filter((problem) => !problem.includes("redacted placeholder"))
    .map((problem) => `base: ${problem}`);
  const editedProblems: string[] = [];
  const after = encodeDocument(edited, editedProblems);
  if (base.flow.sys_id !== edited.flow.sys_id) {
    problems.push(`base is flow ${base.flow.sys_id} but the edited document is flow ${edited.flow.sys_id}`);
  }

  const updates: FlowRecordUpdate[] = [];
  const changed = new Set<string>();
  for (const [id, entry] of after) {
    const previous = before.get(id);
    if (previous !== undefined && previous.row.table !== entry.row.table) {
      problems.push(`${entry.row.label} ${id} moved from ${previous.row.table} to ${entry.row.table}`);
      continue;
    }
    const cleared = previous === undefined ? [] : [...previous.columns.keys()].filter((name) => !entry.columns.has(name));
    const same =
      previous !== undefined &&
      cleared.length === 0 &&
      [...entry.columns].every(([name, value]) => previous.columns.get(name) === value);
    if (same) continue;
    changed.add(id);
    updates.push(toUpdate(entry, cleared));
  }
  // A placeholder only matters in a row that is about to be written.
  for (const problem of editedProblems) {
    const id = /^\S+ ([0-9a-f]{32}): .*redacted placeholder/.exec(problem)?.[1];
    if (id === undefined || changed.has(id)) problems.push(problem);
  }
  for (const [id, { row }] of before) {
    if (!after.has(id)) {
      updates.push({ table: row.table, sys_id: id, action: "DELETE", fields: [{ name: "sys_id", value: id }] });
    }
  }
  if (problems.length > 0) throw new FlowEncodeError(problems);
  return updates;
}
