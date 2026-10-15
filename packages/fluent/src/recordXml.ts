// SPDX-License-Identifier: GPL-3.0-or-later
//
// `record_update` XML serializer.
//
// The files the ServiceNow SDK writes into `dist/app/{scope,update}` — and the
// payloads update sets carry — are `record_update` documents:
//
//   <?xml version="1.0"?>
//   <record_update table="sys_script">
//     <sys_script action="INSERT_OR_UPDATE" apply_defaults="true">
//       <sys_id>…</sys_id>
//       <sys_scope display_value="x_acme_app">…</sys_scope>
//       <script><![CDATA[…]]></script>
//       <condition/>
//     </sys_script>
//   </record_update>
//
// This module emits that shape the way the SDK's xml-js builder does (XML
// declaration without an encoding, two-space indent, self-closing empty
// elements, CDATA only for script-typed fields, `\r` as `&#13;` in text) so
// native output diffs cleanly against SDK output. It deliberately differs in
// two lossy corners of xml-js: a literal `&amp;` in a value is escaped again
// rather than collapsed to `&`, and attribute values escape `&`, `<` and `>`
// as well as `"`, so every document it writes is well-formed. It has no
// parser on purpose: callers that need to read a record use the Table API.

/** One field of a record. A `null`/`undefined`/empty value renders as `<name/>`. */
export interface RecordXmlField {
  name: string;
  value?: string | null;
  /** Rendered as the `display_value` attribute (reference and choice fields). */
  displayValue?: string;
  /**
   * Further attributes in insertion order, after `display_value` — e.g. the
   * coalesce keys the SDK writes on reference fields (`<contains name="itil">`).
   * A `display_value` key here overrides `displayValue`.
   */
  attributes?: Readonly<Record<string, string>>;
  /** Emit the value as a CDATA section, as the SDK does for script-typed fields. */
  cdata?: boolean;
}

export type RecordXmlAction = "INSERT_OR_UPDATE" | "DELETE";

export interface RecordXmlRecord {
  table: string;
  /** Defaults to `INSERT_OR_UPDATE`. */
  action?: RecordXmlAction;
  /** Emits `apply_defaults="true"` on the record element, as the SDK does for its builds. */
  applyDefaults?: boolean;
  fields: readonly RecordXmlField[];
}

/** A `delete_multiple` record: the instance deletes every row of `table` matching `query`. */
export interface RecordXmlDeleteMultiple {
  table: string;
  query: string;
}

const XML_DECLARATION = '<?xml version="1.0"?>';

// XML 1.0 forbids most C0 control characters even when escaped; ServiceNow
// rejects a document carrying one, so they are dropped rather than encoded.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export class RecordXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordXmlError";
  }
}

function checkName(kind: string, name: string): string {
  if (!NAME.test(name)) throw new RecordXmlError(`Invalid ${kind} name for record_update XML: ${JSON.stringify(name)}`);
  return name;
}

function escapeMarkup(value: string): string {
  return value.replace(INVALID_XML_CHARS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape text content: `&`, `<`, `>`, and `\r` as a character reference — XML
 * end-of-line normalization would otherwise turn a literal CR into LF on the
 * next parse.
 */
export function escapeXmlText(value: string): string {
  return escapeMarkup(value).replace(/\r/g, "&#13;");
}

/** Escape an attribute value (double-quoted). */
export function escapeXmlAttribute(value: string): string {
  return escapeMarkup(value).replace(/"/g, "&quot;");
}

/** Wrap in CDATA, splitting any `]]>` across two sections so the terminator never closes early. */
export function cdataSection(value: string): string {
  return `<![CDATA[${value.replace(INVALID_XML_CHARS, "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function renderField(field: RecordXmlField): string {
  const name = checkName("field", field.name);
  const pairs: Record<string, string> = {};
  if (field.displayValue !== undefined) pairs.display_value = field.displayValue;
  Object.assign(pairs, field.attributes);
  const attrs = Object.entries(pairs)
    .map(([key, value]) => ` ${checkName("attribute", key)}="${escapeXmlAttribute(value)}"`)
    .join("");
  const value = field.value ?? "";
  if (value === "") return `<${name}${attrs}/>`;
  const body = field.cdata ? cdataSection(value) : escapeXmlText(value);
  return `<${name}${attrs}>${body}</${name}>`;
}

/** Serialize one record as a `record_update` document (no trailing newline, like the SDK). */
export function serializeRecordUpdate(record: RecordXmlRecord): string {
  const table = checkName("table", record.table);
  const action = record.action ?? "INSERT_OR_UPDATE";
  const defaults = record.applyDefaults ? ' apply_defaults="true"' : "";
  const lines = [
    XML_DECLARATION,
    `<record_update table="${table}">`,
    `  <${table} action="${action}"${defaults}>`,
    ...record.fields.map((field) => `    ${renderField(field)}`),
    `  </${table}>`,
    "</record_update>",
  ];
  return lines.join("\n");
}

/** Serialize a `delete_multiple` record_update. */
export function serializeDeleteMultiple(record: RecordXmlDeleteMultiple): string {
  const table = checkName("table", record.table);
  return [
    XML_DECLARATION,
    `<record_update table="${table}">`,
    `  <${table} action="delete_multiple" query="${escapeXmlAttribute(record.query)}"/>`,
    "</record_update>",
  ].join("\n");
}
