// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Native table type generation for `syncrona fluent types --native` (SDK-F3).
 *
 * Builds a `.d.ts` that describes the records of a scope's tables, read straight
 * from the Table API, so `fluent types` works without the optional
 * `@servicenow/sdk` peer:
 *
 * - `sys_db_object` gives the tables of the scope (or the tables named with
 *   `--table`) and, through `super_class`, every ancestor they extend. Ancestors
 *   are generated too, wherever they live, so the output compiles on its own.
 * - `sys_dictionary` gives each table's own columns (the inherited ones are
 *   reached through `extends`).
 * - `sys_choice` turns choice columns into literal unions, including a child
 *   table's override of an inherited column's choices.
 *
 * The output is written from scratch from instance metadata; nothing in it is
 * derived from the SDK's own type files (see docs/PROVENANCE.md). It is
 * deterministic: tables, columns and choice values are sorted, and the header
 * carries no timestamp or instance name, so regenerating an unchanged scope
 * produces a byte-identical file and a clean diff.
 *
 * Reads are paged with a stable `ORDERBYsys_id` (see `withStableOrder`) and
 * `nameIN` lists are chunked so a large table set never builds an oversized URL.
 * A page shorter than the requested size does not end a read: an instance may
 * cap the page size below it, so paging stops at `X-Total-Count` when the
 * response carries it, and otherwise at the first empty page.
 */
import { withStableOrder } from "./manifestBuilder.js";
import { NonApiResponseError, type SNClient } from "./snClient.js";

export type NativeTypesClient = Pick<SNClient, "tableAPIGet">;

export interface NativeTypesOptions {
  /** Scope whose tables are generated; ignored when `tables` is non-empty. */
  scope?: string;
  /** Explicit table names; generated with their ancestors instead of the scope's tables. */
  tables?: string[];
  /** Rows per Table API page (default 500). */
  pageSize?: number;
  /** Names per `nameIN` clause (default 100). */
  chunkSize?: number;
}

/** Dictionary `choice` values: 0 none, 1 dropdown with --None--, 2 suggestion, 3 dropdown without --None--. */
export type ChoiceMode = "0" | "1" | "2" | "3";

export interface NativeField {
  element: string;
  label: string;
  internalType: string;
  reference?: string;
  mandatory: boolean;
  choice: ChoiceMode;
  maxLength?: number;
}

export interface NativeTable {
  name: string;
  label: string;
  scope?: string;
  superClass?: string;
  fields: NativeField[];
  /** Choice values per element, for this table's own and inherited columns. */
  choices: Record<string, string[]>;
}

export interface NativeSchema {
  scope?: string;
  /** Tables the request asked for (the scope's, or `--table`), sorted. */
  requested: string[];
  /** Every table to generate (requested plus ancestors), sorted by name. */
  tables: NativeTable[];
}

export interface NativeTypesResult {
  content: string;
  tableCount: number;
  fieldCount: number;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CHUNK_SIZE = 100;
/** Pages one read may take before it is treated as an instance that ignores `sysparm_offset`. */
export const MAX_PAGES = 10_000;

// Plain values instead of `{link, value}` objects for reference columns.
const READ_PARAMS = { params: { sysparm_exclude_reference_link: "true" } };

type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "value" in (value as Row)) return text((value as Row).value);
  return String(value).trim();
}

// Sorting by UTF-16 code unit, not by locale: the output must not depend on the
// ICU data of the Node.js that generated it.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function totalCount(headers: unknown): number | undefined {
  const raw = (headers as Record<string, unknown> | null | undefined)?.["x-total-count"];
  const total = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isSafeInteger(total) ? total : undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function readAll(
  client: NativeTypesClient,
  table: string,
  query: string,
  fields: string,
  pageSize: number
): Promise<Row[]> {
  const ordered = withStableOrder(query);
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.tableAPIGet(table, ordered, fields, pageSize, rows.length, READ_PARAMS);
    const data: unknown = resp.data;
    const result = (data as { result?: unknown } | null)?.result;
    if (!Array.isArray(result)) {
      const contentType = resp.headers?.["content-type"];
      const snippet = typeof data === "string" ? data.slice(0, 120).replace(/\s+/g, " ").trim() : "";
      throw new NonApiResponseError(typeof contentType === "string" ? contentType : undefined, snippet);
    }
    rows.push(...(result as Row[]));
    const total = totalCount(resp.headers);
    if (result.length === 0 || (total !== undefined && rows.length >= total)) return rows;
  }
  throw new Error(
    `Reading ${table} did not finish within ${MAX_PAGES} pages of ${pageSize} rows; ` +
      "the instance may be ignoring sysparm_offset."
  );
}

async function readByNames(
  client: NativeTypesClient,
  table: string,
  names: readonly string[],
  extraQuery: string,
  fields: string,
  options: Required<Pick<NativeTypesOptions, "pageSize" | "chunkSize">>
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const chunk of chunks(names, options.chunkSize)) {
    const query = `nameIN${chunk.join(",")}${extraQuery ? `^${extraQuery}` : ""}`;
    rows.push(...(await readAll(client, table, query, fields, options.pageSize)));
  }
  return rows;
}

// Table and column names reach an encoded query; anything outside the
// platform's own naming alphabet would let a value add conditions to it.
const NAME_PATTERN = /^[A-Za-z0-9_$]+$/;

function assertName(kind: string, name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${kind} "${name}": expected letters, digits, "_" or "$".`);
  }
  return name;
}

const TABLE_FIELDS = "name,label,super_class.name,sys_scope.scope";

interface TableRow {
  name: string;
  label: string;
  scope?: string;
  superClass?: string;
}

function toTableRow(row: Row): TableRow | undefined {
  const name = text(row.name);
  if (!name) return undefined;
  const superClass = text(row["super_class.name"]);
  const scope = text(row["sys_scope.scope"]);
  return {
    name,
    label: text(row.label) || name,
    ...(scope ? { scope } : {}),
    ...(superClass ? { superClass } : {}),
  };
}

function toChoiceMode(value: unknown): ChoiceMode {
  const raw = text(value);
  return raw === "1" || raw === "2" || raw === "3" ? raw : "0";
}

function toField(row: Row): NativeField {
  const reference = text(row.reference);
  const maxLength = Number.parseInt(text(row.max_length), 10);
  return {
    element: text(row.element),
    label: text(row.column_label) || text(row.element),
    internalType: text(row.internal_type) || "string",
    ...(reference ? { reference } : {}),
    mandatory: text(row.mandatory) === "true",
    choice: toChoiceMode(row.choice),
    ...(Number.isFinite(maxLength) && maxLength > 0 ? { maxLength } : {}),
  };
}

/**
 * Reads the schema of the requested tables and all of their ancestors.
 * Throws when an explicitly named table does not exist.
 */
export async function fetchNativeSchema(
  client: NativeTypesClient,
  options: NativeTypesOptions
): Promise<NativeSchema> {
  const paging = {
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
  };
  const explicit = [...new Set((options.tables ?? []).map((t) => t.trim()).filter(Boolean))].sort();
  const tables = new Map<string, TableRow>();

  let seed: Row[];
  if (explicit.length > 0) {
    explicit.forEach((name) => assertName("table", name));
    seed = await readByNames(client, "sys_db_object", explicit, "", TABLE_FIELDS, paging);
  } else {
    const scope = assertName("scope", String(options.scope ?? "").trim());
    seed = await readAll(client, "sys_db_object", `sys_scope.scope=${scope}`, TABLE_FIELDS, paging.pageSize);
  }
  for (const row of seed) {
    const table = toTableRow(row);
    if (table) tables.set(table.name, table);
  }
  const missing = explicit.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    throw new Error(`No sys_db_object record for table(s): ${missing.join(", ")}.`);
  }
  const requested = [...tables.keys()].sort();

  // Walk `super_class` upwards one generation per round until every parent is
  // known. A cycle cannot loop: a name is only ever requested once.
  const asked = new Set(tables.keys());
  for (;;) {
    const parents = [...tables.values()]
      .map((t) => t.superClass)
      .filter((name): name is string => !!name && !asked.has(name));
    const next = [...new Set(parents)].sort();
    if (next.length === 0) break;
    next.forEach((name) => asked.add(name));
    const rows = await readByNames(
      client,
      "sys_db_object",
      next.filter((name) => NAME_PATTERN.test(name)),
      "",
      TABLE_FIELDS,
      paging
    );
    for (const row of rows) {
      const table = toTableRow(row);
      if (table && !tables.has(table.name)) tables.set(table.name, table);
    }
  }

  const names = [...tables.keys()].sort();
  const dictionary = await readByNames(
    client,
    "sys_dictionary",
    names,
    "elementISNOTEMPTY^active=true",
    "name,element,column_label,internal_type,reference,mandatory,choice,max_length",
    paging
  );
  const choiceRows = await readByNames(
    client,
    "sys_choice",
    names,
    "inactive=false",
    "name,element,value",
    paging
  );

  const fieldsByTable = new Map<string, Map<string, NativeField>>();
  for (const row of dictionary) {
    const table = text(row.name);
    const field = toField(row);
    if (!tables.has(table) || !field.element || field.internalType === "collection") continue;
    const fields = fieldsByTable.get(table) ?? new Map<string, NativeField>();
    // Duplicate rows (an instance with a half-applied upgrade) keep the first.
    if (!fields.has(field.element)) fields.set(field.element, field);
    fieldsByTable.set(table, fields);
  }

  const choicesByTable = new Map<string, Map<string, Set<string>>>();
  for (const row of choiceRows) {
    const table = text(row.name);
    const element = text(row.element);
    if (!tables.has(table) || !element) continue;
    const byElement = choicesByTable.get(table) ?? new Map<string, Set<string>>();
    const values = byElement.get(element) ?? new Set<string>();
    // One row per language; the value is the same across them.
    values.add(text(row.value));
    byElement.set(element, values);
    choicesByTable.set(table, byElement);
  }

  return {
    ...(options.scope && explicit.length === 0 ? { scope: options.scope.trim() } : {}),
    requested,
    tables: names.map((name) => {
      const row = tables.get(name) as TableRow;
      const fields = [...(fieldsByTable.get(name)?.values() ?? [])].sort((a, b) =>
        byCodeUnit(a.element, b.element)
      );
      const choices: Record<string, string[]> = {};
      for (const [element, values] of [...(choicesByTable.get(name)?.entries() ?? [])].sort(([a], [b]) =>
        byCodeUnit(a, b)
      )) {
        choices[element] = [...values].sort(byCodeUnit);
      }
      return { ...row, fields, choices };
    }),
  };
}

// --- Rendering -------------------------------------------------------------------

/** The base TypeScript type of each ServiceNow internal type; anything unlisted is a string. */
const INTERNAL_TYPE_MAP: Record<string, string> = {
  boolean: "boolean",
  integer: "number",
  longint: "number",
  decimal: "number",
  float: "number",
  percent_complete: "number",
  order_index: "number",
  glide_date_time: "GlideDateTime",
  due_date: "GlideDateTime",
  glide_date: "GlideDate",
  glide_time: "GlideTime",
  glide_duration: "GlideDuration",
  timer: "GlideDuration",
  reference: "SysId",
  document_id: "SysId",
  domain_id: "SysId",
  GUID: "SysId",
  glide_list: "SysIdList",
};

export function baseType(internalType: string): string {
  return Object.prototype.hasOwnProperty.call(INTERNAL_TYPE_MAP, internalType)
    ? INTERNAL_TYPE_MAP[internalType]
    : "string";
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false " +
    "finally for function if import in instanceof new null return super switch this throw true try " +
    "typeof var void while with implements interface let package private protected public static " +
    "yield any boolean number string symbol bigint object unknown never undefined type"
  ).split(" ")
);
// The names the header declares; a table with one of them would shadow it.
const DECLARED = new Set(["SysId", "SysIdList", "GlideDateTime", "GlideDate", "GlideTime", "GlideDuration", "Tables", "TableName"]);

/** A collision-free interface name per table; table names are used verbatim when they are valid. */
export function interfaceNames(tables: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const table of [...tables].sort()) {
    let base = table.replace(/[^A-Za-z0-9_$]/g, "_");
    if (!/^[A-Za-z_$]/.test(base) || RESERVED.has(base) || DECLARED.has(base)) base = `_${base}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.set(table, name);
  }
  return names;
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

// Instance-supplied text lands inside a block comment; `*/` would end it early.
function commentText(value: string): string {
  return value.replace(/\*\//g, "*\\/").replace(/[\r\n]+/g, " ");
}

function isCanonicalInteger(value: string): boolean {
  const n = Number(value);
  return Number.isSafeInteger(n) && String(n) === value;
}

function literalUnion(field: NativeField, values: readonly string[]): string | undefined {
  // A suggestion list accepts free text too, so it stays a plain string.
  if (field.choice === "0" || field.choice === "2" || values.length === 0) return undefined;
  // Number literals only when each value is the canonical spelling of a safe
  // integer: "007" or "1e3" would be rewritten, and 2^53 + 1 would round.
  const numeric = baseType(field.internalType) === "number" && values.every(isCanonicalInteger);
  const literals = numeric
    ? values.map(Number).sort((a, b) => a - b).map(String)
    : values.map((v) => JSON.stringify(v));
  // "Dropdown with --None--" lets the column be empty.
  if (field.choice === "1" && !values.includes("")) literals.push(numeric ? "null" : '""');
  return literals.join(" | ");
}

function fieldType(field: NativeField, values: readonly string[] | undefined): string {
  return literalUnion(field, values ?? []) ?? baseType(field.internalType);
}

function fieldDoc(field: NativeField): string {
  const parts = [commentText(field.label), `\`${commentText(field.internalType)}\``];
  if (field.reference) parts.push(`references \`${commentText(field.reference)}\``);
  if (field.maxLength !== undefined && baseType(field.internalType) === "string") {
    parts.push(`max length ${field.maxLength}`);
  }
  return parts.join(" — ");
}

const HEADER = `// Generated by \`syncrona fluent types --native\` from sys_db_object, sys_dictionary and
// sys_choice. Do not edit by hand: re-run the command to refresh it.
//
// Each interface describes one table's columns as the platform stores them.
// Mandatory columns are required; every other column is optional.

/** A 32-character record sys_id. */
export type SysId = string;
/** Comma-separated sys_ids (a \`glide_list\` column). */
export type SysIdList = string;
/** \`YYYY-MM-DD HH:mm:ss\`, UTC. */
export type GlideDateTime = string;
/** \`YYYY-MM-DD\`. */
export type GlideDate = string;
/** \`HH:mm:ss\`. */
export type GlideTime = string;
/** A duration, stored as a date-time offset from 1970-01-01 00:00:00. */
export type GlideDuration = string;
`;

/** Renders the schema as one self-contained, deterministic `.d.ts` module. */
export function renderNativeTypes(schema: NativeSchema): NativeTypesResult {
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const ids = interfaceNames(schema.tables.map((t) => t.name));

  // An interface cannot extend itself, so a super_class chain that loops back
  // (a corrupt or half-imported instance) is cut at the member of the loop that
  // sorts first: that table extends nothing, and its comment says why.
  const cycleCuts = new Set<string>();
  for (const table of schema.tables) {
    const chain: string[] = [];
    let at: string | undefined = table.name;
    while (at !== undefined && byName.has(at) && !chain.includes(at)) {
      chain.push(at);
      at = byName.get(at)?.superClass;
    }
    if (at !== undefined && chain.includes(at)) {
      cycleCuts.add(chain.slice(chain.indexOf(at)).sort(byCodeUnit)[0]);
    }
  }
  const parentOf = (name: string): string | undefined => {
    const superClass = byName.get(name)?.superClass;
    return superClass && byName.has(superClass) && !cycleCuts.has(name) ? superClass : undefined;
  };

  // The rendered member signature (optionality and type) of every column a
  // table has, own and inherited. A redeclared column whose signature differs
  // from the inherited one is omitted from the parent, or the interface would
  // not compile (TS2430), whether the type or only the optionality changed.
  const signature = (field: NativeField, type: string): string => `${field.mandatory ? "" : "?"}: ${type}`;
  const resolved = new Map<string, Map<string, string>>();
  const resolve = (name: string): Map<string, string> => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const table = byName.get(name) as NativeTable;
    const parent = parentOf(name);
    const fields = new Map(parent ? resolve(parent) : []);
    for (const field of table.fields) {
      fields.set(field.element, signature(field, fieldType(field, table.choices[field.element])));
    }
    resolved.set(name, fields);
    return fields;
  };
  const fieldOf = (name: string, element: string): NativeField | undefined => {
    const table = byName.get(name) as NativeTable;
    const parent = parentOf(name);
    return table.fields.find((f) => f.element === element) ?? (parent ? fieldOf(parent, element) : undefined);
  };

  const blocks: string[] = [];
  let fieldCount = 0;
  for (const table of schema.tables) {
    const id = ids.get(table.name) as string;
    const parentName = parentOf(table.name);
    const inherited = parentName ? resolve(parentName) : new Map<string, string>();
    const own = new Set(table.fields.map((f) => f.element));

    // Inherited columns whose choices this table overrides are redeclared here.
    const overrides: NativeField[] = [];
    for (const [element, values] of Object.entries(table.choices)) {
      if (own.has(element) || !inherited.has(element)) continue;
      const field = fieldOf(parentName as string, element);
      if (field && literalUnion(field, values) !== undefined) overrides.push(field);
    }

    const lines: string[] = [];
    const members: Array<{ field: NativeField; type: string }> = [
      ...table.fields.map((field) => ({ field, type: fieldType(field, table.choices[field.element]) })),
      ...overrides.map((field) => ({ field, type: fieldType(field, table.choices[field.element]) })),
    ].sort((a, b) => byCodeUnit(a.field.element, b.field.element));
    const omitted = members
      .filter(({ field, type }) => inherited.has(field.element) && inherited.get(field.element) !== signature(field, type))
      .map(({ field }) => JSON.stringify(field.element));

    const doc = [`${commentText(table.label)} (\`${table.name}\`)`];
    if (table.scope) doc.push(`Scope: \`${commentText(table.scope)}\``);
    if (cycleCuts.has(table.name)) {
      doc.push(
        `Extends \`${commentText(table.superClass as string)}\`, which leads back to this table: the cyclic super_class chain is cut here`
      );
    } else if (table.superClass && !parentName) {
      doc.push(`Extends \`${table.superClass}\`, which could not be read`);
    }
    lines.push(`/**\n${doc.map((d) => ` * ${d}`).join("\n")}\n */`);
    const parentId = parentName ? (ids.get(parentName) as string) : undefined;
    const heritage = parentId
      ? ` extends ${omitted.length > 0 ? `Omit<${parentId}, ${omitted.sort().join(" | ")}>` : parentId}`
      : "";
    if (members.length === 0) {
      lines.push(`export interface ${id}${heritage} {}`);
    } else {
      lines.push(`export interface ${id}${heritage} {`);
      for (const { field, type } of members) {
        lines.push(`  /** ${fieldDoc(field)} */`);
        lines.push(`  ${propertyKey(field.element)}${field.mandatory ? "" : "?"}: ${type};`);
      }
      lines.push("}");
    }
    fieldCount += table.fields.length;
    blocks.push(`${lines.join("\n")}\n`);
  }

  const map = schema.tables.map((t) => `  ${propertyKey(t.name)}: ${ids.get(t.name)};`);
  const requested = schema.requested.map((name) => JSON.stringify(name));
  const footer = [
    "/** Every generated table, by name. */",
    map.length > 0 ? `export interface Tables {\n${map.join("\n")}\n}` : "export interface Tables {}",
    "",
    schema.scope
      ? `/** The tables of scope \`${commentText(schema.scope)}\` (ancestors excluded). */`
      : "/** The tables that were asked for (ancestors excluded). */",
    `export type TableName = ${requested.length > 0 ? requested.join(" | ") : "never"};`,
  ].join("\n");

  const content = [HEADER, ...blocks, footer].join("\n") + "\n";
  return { content, tableCount: schema.tables.length, fieldCount };
}

/** Fetches and renders in one call. */
export async function generateNativeTypes(
  client: NativeTypesClient,
  options: NativeTypesOptions
): Promise<NativeTypesResult & { schema: NativeSchema }> {
  const schema = await fetchNativeSchema(client, options);
  return { ...renderNativeTypes(schema), schema };
}
