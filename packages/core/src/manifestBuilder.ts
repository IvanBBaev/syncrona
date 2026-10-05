// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { isEndpointNotFoundStatus, escapeQueryValue } from "@syncrona/sn-transport";
import {
  SN_TYPE_QUERY,
  getDisplayField,
  getFileTypeForInternalType,
} from "./fieldMap.js";
import {
  META_DICTIONARY_FIELDS,
  META_FILE_NAME,
  META_FILE_TYPE,
  classifyColumn,
  dictionaryInternalType,
  isMetaFieldCandidate,
  isMetaFile,
  isReadOnlyDictionaryRow,
  metaFile,
  serializeMetaFields,
  metaSecretClassifierFields,
  metaSecretColumns,
} from "./metaFields.js";
import type { SNClient } from "./snClient.js";
import { getErrorResponseStatus } from "./snClient.js";
import * as ConfigManager from "./config.js";
import {
  DATA_MODEL_DEFAULT_TABLES,
  applyDataModelIncludes,
  applyDataModelTableOptions,
  getDataModelTables,
  isScopelessDataModelTable,
} from "./dataModel.js";
import { isSafePathComponent } from "./genericUtils.js";
import { logger } from "./Logger.js";

type TableAPIRecord = Record<string, string>;
type TableAPIResponse = { result: TableAPIRecord[] };
const MAX_TABLE_HIERARCHY_DEPTH = 10;
const SYS_ID_CHUNK_SIZE = 200;

// PERF-7 (REV-100): default cap for how many tables buildManifestFromTableAPI
// enumerates in parallel. Without a cap a wide scope fired one concurrent
// Table-API request chain per table at once, hammering the instance and risking
// EMFILE/socket exhaustion. Clamped to 1–50; an optional `tableConcurrency`
// field on the passed config overrides it.
const DEFAULT_MANIFEST_TABLE_CONCURRENCY = 20;

const resolveManifestTableConcurrency = (config: unknown): number => {
  // `tableConcurrency` is an internal override that the public config param type
  // intentionally does not name, so read it via a loose structural check rather
  // than a strongly-typed field (which would trip TS's weak-type test at the
  // callsite, where a Pick<Config, ...> carries no such property).
  const candidate =
    config && typeof config === "object"
      ? (config as { tableConcurrency?: unknown }).tableConcurrency
      : undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_MANIFEST_TABLE_CONCURRENCY;
  }
  return Math.min(Math.max(Math.floor(candidate), 1), 50);
};

// Bounded worker pool (copied from the pull/push seams, where the equivalent
// helper is not exported) so the table enumeration above can run in parallel
// without an unbounded fan-out.
const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  // Abort on the first failure. Previously a rejecting worker only rejected the
  // Promise.all, while every other runner kept pulling items off the queue: the
  // caller had already unwound while those workers were still querying the
  // instance, and all but the first error were discarded. Collect the errors,
  // stop scheduling new work, and rethrow.
  const errors: unknown[] = [];

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length && errors.length === 0) {
        const current = nextIndex;
        nextIndex += 1;
        try {
          results[current] = await worker(items[current], current);
        } catch (e) {
          errors.push(e);
        }
      }
    }
  );

  await Promise.all(runners);
  if (errors.length > 0) {
    // Rethrow a lone error unchanged so callers can still classify it
    // (isScopedEndpointUnavailableError, retry predicates, status codes).
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${errors.length} concurrent operations failed.`);
  }
  return results;
};

// 400/403/404 mean the table is not queryable for this user/instance (ACL,
// missing table) — a legitimate "skip this table" case. Anything else
// (network, 5xx, auth) is a real failure that must NOT be treated as
// "no records", otherwise an outage silently produces a truncated manifest.
function isTableSkippableError(e: unknown): boolean {
  const status = getErrorResponseStatus(e);
  return typeof status === "number" && isEndpointNotFoundStatus(status);
}

// Offset paging over an UNORDERED result set is not a walk, it is a sequence of
// unrelated snapshots. The Table API returns rows in whatever order the database
// happened to produce them, and `sysparm_offset` counts rows into that order; if
// it changes between two page requests — another user saving a record, the
// optimizer re-planning the query, replication lag — a row that crosses a page
// boundary is returned twice or NOT AT ALL. The duplicate is harmless (records
// are keyed by sys_id). The dropped row is not: it never reaches the manifest,
// findOrphanFiles then finds a local file no manifest record claims, and
// `repair --apply --prune` DELETES it, taking any unpushed local edit with it.
//
// ORDERBY makes the order total and stable, so an offset means the same thing on
// every request of the walk. sys_id is the right key: every ServiceNow table has
// it, it is unique, and it never changes — a mutable column (sys_updated_on, a
// display name) would reorder under exactly the concurrent-edit scenario this
// guards against.
export const withStableOrder = (query: string): string => {
  // Do not double-order. A caller that already chose an ordering owns it, and
  // ServiceNow applies the FIRST ORDERBY as the primary sort key, so appending
  // ours would leave theirs in place but silently demote any second clause.
  if (/(^|\^)ORDERBY/i.test(query)) {
    return query;
  }
  // An empty query must not grow a leading "^": that reads as an empty first
  // condition and the platform can reject or ignore the whole clause.
  return query.length > 0 ? `${query}^ORDERBYsys_id` : "ORDERBYsys_id";
};

// Pages through the Table API so tables with more rows than the page size are
// fully enumerated instead of silently truncated.
async function tableAPIGetAllRows(
  client: SNClient,
  table: string,
  query: string,
  fields: string,
  pageSize: number
): Promise<TableAPIRecord[]> {
  const orderedQuery = withStableOrder(query);
  const rows: TableAPIRecord[] = [];
  let offset = 0;
  for (;;) {
    const res = await client.tableAPIGet(
      table,
      orderedQuery,
      fields,
      pageSize,
      offset
    );
    const page = extractResult(res.data);
    rows.push(...page);
    if (page.length < pageSize) {
      return rows;
    }
    offset += pageSize;
  }
}

function getDataMaterializationTableAllowlist(): Set<string> {
  const raw = String(process.env.SYNCRONA_DATA_TABLES || "").trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  );
}

function shouldMaterializeDataFields(): boolean {
  const raw = String(process.env.SYNCRONA_INCLUDE_DATA_FIELDS || "")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function shouldMaterializeDataFieldsForTable(tableName: string): boolean {
  if (shouldMaterializeDataFields()) {
    return true;
  }

  return getDataMaterializationTableAllowlist().has(tableName);
}

function extractResult(data: unknown): TableAPIRecord[] {
  const d = data as TableAPIResponse;
  return Array.isArray(d?.result) ? d.result : [];
}

// ─── Scope sys_id ───────────────────────────────────────────────────────────

async function getScopeId(
  client: SNClient,
  scopeName: string
): Promise<string | null> {
  try {
    // Deliberately unpaged: this is a lookup, not an enumeration. Only the first
    // row is ever read, so a limit of 1 is the intent rather than a truncation.
    const res = await client.tableAPIGet(
      "sys_app",
      // Escape the config-supplied scope name — an unescaped `^`/`=` would inject
      // extra encoded-query conditions (matches snClient.getScopeId).
      `scope=${escapeQueryValue(scopeName)}`,
      "sys_id",
      1
    );
    const rows = extractResult(res.data);
    return rows[0]?.sys_id || null;
  } catch {
    return null;
  }
}

// ─── Table names in scope ────────────────────────────────────────────────────
// Mirrors server-side GlideAggregate on sys_metadata grouped by sys_class_name

function filterUniqueTableNames(
  rows: TableAPIRecord[],
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap
): string[] {
  const seen = new Set<string>();
  const tables: string[] = [];

  for (const row of rows) {
    const tableName = row.name || row.sys_class_name;
    if (!tableName || seen.has(tableName)) continue;
    seen.add(tableName);

    const excluded =
      tableName in excludes &&
      typeof excludes[tableName] !== "object" &&
      excludes[tableName] !== false;
    const included = tableName in includes && includes[tableName] !== false;

    if (!excluded || included) {
      tables.push(tableName);
    }
  }

  return tables;
}

async function getTableNamesInScope(
  client: SNClient,
  scopeName: string,
  scopeId: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap
): Promise<string[]> {
  try {
    const rows = await tableAPIGetAllRows(
      client,
      "sys_metadata",
      `sys_scope=${scopeId}`,
      "sys_class_name",
      10000
    );
    const tables = filterUniqueTableNames(rows, includes, excludes);

    if (tables.length > 0) {
      return tables;
    }

    const dbObjectTables = await getTableNamesFromDbObject(
      client,
      scopeId,
      includes,
      excludes
    );
    if (dbObjectTables.length > 0) {
      return dbObjectTables;
    }

    const fallbackTables = await getTableNamesFromDictionary(
      client,
      scopeName,
      scopeId,
      includes,
      excludes
    );
    return fallbackTables;
  } catch {
    return getTableNamesFromDictionary(client, scopeName, scopeId, includes, excludes);
  }
}

async function getTableNamesFromDbObject(
  client: SNClient,
  scopeId: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap
): Promise<string[]> {
  try {
    // Paged, not a bare request with a big limit: this enumerates every table a
    // scope declares, and "the limit happened to be larger than the answer" is
    // not a guarantee. A truncated table list is invisible — the missing tables
    // simply never appear in the manifest, and `repair --prune` then treats
    // their already-downloaded files as orphans.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_db_object",
      `sys_scope=${scopeId}^nameISNOTEMPTY`,
      "name",
      10000
    );
    return filterUniqueTableNames(rows, includes, excludes);
  } catch {
    return [];
  }
}

async function getTableNamesFromDictionary(
  client: SNClient,
  scopeName: string,
  scopeId: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap
): Promise<string[]> {
  try {
    // Paged for the same reason as sys_db_object above, and more urgently: this
    // queries sys_dictionary, which holds one row per FIELD, so a scope with a
    // few hundred tables passes 10000 rows on its own.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      `sys_scope=${scopeId}^nameISNOTEMPTY`,
      "name",
      10000
    );
    const tables = filterUniqueTableNames(rows, includes, excludes);
    if (tables.length > 0) {
      return tables;
    }
  } catch {
  }

  try {
    const rows = await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      `nameLIKE${escapeQueryValue(scopeName)}^nameISNOTEMPTY`,
      "name",
      10000
    );
    return filterUniqueTableNames(rows, includes, excludes);
  } catch {
    return [];
  }
}

// ─── File fields from sys_dictionary ────────────────────────────────────────
// Mirrors server-side getFileMap — finds fields by internal_type

/**
 * Per column of `rows` (sys_dictionary rows with `element` and `internal_type`),
 * the dictionary type classifyColumn judges it by. Collected over every row of a
 * column: a hierarchy query returns the base entry and a child override in no
 * guaranteed order, and either may carry the unsafe type, so an unsafe type on
 * any row wins; otherwise the first readable one does. A column whose rows all
 * carry an empty type is absent, exactly like one with no row.
 */
const dictionaryColumnTypes = (
  tableName: string,
  rows: TableAPIRecord[]
): Map<string, string> => {
  const types = new Map<string, string>();
  for (const row of rows) {
    const internalType = dictionaryInternalType(row.internal_type);
    if (!row.element || internalType === "") {
      continue;
    }
    const isUnsafe = (type: string): boolean =>
      classifyColumn(tableName, row.element, type) === "unsafe";
    const known = types.get(row.element);
    if (known === undefined || (!isUnsafe(known) && isUnsafe(internalType))) {
      types.set(row.element, internalType);
    }
  }
  return types;
};

/** The columns of `types` classifyColumn rules unsafe, mapped to their type. */
const unsafeColumnTypes = (
  tableName: string,
  types: ReadonlyMap<string, string>
): Map<string, string> =>
  new Map([...types].filter(([column, type]) => classifyColumn(tableName, column, type) === "unsafe"));

/** The field-level `includes` entries of `tableName`, if any. */
const includedFieldNames = (includes: Sync.TablePropMap, tableName: string): string[] =>
  tableName in includes && typeof includes[tableName] === "object"
    ? Object.keys(includes[tableName] as Sync.FieldMap)
    : [];

/**
 * `table.column` keys already warned about in this build — dropped as unsafe,
 * or kept without a readable type. A column judged on the file-field path is
 * judged again by the data-field fallback the same table may fall through to,
 * and `dev` rebuilds on every interval — one line per column per build is the
 * signal, more is noise. Cleared with the hierarchy memo
 * (resetTableHierarchyCache), i.e. once per build.
 */
const warnedIncludes = new Set<string>();

/** The entries of `columns` not yet warned about for `tableName`, now marked. */
const claimIncludeWarnings = (tableName: string, columns: string[]): string[] =>
  columns.filter((column) => {
    const key = `${tableName}.${column}`;
    if (warnedIncludes.has(key)) {
      return false;
    }
    warnedIncludes.add(key);
    return true;
  });

const warnUnsafeInclude = (tableName: string, column: string, unsafeType: string): void => {
  if (claimIncludeWarnings(tableName, [column]).length === 0) {
    return;
  }
  logger.warn(
    `Table ${tableName}: ignoring the includes entry for column "${column}" — ` +
      `its dictionary type is ${unsafeType}, and a value of that type is never written to the working tree.`
  );
};

/**
 * Names included columns kept without the unsafe-type check, because their
 * dictionary type could not be read: the lookup failed (`reason` is its error),
 * or it answered without a row or with an empty type for them. Not fail-closed
 * on purpose — dropping every included column whenever the type is unreadable
 * would make `includes` unusable on an instance that restricts sys_dictionary
 * reads — but never silent.
 */
const warnUntypedIncludes = (tableName: string, columns: string[], reason: string): void => {
  const fresh = claimIncludeWarnings(tableName, columns);
  if (fresh.length === 0) {
    return;
  }
  logger.warn(
    `Table ${tableName}: could not read the dictionary type of included column(s) ` +
      `${fresh.join(", ")} (${reason}); they are kept without the unsafe-type check.`
  );
};

const NO_DICTIONARY_TYPE = "no dictionary row or an empty internal_type";

/**
 * The dictionary types of `columns` across `tableNameQuery` (a table hierarchy
 * as `name=a^ORname=b`) — the lookup an `includes` entry needs before it can
 * go through classifyColumn, because the file-field query only returns
 * file-typed columns and the scoped endpoint returns no types at all. One
 * query per table. Throws what the Table API throws.
 */
const readColumnTypes = async (
  client: SNClient,
  tableName: string,
  tableNameQuery: string,
  columns: string[]
): Promise<Map<string, string>> =>
  dictionaryColumnTypes(
    tableName,
    await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      `${tableNameQuery}^elementIN${columns.map(escapeQueryValue).join(",")}`,
      "element,internal_type",
      200
    )
  );

/**
 * Appends the field-level `includes` entries of `tableName` that `files` does
 * not list yet, each judged by classifyColumn against `types` (from
 * dictionaryColumnTypes): an unsafe one is dropped with a warning — `includes`
 * selects columns, it does not lift the rule that a credential, journal or
 * binary value never reaches the working tree — and one without a readable
 * type is kept with a warning. `types` is undefined when the lookup itself
 * failed; the caller has warned, and every entry is kept.
 */
const appendIncludedFields = (
  files: SN.File[],
  tableName: string,
  includes: Sync.TablePropMap,
  types: ReadonlyMap<string, string> | undefined
): void => {
  if (!(tableName in includes) || typeof includes[tableName] !== "object") {
    return;
  }
  const tableIncludes = includes[tableName] as Sync.FieldMap;
  const untyped: string[] = [];
  for (const [fieldName, fieldConfig] of Object.entries(tableIncludes)) {
    if (files.some((f) => f.name === fieldName)) {
      continue;
    }
    if (types) {
      const type = types.get(fieldName);
      const verdict = classifyColumn(tableName, fieldName, type);
      if (verdict === "unsafe") {
        warnUnsafeInclude(tableName, fieldName, type as string);
        continue;
      }
      if (verdict === "unknown") {
        untyped.push(fieldName);
      }
    }
    files.push({ name: fieldName, type: fieldConfig.type || ("txt" as SN.FileType) });
  }
  warnUntypedIncludes(tableName, untyped, NO_DICTIONARY_TYPE);
};

async function getFileFieldsForTable(
  client: SNClient,
  tableName: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap,
  onSkip?: () => void,
  // DX22: the hierarchy walk this function performs is the same one the metadata
  // discovery needs. Handing it back costs nothing and spares the caller a second
  // sys_db_object walk per table.
  onHierarchy?: (tableNames: string[]) => void
): Promise<SN.File[]> {
  try {
    // ATF step script is stored in inputs.script and is not reliably available via dictionary.
    if (tableName === "sys_atf_step") {
      return [{ name: "inputs.script", type: "js" as SN.FileType }];
    }

    const hierarchyTableNames = await getTableHierarchyTableNames(client, tableName);
    onHierarchy?.(hierarchyTableNames);
    const tableNameQuery = hierarchyTableNames
      .map((name) => `name=${name}`)
      .join("^OR");

    // Build field exclusion query
    let query = `${tableNameQuery}^${SN_TYPE_QUERY}^elementISNOTEMPTY`;

    // Apply field-level excludes
    if (tableName in excludes && typeof excludes[tableName] === "object") {
      const exFields = Object.keys(excludes[tableName] as Sync.FieldMap);
      for (const exField of exFields) {
        // Skip if also explicitly included at field level
        const tableIncludes = includes[tableName];
        if (tableIncludes && typeof tableIncludes === "object" && exField in tableIncludes) {
          continue;
        }
        query += `^element!=${exField}`;
      }
    }

    // Paged. This is the field-discovery query, and it runs against the whole
    // TABLE HIERARCHY (`name=child^ORname=parent^OR...`), so a record extending a
    // deep OOB hierarchy — anything under task, cmdb_ci or sys_metadata — clears
    // 200 dictionary rows routinely. Truncation here does not fail: it returns a
    // manifest that is simply missing fields 201+, so those fields are never
    // downloaded, never pushed, and nothing in the CLI ever mentions them.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      query,
      "element,internal_type",
      200
    );
    // `internal_type` is a reference column and may arrive as `{ link, value }`;
    // String() on that is "[object Object]", which no type map knows, so every
    // script field fell back to `.txt`. See dictionaryInternalType.
    const files: SN.File[] = rows
      .filter((r) => r.element && dictionaryInternalType(r.internal_type))
      .map((r) => ({
        name: r.element,
        type: getFileTypeForInternalType(dictionaryInternalType(r.internal_type)) as SN.FileType,
      }));

    // Apply field-level includes overrides. The query above only returns
    // file-typed columns, so an included column's dictionary type has to be
    // read separately before it can go through the unsafe-type filter.
    const pendingIncludes = includedFieldNames(includes, tableName).filter(
      (fieldName) => !files.some((f) => f.name === fieldName)
    );
    let includeTypes: Map<string, string> | undefined;
    if (pendingIncludes.length > 0) {
      try {
        includeTypes = await readColumnTypes(client, tableName, tableNameQuery, pendingIncludes);
      } catch (e) {
        warnUntypedIncludes(tableName, pendingIncludes, e instanceof Error ? e.message : String(e));
      }
    }
    appendIncludedFields(files, tableName, includes, includeTypes);

    if (files.length === 0 && shouldMaterializeDataFieldsForTable(tableName)) {
      // Data-only tables may have no script/css/xml/html fields; fall back to text fields
      // so scoped records still materialize locally instead of producing an empty scope.
      return getTextFieldsForTable(
        client,
        tableName,
        includes,
        excludes,
        hierarchyTableNames,
        onSkip
      );
    }

    return files;
  } catch (e) {
    // Only an inaccessible table may look like "no file fields"; a network
    // failure must propagate so the table lands in failedTables instead of
    // silently vanishing from the manifest.
    if (!isTableSkippableError(e)) {
      throw e;
    }
    // Report the skip: "inaccessible" and "genuinely has no file fields" are
    // indistinguishable in the return value, and the caller must not treat the
    // former as a reason to drop the table from a rebuilt manifest.
    onSkip?.();
    return [];
  }
}

async function getTextFieldsForTable(
  client: SNClient,
  tableName: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap,
  hierarchyTableNames?: string[],
  onSkip?: () => void
): Promise<SN.File[]> {
  try {
    const hierarchy = hierarchyTableNames || await getTableHierarchyTableNames(client, tableName);
    const tableNameQuery = hierarchy.map((name) => `name=${name}`).join("^OR");
    let query = `${tableNameQuery}^elementISNOTEMPTY`;

    if (tableName in excludes && typeof excludes[tableName] === "object") {
      const exFields = Object.keys(excludes[tableName] as Sync.FieldMap);
      for (const exField of exFields) {
        const tableIncludes = includes[tableName];
        if (tableIncludes && typeof tableIncludes === "object" && exField in tableIncludes) {
          continue;
        }
        query += `^element!=${exField}`;
      }
    }

    // Paged, for the same reason as getFileFieldsForTable: one dictionary row
    // per field of the whole hierarchy, and a truncated field list produces a
    // manifest that is quietly incomplete rather than one that fails.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      query,
      "element,internal_type",
      500
    );

    // This fallback turns EVERY column into a `.txt` field file, so it needs
    // the same type filter the sidecar applies: a `password2` column written
    // here is a credential in the working tree, and a journal is an activity
    // stream that churns on every pull. Collected over every row of a column
    // before the first-wins dedupe — a hierarchy query returns the base entry
    // and a child override in no guaranteed order, and either may carry the
    // unsafe type.
    const types = dictionaryColumnTypes(tableName, rows);
    const unsafe = unsafeColumnTypes(tableName, types);
    const seen = new Set<string>();
    const files: SN.File[] = [];
    for (const row of rows) {
      const fieldName = row.element;
      if (!fieldName || seen.has(fieldName) || unsafe.has(fieldName)) {
        continue;
      }
      seen.add(fieldName);
      files.push({ name: fieldName, type: "txt" as SN.FileType });
    }

    // An `includes` entry must not re-add a column the filter just dropped.
    appendIncludedFields(files, tableName, includes, types);

    return files;
  } catch (e) {
    // Same contract as getFileFieldsForTable: swallow only "table not
    // accessible", let real failures reach the failedTables accounting.
    if (!isTableSkippableError(e)) {
      throw e;
    }
    // This runs inside getFileFieldsForTable's own `try`, so its catch never
    // sees this error — the skip has to be reported from here or the caller
    // reads an empty field list as "this table genuinely has no fields" and
    // drops the table from the rebuilt manifest.
    onSkip?.();
    return [];
  }
}

/**
 * DX22: the non-file columns of a table, i.e. what goes into each record's
 * `.meta.json` sidecar.
 *
 * Deliberately a SEPARATE dictionary query rather than a widening of
 * getFileFieldsForTable's `internal_type` filter. Widening that query would put
 * every metadata column through the file-field code path, where each one becomes
 * a manifest file, an on-disk file and a push target — the exact outcome the
 * sidecar exists to avoid. Keeping the two lists disjoint at the source is also
 * what lets the file half stay byte-for-byte unchanged.
 *
 * Unlike its file-field sibling this never reports a skip: metadata is additive,
 * and a table whose columns could not be enumerated must still contribute its
 * scripts rather than be treated as unreadable and carried forward wholesale.
 */
interface MetaFieldSet {
  /** Every column serialized into the sidecar. */
  fields: string[];
  /** The subset of `fields` a push must never send back. */
  readOnly: string[];
}

const NO_META_FIELDS: MetaFieldSet = { fields: [], readOnly: [] };

/**
 * What getMetaFieldsForTable returns when the dictionary read FAILED, as
 * opposed to a table that genuinely has no sidecar column. Same shape as
 * NO_META_FIELDS (callers that only need the lists see no difference); told
 * apart by identity, so a sidecar-only data-model table can report the failure
 * as a skip and keep its previous manifest entry.
 */
const UNREADABLE_META_FIELDS: MetaFieldSet = Object.freeze({
  fields: [],
  readOnly: [],
}) as MetaFieldSet;

async function getMetaFieldsForTable(
  client: SNClient,
  tableName: string,
  fileFieldNames: string[],
  tableOptions: Sync.ITableOptions | undefined,
  hierarchyTableNames?: string[]
): Promise<MetaFieldSet> {
  const fileFields = new Set(fileFieldNames);
  const dropFileFields = (fields: string[]): string[] =>
    [...new Set(fields)].filter(
      (field) => typeof field === "string" && field.length > 0 && !fileFields.has(field)
    );

  // An explicit list replaces discovery outright — that is what makes it usable
  // to re-add a column the default rules exclude. File fields are still removed:
  // two claimants for one column would write the value twice and let a push read
  // back whichever the walker happened to reach first.
  //
  // It carries no read-only set either: the point of an explicit list is that
  // the operator decided, so a column they named is a column they intend to
  // write. (The instance still has the final say — the Table API drops a
  // read-only value, and the push reports what it sent, not what stuck.)
  if (Array.isArray(tableOptions?.metaFields)) {
    return { fields: dropFileFields(tableOptions.metaFields).sort(), readOnly: [] };
  }

  try {
    const hierarchy =
      hierarchyTableNames || (await getTableHierarchyTableNames(client, tableName));
    const tableNameQuery = hierarchy.map((name) => `name=${name}`).join("^OR");
    // Paged at 500 for the same reason as the file-field query: this one is
    // strictly wider (no internal_type filter), so a task- or cmdb_ci-derived
    // table routinely returns several hundred dictionary rows.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_dictionary",
      `${tableNameQuery}^elementISNOTEMPTY`,
      META_DICTIONARY_FIELDS,
      500
    );

    const seen = new Set<string>();
    const fields: string[] = [];
    const readOnly = new Set<string>();
    for (const row of rows) {
      const element = row.element;
      if (!element || fileFields.has(element)) {
        continue;
      }
      // Read-only-ness is collected from EVERY row for the column, before the
      // first-wins dedupe below. A hierarchy query returns the base table's
      // dictionary entry alongside any child override, in no guaranteed order,
      // and either one may be the row that marks the column read-only. Taking
      // the union is the conservative reading: a column no push may write is a
      // worse thing to get wrong than a column pushed for nothing.
      if (isReadOnlyDictionaryRow(row)) {
        readOnly.add(element);
      }
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);
      if (!isMetaFieldCandidate(element, row.internal_type)) {
        continue;
      }
      fields.push(element);
    }
    // Sorted so the manifest's own metaFields list is stable across rebuilds.
    fields.sort();
    return {
      fields,
      readOnly: fields.filter((field) => readOnly.has(field)),
    };
  } catch (e) {
    // Deliberately swallows EVERY error, unlike getFileFieldsForTable which
    // rethrows anything that is not a 404-ish endpoint miss. The metadata layer
    // is strictly additive: a table without it is the pre-DX22 table, which is a
    // complete and usable result, whereas propagating here would push a table
    // whose FILES fetched perfectly well into failedTables and fail the build.
    // (A read ACL that hides sys_dictionary from this user answers 403, not 404,
    // so the skippable-error rule would not have covered the common case anyway.)
    // Reporting onSkip is equally wrong: a "skipped" table is carried forward
    // wholesale from the previous manifest, discarding the records just built.
    // The exception is a sidecar-only data-model table, which has no records
    // without this layer: enumerateTable sees UNREADABLE_META_FIELDS and
    // reports that table as skipped so its previous entry is carried forward.
    //
    // But it is reported at WARN, not debug. Swallowing the error is only half a
    // decision — the other half is that the user must be able to tell the two
    // outcomes apart, because they look identical afterwards: a scope with no
    // metadata layer and a scope whose metadata layer failed to build both
    // produce scripts on disk and a cheerful "Download complete". At debug level
    // the difference was invisible at the default log level, and the workspace
    // that resulted was the exact "where is my metadata?" state this feature was
    // written to end. It names the table and the cause so the fix is a decision,
    // not an investigation.
    logger.warn(
      `Table ${tableName}: could not read the dictionary, so no .meta.json ` +
        `sidecar will be written for its records and existing ones will not be ` +
        `pushable (${e instanceof Error ? e.message : String(e)}). The scripts ` +
        `are unaffected. If this user cannot read sys_dictionary, set ` +
        `\`tableOptions.${tableName}.metaFields\` explicitly; otherwise re-run ` +
        `\`syncrona refresh\` once the instance answers again.`
    );
    return UNREADABLE_META_FIELDS;
  }
}

/**
 * Per-run memo for the single-row `sys_db_object` parent lookup.
 *
 * The walk costs one request per level, and every table in a scope sits on the
 * same two or three ancestors — `sys_metadata` above all. Unmemoized, that
 * shared spine is re-queried once per table. Measured on a live 5-table scope:
 * 15 Table-API requests, of which 10 were `sys_db_object` and only 5 were the
 * dictionary reads the caller actually wanted. The ratio worsens with scope
 * size, and `dev` re-runs the whole thing on an interval.
 *
 * Memoized at the LOOKUP and not at the walk: two tables in the same scope
 * rarely have the same starting point, so caching whole hierarchies would
 * almost never hit. What they share is their ancestors, and one row per
 * ancestor is exactly what this map holds.
 *
 * Promises are cached, not results, so two tables reaching the same ancestor
 * concurrently share one request instead of racing to issue two. The map lives
 * for one manifest build (see resetTableHierarchyCache): a hierarchy does not
 * change mid-run, but it can change between runs, and a long-lived `dev`
 * session must not pin a stale answer forever.
 */
const tableParentCache = new Map<string, Promise<string | undefined>>();

/** Drops the memo. Called at the start of every manifest build and enrichment. */
export const resetTableHierarchyCache = (): void => {
  tableParentCache.clear();
  // Same lifetime: the include warnings are once per build.
  warnedIncludes.clear();
};

async function getTableParentName(
  client: SNClient,
  tableName: string
): Promise<string | undefined> {
  const cached = tableParentCache.get(tableName);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    // Deliberately unpaged: `name` is unique in sys_db_object, so this is a
    // single-row lookup of one table's parent, not an enumeration.
    const res = await client.tableAPIGet(
      "sys_db_object",
      `name=${tableName}`,
      "name,super_class.name",
      1
    );
    return extractResult(res.data)[0]?.["super_class.name"];
  })();
  tableParentCache.set(tableName, pending);
  try {
    return await pending;
  } catch (e) {
    // A rejected promise must not be cached: the next table reaching the same
    // ancestor would inherit a failure that may have been a one-off timeout.
    tableParentCache.delete(tableName);
    throw e;
  }
}

async function getTableHierarchyTableNames(
  client: SNClient,
  tableName: string
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [tableName];
  const ordered: string[] = [];
  let depth = 0;

  while (queue.length > 0 && depth < MAX_TABLE_HIERARCHY_DEPTH) {
    const current = queue.shift() as string;
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    ordered.push(current);

    try {
      const parentName = await getTableParentName(client, current);
      if (parentName && !visited.has(parentName)) {
        queue.push(parentName);
      }
    } catch {
      // If hierarchy lookup fails, continue with already discovered tables.
    }

    depth += 1;
  }

  return ordered.length > 0 ? ordered : [tableName];
}

// ─── Records for a single table ──────────────────────────────────────────────

/**
 * A response field as the text the on-disk name is built from, or "" when it
 * cannot be text.
 *
 * `TableAPIRecord` claims `Record<string, string>`, but that is a claim about a
 * remote JSON response that nothing validates, and it is wrong in a way that is
 * routine rather than adversarial: ServiceNow flattens a reference field to its
 * value only when `sysparm_exclude_reference_link=true`, and snClient.tableAPIGet
 * never sets it, so every reference column arrives as `{ link, value }`. A
 * `tableOptions.displayField` or `differentiatorField` pointing at a reference
 * column — a widget differentiated by its `sp_instance`, a record named after its
 * parent — therefore handed an OBJECT to `String.prototype.replace`, and the
 * TypeError escaped `buildBulkDownloadFromTableAPI`'s per-table catch (it is not a
 * "skippable" HTTP error), aborting the download of EVERY table with
 * "name.replace is not a function" and naming neither the table nor the record.
 * A property test shrank it to the minimum: one requested record, one returned row
 * `{}`, where even `record.sys_id` is absent.
 *
 * `.value` is taken for the reference shape because it is exactly what the
 * flattened response would have carried, so a name derived here stays identical to
 * the one derived from a response that did set the parameter.
 */
function fieldText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const referenced = (value as { value?: unknown }).value;
    if (typeof referenced === "string") {
      return referenced;
    }
  }
  return "";
}

/**
 * The record's sys_id, or "" when the response did not return a usable one.
 *
 * Every consumer keys off it — the manifest indexes records by name and stores the
 * sys_id as the push/download target, findMissingFiles probes by sys_id — so a
 * record without one cannot be represented. It used to become the literal string
 * "undefined" in the manifest (and in the download's missing-file map), which then
 * looked like a real record forever after.
 */
function recordSysId(record: TableAPIRecord): string {
  return fieldText(record.sys_id).trim();
}

function buildRecordName(
  record: TableAPIRecord,
  displayField: string,
  tableOptions: Sync.ITableOptions | undefined
): string {
  const sysId = recordSysId(record);
  const override = tableOptions?.displayField
    ? fieldText(record[tableOptions.displayField])
    : "";
  // R4: a composite name for data-model tables, whose display value alone is
  // not unique (every dictionary entry of a table displays as the table name).
  // Empty parts are dropped so a row without one (the collection entry of a
  // table has no element) is named by what it does have.
  const composite =
    !override && Array.isArray(tableOptions?.nameFields)
      ? tableOptions.nameFields
          .map((field) => fieldText(record[field]).trim())
          .filter((part) => part.length > 0)
          .join(".")
      : "";
  let name = override || composite || fieldText(record[displayField]) || sysId;

  if (tableOptions?.differentiatorField) {
    const isStringDiff = typeof tableOptions.differentiatorField === "string";
    const diffFields: string[] = isStringDiff
      ? [tableOptions.differentiatorField as string]
      : [...tableOptions.differentiatorField];
    for (const field of diffFields) {
      const val = fieldText(record[field]);
      if (val) {
        // Match SincUtilsMS behavior: string uses only value, array uses field:value.
        name = isStringDiff ? `${name} (${val})` : `${name} (${field}:${val})`;
        break;
      }
    }
  }

  // Match server-side: replace path separators
  const safe = (name || sysId).replace(/[/\\]/g, "〳");
  // Never let a record materialize as "." / ".." (or any all-dots name): those
  // resolve to the current/parent directory, so the record's field files would
  // land outside its own folder and then get deleted by `repair --apply --prune`.
  if (safe.trim() === "" || /^\.+$/.test(safe.trim())) {
    // The fallback has to clear the same bar as the name it replaces. The guard
    // above rejected "." / ".." in the display value but then returned the sys_id
    // unchecked, so a row whose sys_id was ITSELF ".." (or carried a separator)
    // walked straight through the very check that had just fired — a property test
    // shrank it to `{ sys_id: ".." }`, which materialized the parent directory as
    // a record folder. A real sys_id is 32 hex characters, so this only triggers
    // on a malformed or hostile response; returning "" makes the callers drop the
    // row (see the `unusableRows` filters) rather than inventing a path for it.
    return isSafePathComponent(sysId) ? sysId : "";
  }
  return safe;
}

/**
 * Stores a record under its on-disk name.
 *
 * `records[name] = record` looks total but is not: `records` is an object literal,
 * so assigning the one key `"__proto__"` invokes the inherited setter instead of
 * creating a property. The record then vanished — `Object.keys` did not list it, so
 * the manifest never mentioned it and the downloader never wrote it, while the
 * response had returned it and the run reported success. If it was the table's only
 * record the whole table disappeared from the result. `__proto__` is a perfectly
 * legal ServiceNow display name and a perfectly legal directory name (INJ-1's
 * isSafePathComponent accepts it), and it also arrives as a *supplied* manifest name
 * (JSON.parse makes `"__proto__"` an own property, so buildManifestRecordNames
 * passes it straight through). defineProperty stores it as the own, enumerable,
 * JSON-serializable property every consumer already expects.
 */
function setRecord(
  records: SN.TableConfigRecords,
  name: string,
  record: SN.MetaRecord
): void {
  Object.defineProperty(records, name, {
    value: record,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Builds the Table API `sysparm_fields` list for a record query. buildRecordName
// derives the on-disk name from the default display field, an optional
// tableOptions.displayField override, and an optional differentiator field — so
// every one of those columns MUST be selected. If they are not, the API omits
// them, buildRecordName silently falls back to sys_id (or a different column),
// and the manifest name disagrees with the bulk-download name for the same
// record; `repair --prune` then deletes the "orphan" file. Both the manifest
// path (getRecordsForTable) and the download path (buildBulkDownloadFromTableAPI)
// share this helper so they always request identical columns and stay in parity.
function buildRecordFieldList(
  defaultDisplayField: string,
  fileFieldNames: string[],
  tableOptions: Sync.ITableOptions | undefined
): string {
  const fields: string[] = ["sys_id", defaultDisplayField];
  if (tableOptions?.displayField) {
    fields.push(tableOptions.displayField);
  }
  if (tableOptions?.differentiatorField) {
    const diffFields =
      typeof tableOptions.differentiatorField === "string"
        ? [tableOptions.differentiatorField]
        : tableOptions.differentiatorField;
    fields.push(...diffFields);
  }
  if (Array.isArray(tableOptions?.nameFields)) {
    fields.push(...tableOptions.nameFields);
  }
  fields.push(...fileFieldNames);
  // Dedupe while preserving first-seen order; drop empty names defensively.
  return [...new Set(fields.filter((f) => f))].join(",");
}

async function getRecordsForTable(
  client: SNClient,
  tableName: string,
  scopeId: string,
  files: SN.File[],
  tableOptions: Sync.ITableOptions | undefined,
  onSkip?: () => void,
  // DX22: what each record LISTS, which is the file fields plus the `.meta`
  // pseudo-file. Kept separate from `files` because `files` is what the query
  // SELECTS, and `.meta` is not a column — asking the Table API for it would
  // make the whole projection invalid.
  recordFiles: SN.File[] = files,
  // How the rows are attributed to the scope. Only a table without a
  // `sys_scope` column is read any other way than by the scope filter.
  scoping: RecordScoping = "scope-column"
): Promise<SN.TableConfigRecords> {
  const displayField = getDisplayField(tableName);

  // A field file a record-level secret rule governs (`sys_properties.value`,
  // made a field file by an `includes` entry or the data-field fallback) is
  // listed per record, not per table: a password property's value must never
  // be a manifest file, or it would be downloaded into the working tree and be
  // a push target. The rule's classifier column is selected so each row can be
  // judged.
  const fileFieldNames = files.map((f) => f.name);
  const governsFileField = fileFieldNames.some(
    (name) => classifyColumn(tableName, name) === "secret"
  );
  const tableFields = buildRecordFieldList(
    displayField,
    governsFileField
      ? [...fileFieldNames, ...metaSecretClassifierFields(tableName)]
      : fileFieldNames,
    tableOptions
  );
  const filesForRow = (row: TableAPIRecord): SN.File[] => {
    const listed = recordFiles.map((f) => ({ name: f.name, type: f.type }));
    if (!governsFileField) {
      return listed;
    }
    const secret = new Set(metaSecretColumns(tableName, row));
    return listed.filter((f) => isMetaFile(f) || !secret.has(f.name));
  };

  const toRecords = (rows: TableAPIRecord[]): SN.TableConfigRecords => {
    const records: SN.TableConfigRecords = {};
    // Names that collide once written to disk — a case-insensitive volume
    // (macOS/Windows) or Unicode-normalization differences map two distinct
    // records onto one path. Warning alone was not enough: both keys were still
    // written to the manifest, the two records overwrote each other's files on
    // disk, and a push from either one uploaded the other's content. Every
    // member of a colliding group is now suffixed with its sys_id so each record
    // owns a distinct path.
    //
    // The disambiguation must not depend on row order (the Table API gives no
    // stable ordering, and a rebuild that renamed a different member of the pair
    // would orphan the previously downloaded files), so it is decided in a first
    // pass over the whole result set rather than as each row is seen.
    // A row with no usable sys_id cannot be a manifest record (see recordSysId),
    // and buildRecordName has nothing left to name it after, so drop it here
    // rather than writing an entry keyed "undefined" that no push can ever target.
    let unusableRows = 0;
    const entries = rows
      .map((row) => {
        const sysId = recordSysId(row);
        const name = buildRecordName(row, displayField, tableOptions);
        return {
          sysId,
          name,
          normalized: name.normalize("NFC").toLowerCase(),
          files: filesForRow(row),
        };
      })
      .filter((entry) => {
        // Both values are checked as path components, not just for emptiness: the
        // name becomes a directory, and the sys_id is interpolated into that
        // directory name whenever the group below collides
        // (`${name}_${sysId}`), so an unusable sys_id escapes through the name.
        if (isSafePathComponent(entry.name) && isSafePathComponent(entry.sysId)) {
          return true;
        }
        unusableRows += 1;
        return false;
      });
    if (unusableRows > 0) {
      logger.warn(
        `Table ${tableName}: skipped ${unusableRows} record(s) the instance returned without a usable sys_id.`
      );
    }
    const sysIdsByNormalized = new Map<string, Set<string>>();
    for (const entry of entries) {
      let group = sysIdsByNormalized.get(entry.normalized);
      if (!group) {
        group = new Set<string>();
        sysIdsByNormalized.set(entry.normalized, group);
      }
      group.add(entry.sysId);
    }

    for (const entry of entries) {
      const collides = (sysIdsByNormalized.get(entry.normalized)?.size ?? 0) > 1;
      const name = collides ? `${entry.name}_${entry.sysId}` : entry.name;
      if (collides) {
        logger.warn(
          `Record name collision in ${tableName}: "${entry.name}" is used by more than one record; storing it as "${name}" so no record is overwritten.`
        );
      }
      setRecord(records, name, {
        sys_id: entry.sysId,
        name,
        files: entry.files,
      });
    }

    return records;
  };

  // A table without a `sys_scope` column is never sent the scope filter and
  // never falls back to sys_metadata: the instance ignores a condition on a
  // column the table does not have, so the "scoped" read below would return
  // every row of the table.
  if (scoping === "choice-owner") {
    return toRecords(
      await getScopeChoiceRows(
        client,
        tableName,
        scopeId,
        tableFields,
        tableOptions?.query,
        onSkip
      )
    );
  }
  if (scoping === "operator-query") {
    // An empty query here would be the whole-table sweep this mode prevents.
    return tableOptions?.query
      ? toRecords(
          await readRowsOrSkip(client, tableName, tableOptions.query, tableFields, 500, onSkip)
        )
      : {};
  }

  const baseQuery = `sys_scope=${scopeId}^sys_class_name=${tableName}`;
  const query = tableOptions?.query
    ? `${baseQuery}^${tableOptions.query}`
    : baseQuery;

  let rows: TableAPIRecord[] = [];

  try {
    rows = await tableAPIGetAllRows(client, tableName, query, tableFields, 500);
  } catch (e) {
    if (!isTableSkippableError(e)) {
      throw e;
    }
    // See getFileFieldsForTable: an ACL denial must not read as "this table has
    // no records" to the manifest builder.
    onSkip?.();
    rows = [];
  }

  if (rows.length > 0) {
    return toRecords(rows);
  }

  const metadataRows = await getScopeMetadataRowsForTable(
    client,
    scopeId,
    tableName,
    onSkip
  );
  if (metadataRows.length === 0) {
    return {};
  }

  const metadataIds = metadataRows
    .map((row) => row.sys_id)
    .filter((id): id is string => !!id);
  const chunks = chunkArray(metadataIds, SYS_ID_CHUNK_SIZE);
  const fallbackRows: TableAPIRecord[] = [];

  for (const chunk of chunks) {
    const idQueryBase = `sys_idIN${chunk.join(",")}`;
    const idQuery = tableOptions?.query
      ? `${idQueryBase}^${tableOptions.query}`
      : idQueryBase;

    try {
      // Deliberately unpaged: bounded by construction. The query is
      // `sys_idIN<chunk>`, sys_id is unique, and chunks are SYS_ID_CHUNK_SIZE
      // (200) ids against a limit of 500 — the response can never reach the
      // limit, so there is nothing to truncate and nothing to order.
      const res = await client.tableAPIGet(
        tableName,
        idQuery,
        tableFields,
        500
      );
      fallbackRows.push(...extractResult(res.data));
    } catch (e) {
      if (!isTableSkippableError(e)) {
        throw e;
      }
      // Table not accessible for this chunk — the other chunks may still
      // succeed, so keep going, but the result is now a PARTIAL record set.
      // Without reporting the skip, a manifest missing those records looks
      // authoritative and `repair --prune` deletes their local files.
      onSkip?.();
    }
  }

  return toRecords(fallbackRows);
}

async function getScopeMetadataRowsForTable(
  client: SNClient,
  scopeId: string,
  tableName: string,
  onSkip?: () => void
): Promise<TableAPIRecord[]> {
  try {
    return await tableAPIGetAllRows(
      client,
      "sys_metadata",
      `sys_scope=${scopeId}^sys_class_name=${tableName}`,
      "sys_id,sys_class_name",
      10000
    );
  } catch (e) {
    if (!isTableSkippableError(e)) {
      throw e;
    }
    // Same reason as the other skips: an empty row set here is returned to a
    // caller that cannot tell "refused" from "empty", and the table would be
    // dropped from the rebuilt manifest.
    onSkip?.();
    return [];
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// ─── Records of a table without a scope column ───────────────────────────────

/**
 * How the records of one table are attributed to the scope being built.
 *
 * - `scope-column`: the table has `sys_scope` (it extends sys_metadata or
 *   carries the column itself), so the scope filter selects its records.
 * - `choice-owner`: sys_choice, which has no scope column; a choice follows the
 *   table, column or choice list it belongs to (see getScopeChoiceRows).
 * - `operator-query`: no scope column and no built-in rule; the operator's own
 *   `tableOptions.<table>.query` is the only thing that bounds the read.
 */
type RecordScoping = "scope-column" | "choice-owner" | "operator-query";

// Table and column names read from the instance are interpolated into `IN`
// lists below. Anything outside this alphabet (a comma, a caret) would add
// conditions to the query, so such a name is dropped instead of sent.
const QUERY_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const isQueryIdentifier = (value: unknown): value is string =>
  typeof value === "string" && QUERY_IDENTIFIER_PATTERN.test(value);

// Names per `IN` list. A table or column name is at most 80 characters, so a
// full chunk stays far below the URL length a GET can carry.
const NAME_CHUNK_SIZE = 50;

// Well under any instance's row cap, so a short page always means "last page".
const SCOPE_OWNERSHIP_PAGE_SIZE = 1000;

/**
 * Pages `query` over `table`. A skippable refusal (400/403/404) is reported
 * through `onSkip` and reads as no rows; anything else is thrown, so an outage
 * can never pass for an empty table.
 */
async function readRowsOrSkip(
  client: SNClient,
  table: string,
  query: string,
  fields: string,
  pageSize: number,
  onSkip?: () => void
): Promise<TableAPIRecord[]> {
  try {
    return await tableAPIGetAllRows(client, table, query, fields, pageSize);
  } catch (e) {
    if (!isTableSkippableError(e)) {
      throw e;
    }
    onSkip?.();
    return [];
  }
}

/**
 * The choices that belong to a scope.
 *
 * sys_choice has no `sys_scope` column (see DATA_MODEL_TABLES_WITHOUT_SCOPE), so
 * a choice is attributed through what it describes. It belongs to the scope when
 *
 *  - its table is defined by the scope (sys_db_object), or
 *  - its column is defined by the scope on another scope's table
 *    (sys_dictionary), or
 *  - its choice list is owned by the scope (sys_choice_set, the application
 *    file the platform itself records a choice list under).
 *
 * Ownership is per choice list, not per choice: a single choice a scope adds to
 * a list another scope owns cannot be told apart, because nothing on the row
 * names its scope.
 *
 * Every read is bounded by names taken from the scope, so a scope that owns no
 * table, column or choice list sends no sys_choice request at all. A refused
 * ownership read is reported through `onSkip`: the result is then a partial
 * set, and the caller carries the previously known records forward.
 */
async function getScopeChoiceRows(
  client: SNClient,
  tableName: string,
  scopeId: string,
  tableFields: string,
  operatorQuery: string | undefined,
  onSkip?: () => void
): Promise<TableAPIRecord[]> {
  const readOwnership = (table: string, query: string, fields: string) =>
    readRowsOrSkip(client, table, query, fields, SCOPE_OWNERSHIP_PAGE_SIZE, onSkip);

  // Sequential on purpose: these are three small reads, and the table pool
  // around this call already runs other tables in parallel.
  const tableRows = await readOwnership(
    "sys_db_object",
    `sys_scope=${scopeId}^nameISNOTEMPTY`,
    "name"
  );
  const columnRows = await readOwnership(
    "sys_dictionary",
    `sys_scope=${scopeId}^nameISNOTEMPTY^elementISNOTEMPTY`,
    "name,element"
  );
  const choiceSetRows = await readOwnership(
    "sys_choice_set",
    `sys_scope=${scopeId}^nameISNOTEMPTY^elementISNOTEMPTY`,
    "name,element"
  );

  const ownedTables = new Set<string>();
  for (const row of tableRows) {
    if (isQueryIdentifier(row.name)) {
      ownedTables.add(row.name);
    }
  }
  // table -> columns, for choices on a table the scope does not define. A
  // column of an owned table needs no entry: the table already covers it.
  const ownedColumns = new Map<string, Set<string>>();
  for (const row of [...columnRows, ...choiceSetRows]) {
    if (!isQueryIdentifier(row.name) || !isQueryIdentifier(row.element)) {
      continue;
    }
    if (ownedTables.has(row.name)) {
      continue;
    }
    let columns = ownedColumns.get(row.name);
    if (!columns) {
      columns = new Set<string>();
      ownedColumns.set(row.name, columns);
    }
    columns.add(row.element);
  }

  // Sorted, so the same scope always sends the same requests in the same order.
  const queries: string[] = [];
  for (const chunk of chunkArray([...ownedTables].sort(), NAME_CHUNK_SIZE)) {
    queries.push(`nameIN${chunk.join(",")}`);
  }
  for (const table of [...ownedColumns.keys()].sort()) {
    const columns = [...(ownedColumns.get(table) as Set<string>)].sort();
    for (const chunk of chunkArray(columns, NAME_CHUNK_SIZE)) {
      queries.push(`name=${table}^elementIN${chunk.join(",")}`);
    }
  }

  const rows: TableAPIRecord[] = [];
  for (const ownershipQuery of queries) {
    const query = operatorQuery ? `${ownershipQuery}^${operatorQuery}` : ownershipQuery;
    rows.push(...(await readRowsOrSkip(client, tableName, query, tableFields, 500, onSkip)));
  }
  return rows;
}

/**
 * True when `tableName` or one of its ancestors declares a `sys_scope` column.
 *
 * The walk is strict: unlike getTableHierarchyTableNames it does not swallow a
 * failed lookup, because a hierarchy cut short would report "no scope column"
 * for a table that inherits one, and the table would be dropped from the
 * manifest. The parent lookups are memoized, so after the file-field discovery
 * of the same table this costs the one dictionary request.
 */
async function tableHasScopeColumn(client: SNClient, tableName: string): Promise<boolean> {
  const hierarchy: string[] = [];
  let current: string | undefined = tableName;
  while (
    current &&
    !hierarchy.includes(current) &&
    hierarchy.length < MAX_TABLE_HIERARCHY_DEPTH
  ) {
    hierarchy.push(current);
    current = await getTableParentName(client, current);
  }
  const names = hierarchy.filter(isQueryIdentifier);
  if (names.length === 0) {
    return false;
  }
  // Deliberately unpaged: one row is the whole answer.
  const res = await client.tableAPIGet(
    "sys_dictionary",
    `nameIN${names.join(",")}^element=sys_scope`,
    "name",
    1
  );
  return extractResult(res.data).length > 0;
}

/**
 * Decide how `tableName`'s records are attributed to the scope, or return
 * undefined when the table must be left out of this build.
 *
 * Tables reached through scope discovery and the documented data-model tables
 * keep the scope filter; they are not probed. sys_choice has its own rule. Only
 * a table the operator added to `dataModelTables` by hand is checked for the
 * column, with one dictionary request per build.
 */
async function resolveRecordScoping(
  ctx: TableEnumerationContext,
  tableName: string,
  onSkip: () => void
): Promise<RecordScoping | undefined> {
  if (isScopelessDataModelTable(tableName)) {
    return "choice-owner";
  }
  if (!ctx.dataModelTables.has(tableName) || DATA_MODEL_DEFAULT_TABLES.includes(tableName)) {
    return "scope-column";
  }

  let hasScopeColumn: boolean;
  try {
    hasScopeColumn = await tableHasScopeColumn(ctx.client, tableName);
  } catch (e) {
    if (!isTableSkippableError(e)) {
      throw e;
    }
    // Unknown is not "no": report the skip so the previous entry is kept.
    onSkip();
    return undefined;
  }
  if (hasScopeColumn) {
    return "scope-column";
  }
  if (ctx.tableOptions[tableName]?.query) {
    return "operator-query";
  }
  logger.warn(
    `Table ${tableName} is listed in dataModelTables but has no sys_scope column, so its records cannot be attributed to a scope. It was left out; set tableOptions.${tableName}.query to select its records.`
  );
  return undefined;
}

// ─── Public: buildManifestFromTableAPI ──────────────────────────────────────
// Full equivalent of SincUtilsMS.getManifest() using only Table API

/** Everything one table's enumeration needs, shared by a whole build. */
interface TableEnumerationContext {
  client: SNClient;
  scopeId: string;
  includes: Sync.TablePropMap;
  excludes: Sync.TablePropMap;
  tableOptions: Sync.ITableOptionsMap;
  metaEnabled: boolean;
  /** R4: tables whose records may be represented by the sidecar alone. */
  dataModelTables: ReadonlySet<string>;
}

/** One table's enumeration: its manifest entry (if any) and whether it was cut short. */
interface TableEnumeration {
  table?: SN.TableConfig;
  skipped: boolean;
}

/**
 * Enumerate one table: its file fields, its sidecar columns and its records.
 * Throws for a failure that must fail the build; reports a skippable refusal
 * through `skipped` so the caller can carry the previous entry forward.
 */
async function enumerateTable(
  ctx: TableEnumerationContext,
  tableName: string
): Promise<TableEnumeration> {
  const { client, scopeId, includes, excludes, tableOptions, metaEnabled } = ctx;
  let skipped = false;
  const onSkip = () => {
    skipped = true;
  };
  let hierarchyTableNames: string[] | undefined;
  const files = await getFileFieldsForTable(
    client,
    tableName,
    includes,
    excludes,
    onSkip,
    (names) => {
      hierarchyTableNames = names;
    }
  );
  // A table with no field file has nothing to write — unless it is an opted-in
  // data-model table (R4), whose records are their sidecar and nothing else.
  // Without metadata there is no sidecar either, so `meta: false` keeps the
  // early return for those tables too.
  const sidecarOnly =
    files.length === 0 && metaEnabled && ctx.dataModelTables.has(tableName);
  if (files.length === 0 && !sidecarOnly) {
    return { skipped };
  }

  const meta = metaEnabled
    ? await getMetaFieldsForTable(
        client,
        tableName,
        files.map((f) => f.name),
        tableOptions[tableName],
        hierarchyTableNames
      )
    : NO_META_FIELDS;
  const hasMeta = meta.fields.length > 0;
  if (sidecarOnly && !hasMeta) {
    // A record with neither files nor a sidecar is not representable. When the
    // table has no writable column it is left out exactly as before R4. When
    // the dictionary read FAILED (getMetaFieldsForTable warned), dropping the
    // table would replace a good manifest entry with nothing: push would ignore
    // the existing sidecars and repair --prune would call them orphans. Report
    // a skip instead, so the previous entry is carried forward.
    return { skipped: skipped || meta === UNREADABLE_META_FIELDS };
  }

  const scoping = await resolveRecordScoping(ctx, tableName, onSkip);
  if (!scoping) {
    return { skipped };
  }

  const records = await getRecordsForTable(
    client,
    tableName,
    scopeId,
    files,
    tableOptions[tableName],
    onSkip,
    hasMeta ? [...files, metaFile()] : files,
    scoping
  );
  if (Object.keys(records).length === 0) {
    return { skipped };
  }

  // metaReadOnlyFields is omitted when empty rather than written as []: the
  // manifest is diffed by humans and committed, so an always-present empty
  // key would be noise on every table that has no read-only column.
  //
  // A partially refused read (one `sys_idIN` chunk denied while the others
  // answered) still yields records — but an incomplete set. Committing it as
  // authoritative is the same data loss as dropping the table: the records
  // that fell out stop mapping to their local files, so `push` ignores edits
  // to them and `repair --prune` deletes them. `skipped` is reported so the
  // carry-forward restores whatever the refused part would have held.
  const table: SN.TableConfig = !hasMeta
    ? { records }
    : meta.readOnly.length > 0
      ? { records, metaFields: meta.fields, metaReadOnlyFields: meta.readOnly }
      : { records, metaFields: meta.fields };
  return { table, skipped };
}

/**
 * Enumerate `tableNames` through a bounded pool into `tables`, then carry the
 * previous entries forward for every table the instance refused. Throws when a
 * table failed outright.
 */
async function enumerateTables(
  ctx: TableEnumerationContext,
  scopeName: string,
  tableNames: string[],
  tables: SN.AppManifest["tables"],
  concurrencyConfig: unknown
): Promise<void> {
  const failedTables: string[] = [];
  // Tables whose enumeration was cut short by a skippable 400/403/404. They are
  // NOT "empty" — see the carry-forward below.
  const skippedTables: string[] = [];

  // PERF-7 (REV-100): enumerate tables through a bounded pool instead of a single
  // Promise.all that opened one request chain per table at once.
  await mapWithConcurrency(
    tableNames,
    resolveManifestTableConcurrency(concurrencyConfig),
    async (tableName) => {
      try {
        const result = await enumerateTable(ctx, tableName);
        if (result.table) tables[tableName] = result.table;
        if (result.skipped) skippedTables.push(tableName);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`Failed to enumerate table ${tableName}: ${message}`);
        failedTables.push(tableName);
      }
    }
  );

  if (failedTables.length > 0) {
    // Better to fail the whole build than to persist a partial manifest in
    // which the failed tables look like they have no records.
    throw new Error(
      `Manifest build incomplete — failed tables: ${failedTables.sort().join(", ")}`
    );
  }

  // A table the instance refused (ACL, temporarily unreadable) used to be
  // dropped from the rebuilt manifest exactly like a table with no records. The
  // rebuilt manifest then replaced the good one, so every already-downloaded
  // file of that table stopped mapping to a record: `push` silently ignored
  // edits to them and `repair --prune` classified them as orphans. Carry the
  // previous entries forward instead, and say so.
  if (skippedTables.length > 0) {
    const previous = getPreviousManifest(scopeName);
    const carried: string[] = [];
    for (const tableName of skippedTables.sort()) {
      const priorTable = previous?.tables?.[tableName];
      if (!priorTable || Object.keys(priorTable.records || {}).length === 0) {
        continue;
      }
      const current = tables[tableName]?.records;
      tables[tableName] =
        current && Object.keys(current).length > 0
          ? // Partial read: keep every record just enumerated (they are the
            // fresher truth) and restore only the ones the refused part of the
            // read would have silently dropped.
            { ...priorTable, records: { ...priorTable.records, ...current } }
          : priorTable;
      carried.push(tableName);
    }
    logger.warn(
      `Could not fully read ${skippedTables.length} table(s) while building the manifest for "${scopeName}" (no access or not queryable): ${skippedTables.join(", ")}.` +
        (carried.length > 0
          ? ` Kept the previously known records for: ${carried.join(", ")}.`
          : "")
    );
  }
}

type ManifestBuildConfig = Pick<
  Sync.Config,
  "includes" | "excludes" | "tableOptions" | "meta" | "dataModelTables"
>;

/** The enumeration context for `config`, with the R4 opt-in applied. */
function tableEnumerationContext(
  client: SNClient,
  scopeId: string,
  config: ManifestBuildConfig
): TableEnumerationContext {
  return {
    client,
    scopeId,
    // R4: an opted-in table is re-included even when it is excluded by default,
    // and its records get the data-model naming rule.
    includes: applyDataModelIncludes(config),
    excludes: config.excludes || {},
    tableOptions: applyDataModelTableOptions(config),
    // DX22: opt-out, not opt-in. A workspace holding only the scripts of its
    // records is missing most of what defines them, and a default-off flag would
    // have left every existing project in that state indefinitely.
    metaEnabled: config.meta !== false,
    dataModelTables: new Set(getDataModelTables(config)),
  };
}

/**
 * Options for {@link buildManifestFromTableAPI}.
 *
 * `allowEmpty` lifts the empty-manifest refusal. Only `init --new` sets it, for
 * the application it has just created: that scope is known to exist (its
 * sys_app insert returned the sys_id) and is expected to own nothing yet, so an
 * empty result is the truth rather than a symptom of a wrong scope or missing
 * access. Every other caller (`download`, `refresh`, the `init` wizard) binds an
 * EXISTING scope and must keep the refusal.
 */
export type BuildManifestOptions = {
  allowEmpty?: boolean;
};

export async function buildManifestFromTableAPI(
  scopeName: string,
  client: SNClient,
  config: ManifestBuildConfig,
  options: BuildManifestOptions = {}
): Promise<SN.AppManifest> {
  // One build is one run: every table in a scope shares most of its ancestry,
  // and the walk is memoized for the duration rather than across the process.
  resetTableHierarchyCache();

  const scopeId = await getScopeId(client, scopeName);
  if (!scopeId) {
    throw new Error(
      `Scope "${scopeName}" not found on this instance. Check the scope code.`
    );
  }
  const ctx = tableEnumerationContext(client, scopeId, config);

  const discovered = await getTableNamesInScope(
    client,
    scopeName,
    scopeId,
    ctx.includes,
    ctx.excludes
  );
  if (discovered.length === 0 && options.allowEmpty === true) {
    // A just-created scope: bind it with an empty manifest that carries its
    // sys_id, so the first `push --create` needs no sys_scope lookup and the
    // directory is bound even though the scope has nothing to download.
    //
    // The premise "a new application owns no sys_metadata rows" is NOT verified
    // on a live instance. The sys_app insert may well create rows of its own
    // (e.g. a sys_app_module / menu, or the sys_app row itself being indexed
    // under the scope); when it does, `discovered` is non-empty and the normal
    // enumeration below runs, which is equally correct.
    return { scope: scopeName, scopeId, tables: Object.create(null) };
  }
  if (discovered.length === 0) {
    // A populated scope never has zero discoverable tables; an empty result
    // here almost always means connectivity/ACL trouble. Refuse to build an
    // empty manifest that would overwrite a previously good one.
    throw new Error(
      `No tables discovered for scope "${scopeName}". ` +
        "Refusing to build an empty manifest (check connectivity, credentials, and ACLs)."
    );
  }
  // R4: an opted-in table is enumerated even when the sys_metadata sweep did
  // not list it (a table it found nothing in yields no entry, as before). An
  // explicit `includes.<table>: false` switches it off here too.
  const tableNames = [...discovered];
  for (const tableName of ctx.dataModelTables) {
    if (ctx.includes[tableName] !== false && !tableNames.includes(tableName)) {
      tableNames.push(tableName);
    }
  }

  // INJ-2, same reason as buildBulkDownloadFromTableAPI's result map: the table
  // key is instance data, `tables["__proto__"] = …` on a literal creates no own
  // property, and a table that vanishes from the manifest takes every one of its
  // local files out of the push with it. The carry-forward assigns into this
  // map too, from a manifest read off disk.
  const manifest: SN.AppManifest = {
    scope: scopeName,
    tables: Object.create(null),
  };
  await enumerateTables(ctx, scopeName, tableNames, manifest.tables, config);
  return manifest;
}

// ─── Public: attachDataModelTablesToManifest ─────────────────────────────────

/**
 * R4 on the companion-app path: add the opted-in data-model tables to a
 * manifest the scoped `sinc/getManifest` endpoint produced.
 *
 * That endpoint predates R4: it never lists a table without field files, and it
 * names records by their display value alone. Every opted-in table is therefore
 * (re)built here through the Table API, replacing whatever entry the endpoint
 * returned, so a data-model record has the same name and the same sidecar on
 * both paths. A no-op when nothing is opted in or `meta: false`.
 *
 * Mutates and returns `manifest`. Throws, like the builder, when a table fails.
 */
export async function attachDataModelTablesToManifest(
  manifest: SN.AppManifest,
  client: SNClient,
  config: ManifestBuildConfig
): Promise<SN.AppManifest> {
  const tables = getDataModelTables(config);
  if (tables.length === 0 || config.meta === false) {
    return manifest;
  }
  const scopeId = manifest.scopeId || (await getScopeId(client, manifest.scope));
  if (!scopeId) {
    throw new Error(
      `Scope "${manifest.scope}" not found on this instance. Check the scope code.`
    );
  }
  resetTableHierarchyCache();
  const ctx = tableEnumerationContext(client, scopeId, config);
  const wanted = tables.filter((tableName) => ctx.includes[tableName] !== false);
  // Built into a fresh map first: a table that comes back empty must REPLACE
  // the endpoint's entry (named by the old rule), not leave it in place.
  const built: SN.AppManifest["tables"] = Object.create(null);
  await enumerateTables(ctx, manifest.scope, wanted, built, config);
  const merged: SN.AppManifest["tables"] = Object.assign(
    Object.create(null),
    manifest.tables || {}
  );
  for (const tableName of wanted) {
    if (Object.prototype.hasOwnProperty.call(built, tableName)) {
      merged[tableName] = built[tableName];
    } else {
      delete merged[tableName];
    }
  }
  manifest.tables = merged;
  return manifest;
}

// ─── Public: discoverTableMetaFields ─────────────────────────────────────────

/**
 * R4: the sidecar columns of one table, discovered exactly as a manifest build
 * would (the file fields are removed first, the denylist and the read-only
 * rules apply). `push --create` uses it for a sidecar-only data-model record
 * whose table the manifest does not know yet — without it the sidecar cannot be
 * resolved and the create fails on the degraded-manifest check.
 *
 * Returns empty lists when the dictionary cannot be read; the caller then
 * reports the record as not creatable rather than posting a guess.
 */
export async function discoverTableMetaFields(
  client: SNClient,
  tableName: string,
  config: ManifestBuildConfig
): Promise<{ fields: string[]; readOnly: string[] }> {
  const ctx = tableEnumerationContext(client, "", config);
  let hierarchyTableNames: string[] | undefined;
  const files = await getFileFieldsForTable(
    client,
    tableName,
    ctx.includes,
    ctx.excludes,
    undefined,
    (names) => {
      hierarchyTableNames = names;
    }
  );
  return getMetaFieldsForTable(
    client,
    tableName,
    files.map((f) => f.name),
    ctx.tableOptions[tableName],
    hierarchyTableNames
  );
}

// Best-effort read of the manifest currently loaded in memory, used only to
// preserve entries for tables this run could not read. Returns undefined when
// no config/manifest is loaded (first-run wizard) or it belongs to another scope.
function getPreviousManifest(scopeName: string): SN.AppManifest | undefined {
  try {
    const existing = ConfigManager.getManifest(true);
    return existing && existing.scope === scopeName ? existing : undefined;
  } catch (_e) {
    return undefined;
  }
}

// ─── Public: attachMetaFieldsToManifest ──────────────────────────────────────

/**
 * DX22, second half: give a manifest the metadata layer it was built without.
 *
 * buildManifestFromTableAPI discovers the sidecar columns while it enumerates
 * each table, so a locally-built manifest arrives complete. The companion
 * Sincronia scoped app does not: `sinc/getManifest` predates DX22 and answers
 * with records whose `files` list holds the file fields and nothing else. Every
 * consumer downstream keys off `TableConfig.metaFields` and the `.meta`
 * pseudo-file, so on exactly the instances that DO have the scoped app
 * installed — the recommended setup — the whole metadata layer did nothing at
 * all, silently and without a warning.
 *
 * Enriching here rather than in a new scoped-app release is what lets the fix
 * reach instances as they already are: nothing has to be installed or upgraded
 * on ServiceNow for `.meta.json` to start appearing.
 *
 * Mutates and returns `manifest`. Idempotent: a table that already carries
 * `metaFields` — a Table-API build, or a second pass over the same object — is
 * left exactly as it is, which is also what keeps this safe to call on the
 * fallback path's output.
 */
export async function attachMetaFieldsToManifest(
  manifest: SN.AppManifest,
  client: SNClient,
  config: Pick<Sync.Config, "tableOptions" | "meta"> &
    Partial<Pick<Sync.Config, "includes" | "excludes" | "dataModelTables">>
): Promise<SN.AppManifest> {
  // Same opt-out as the builder: `meta: false` means a project has decided it
  // wants the pre-DX22 workspace, and that decision must hold on both paths.
  if (config.meta === false) {
    return manifest;
  }
  // R4: the scoped endpoint lists no sidecar-only table at all, so the opted-in
  // data-model tables are added (and named) here first. Every caller that
  // enriches a scoped manifest gets them without a second call to forget.
  await attachDataModelTablesToManifest(manifest, client, config);
  const tableOptions = config.tableOptions || {};

  const pending = Object.entries(manifest.tables || {}).filter(
    ([, table]) => !Array.isArray(table.metaFields) || table.metaFields.length === 0
  );
  if (pending.length === 0) {
    return manifest;
  }
  // One enrichment is one run: the tables about to be walked share their parents
  // almost entirely, and this is the pass that pays for it.
  resetTableHierarchyCache();

  await mapWithConcurrency(
    pending,
    resolveManifestTableConcurrency(config),
    async ([tableName, table]) => {
      const records = Object.values(table.records || {});
      if (records.length === 0) {
        return;
      }

      // The file fields as this manifest actually lists them — the set the
      // dictionary query has to exclude. Unioned across every record rather
      // than read off the first: a column that is empty on one record yields no
      // file for it, and taking that record alone would re-admit the column as
      // metadata and write it twice.
      const fileFieldNames = new Set<string>();
      for (const record of records) {
        for (const file of record.files || []) {
          if (!isMetaFile(file)) {
            fileFieldNames.add(file.name);
          }
        }
      }

      // Errors are already swallowed inside getMetaFieldsForTable: a table
      // whose dictionary this user cannot read keeps its scripts and loses only
      // the sidecar, which is the pre-DX22 result rather than a failed refresh.
      const meta = await getMetaFieldsForTable(
        client,
        tableName,
        [...fileFieldNames],
        tableOptions[tableName]
      );
      if (meta.fields.length === 0) {
        return;
      }

      for (const record of records) {
        if (!Array.isArray(record.files)) {
          record.files = [];
        }
        if (!record.files.some(isMetaFile)) {
          record.files.push(metaFile());
        }
      }
      table.metaFields = meta.fields;
      // Omitted when empty for the same reason as in the builder: the manifest
      // is committed and read by humans, so an always-present `[]` is noise.
      if (meta.readOnly.length > 0) {
        table.metaReadOnlyFields = meta.readOnly;
      }
    }
  );

  return manifest;
}

// ─── Public: applyIncludeTypeRulesToManifest ─────────────────────────────────

/**
 * The `includes` type filter for a manifest the scoped endpoint answered.
 *
 * buildManifestFromTableAPI judges every included column by its dictionary type
 * (appendIncludedFields). The scoped endpoint lists whatever `includes` names
 * and returns no types, so without this a `password2` column named in
 * `includes` was listed, downloaded and written to the working tree on init,
 * refresh and download alike. Same lookup (one sys_dictionary query per table
 * over its hierarchy), same classifyColumn verdict, same once-per-build
 * warnings: an unsafe column is removed from every record of the table — its
 * content with it, so nothing writes it and nothing later asks for it — and a
 * column whose type cannot be read is kept with a warning.
 *
 * Mutates `manifest`; only tables with a field-level `includes` entry the
 * manifest lists cost a request. Call it on the scoped answer only: a Table-API
 * build has already been through the filter, and the reset below would repeat
 * its warnings.
 */
export async function applyIncludeTypeRulesToManifest(
  manifest: SN.AppManifest,
  client: SNClient,
  config: Pick<Sync.Config, "includes" | "dataModelTables">
): Promise<SN.AppManifest> {
  const includes = applyDataModelIncludes(config);
  const pending = Object.entries(manifest.tables || {})
    .map(([tableName, table]) => {
      const records = Object.values(table.records || {});
      const listed = new Set(
        records.flatMap((record) => (record.files || []).map((file) => file.name))
      );
      const columns = includedFieldNames(includes, tableName).filter((name) => listed.has(name));
      return { tableName, records, columns };
    })
    .filter(({ columns }) => columns.length > 0);
  if (pending.length === 0) {
    return manifest;
  }
  resetTableHierarchyCache();

  await mapWithConcurrency(
    pending,
    resolveManifestTableConcurrency(config),
    async ({ tableName, records, columns }) => {
      let types: Map<string, string>;
      try {
        const hierarchy = await getTableHierarchyTableNames(client, tableName);
        const tableNameQuery = hierarchy.map((name) => `name=${name}`).join("^OR");
        types = await readColumnTypes(client, tableName, tableNameQuery, columns);
      } catch (e) {
        warnUntypedIncludes(tableName, columns, e instanceof Error ? e.message : String(e));
        return;
      }
      const unsafe = new Set<string>();
      const untyped: string[] = [];
      for (const column of columns) {
        const type = types.get(column);
        const verdict = classifyColumn(tableName, column, type);
        if (verdict === "unsafe") {
          unsafe.add(column);
          warnUnsafeInclude(tableName, column, type as string);
        } else if (verdict === "unknown") {
          untyped.push(column);
        }
      }
      warnUntypedIncludes(tableName, untyped, NO_DICTIONARY_TYPE);
      if (unsafe.size === 0) {
        return;
      }
      for (const record of records) {
        record.files = (record.files || []).filter((file) => !unsafe.has(file.name));
      }
    }
  );
  return manifest;
}

// ─── Public: buildBulkDownloadFromTableAPI ───────────────────────────────────
// Full equivalent of SincUtilsMS.processMissingFiles() using only Table API

/**
 * Record names exactly as the manifest stores them, keyed by table and then by
 * sys_id. Callers build this from the manifest that produced the missing map
 * (see buildManifestRecordNames in downloadPipeline).
 */
export type ManifestRecordNames = Record<string, Record<string, string>>;

/**
 * DX22: the sidecar columns per table, exactly as the manifest recorded them.
 * The download side cannot re-derive this — it holds only the missing subset,
 * not the dictionary — so the caller reads it off the manifest that produced the
 * missing map (see buildManifestMetaFields in downloadPipeline).
 */
export type ManifestMetaFields = Record<string, string[]>;

export async function buildBulkDownloadFromTableAPI(
  missingFiles: SN.MissingFileTableMap,
  client: SNClient,
  tableOptions: Sync.ITableOptionsMap,
  recordNames?: ManifestRecordNames,
  metaFieldsByTable?: ManifestMetaFields
): Promise<SN.TableMap> {
  // INJ-2 one level above setRecord, which has stored record NAMES safely for a
  // while. The table key comes from the missing-file map, i.e. from
  // sync.manifest.json — a file people hand-edit and git-merge, and one where
  // JSON.parse turns "__proto__" into an ordinary own property. Assigning that
  // key on an object literal invokes the inherited setter: no own property is
  // created, and because the value is an object the assignment reparents
  // `result` instead. mergeTableMaps iterates own keys, so the whole table —
  // every record in it, scripts and sidecars alike — disappeared between the
  // fetch and the writer while the run reported success, and the next refresh
  // found the same files missing and fetched them again.
  const result: SN.TableMap = Object.create(null);

  await Promise.all(
    Object.entries(missingFiles).map(async ([tableName, recordMap]) => {
      const sysIds = Object.keys(recordMap);
      if (sysIds.length === 0) return;

      const tableOpts = tableOptions[tableName];
      const defaultDisplayField = getDisplayField(tableName);

      // Collect all unique file fields across missing records. DX22: the `.meta`
      // pseudo-file is filtered out here — it names no column, so leaving it in
      // would put ".meta" into sysparm_fields and make the whole projection
      // invalid. It is re-attached per record after the row is read.
      const allFiles = new Map<string, SN.FileType>();
      let metaRequested = false;
      for (const files of Object.values(recordMap)) {
        for (const f of files) {
          if (isMetaFile(f)) {
            metaRequested = true;
            continue;
          }
          allFiles.set(f.name, f.type as SN.FileType);
        }
      }
      const metaFields = metaFieldsByTable?.[tableName] ?? [];
      const wantMeta = metaRequested && metaFields.length > 0;

      // Same field list as the manifest path so record names stay in parity —
      // plus the sidecar columns, which only this path (not the manifest build)
      // needs the values of.
      // A field file a record-level secret rule governs is judged per row here
      // as well as in the manifest build: a manifest from the scoped endpoint,
      // or one written before the rule applied to field files, still lists
      // `sys_properties.value` for a password property.
      const secretRuleColumns = [...allFiles.keys()].filter(
        (name) => classifyColumn(tableName, name) === "secret"
      );
      const governsFileField = secretRuleColumns.length > 0;
      const tableFields = buildRecordFieldList(
        defaultDisplayField,
        wantMeta || governsFileField
          ? [
              ...allFiles.keys(),
              ...(wantMeta ? metaFields : []),
              ...metaSecretClassifierFields(tableName),
            ]
          : [...allFiles.keys()],
        tableOpts
      );

      try {
        // Chunk the sys_id list so large record sets cannot overflow the URL
        // length limit (mirrors getRecordsForTable). Deliberately unpaged for
        // the same reason as that fallback: 200 unique sys_ids per request
        // against a limit of 500 cannot truncate.
        const rows: TableAPIRecord[] = [];
        for (const chunk of chunkArray(sysIds, SYS_ID_CHUNK_SIZE)) {
          const res = await client.tableAPIGet(
            tableName,
            `sys_idIN${chunk.join(",")}`,
            tableFields,
            500
          );
          rows.push(...extractResult(res.data));
        }
        const records: SN.TableConfigRecords = {};
        const unreturnedFields = new Set<string>();
        let unusableRows = 0;
        let withheldSecrets = 0;

        const namesForTable = recordNames?.[tableName];

        for (const row of rows) {
          // Same rule as the manifest path: no sys_id, no record. The download
          // writes at `<table>/<name>` and reports progress per record, so a row
          // that cannot be named or keyed is dropped with a count instead of
          // becoming an "undefined" folder.
          const sysId = recordSysId(row);
          if (!isSafePathComponent(sysId)) {
            unusableRows += 1;
            continue;
          }
          // The MANIFEST decides where a record lives on disk, not this
          // response: getRecordsForTable suffixes a colliding display name with
          // its sys_id, processTablesInManifest writes at `<table>/<rec.name>`
          // and findMissingFiles probes the manifest key. Deriving the name here
          // a second time broke that parity for every disambiguated record — the
          // downloader wrote at a path the manifest did not know, so the record
          // stayed "missing" on every subsequent run and `repair --apply --prune`
          // deleted the freshly written file as an orphan. It cannot be
          // recomputed either: this call sees only the MISSING subset, so one
          // member of a colliding pair looks unique and loses its suffix.
          //
          // buildRecordName remains the fallback for a caller that supplied no
          // map. It must receive the DEFAULT display field — it applies the
          // tableOptions.displayField override itself (override -> default ->
          // sys_id), exactly as getRecordsForTable does, and passing the already
          // resolved override collapses that chain.
          const manifestName = namesForTable?.[sysId];
          const name =
            typeof manifestName === "string" && manifestName.length > 0
              ? manifestName
              : buildRecordName(row, defaultDisplayField, tableOpts);
          // buildRecordName returns "" when neither the display value nor the
          // sys_id can be a path component. A supplied manifest name is NOT
          // filtered here: downloadPipeline default-denies it loudly, which is the
          // right outcome for a manifest that asks for an impossible path —
          // dropping it silently would leave the record "missing" on every run.
          if (!name) {
            unusableRows += 1;
            continue;
          }
          const files: SN.File[] = [];
          const secretColumns = governsFileField
            ? new Set(metaSecretColumns(tableName, row))
            : undefined;

          for (const [fieldName, fieldType] of allFiles.entries()) {
            // Withheld, not blanked: no file is produced, so a local copy is
            // left as it is and nothing is written that a push could send back.
            if (secretColumns?.has(fieldName)) {
              withheldSecrets += 1;
              continue;
            }
            // A field the response did not return AT ALL (column-level ACL,
            // dropped from the projection) is "not fetched" — not "empty".
            // `row[fieldName] || ""` erased that distinction, and because
            // downloadAllFiles writes with forceWrite the resulting empty
            // string overwrote the local file: silent data loss on every
            // download of a read-restricted field. Omit the file instead, so
            // the existing content is left untouched.
            //
            // Own properties only. `fieldName` is a `sys_dictionary.element`,
            // and `constructor`/`toString`/`valueOf` are valid ServiceNow
            // column names that a bare `in` finds on Object.prototype — so a
            // field the row never carried walked past this guard and was
            // written to disk with a native function body as its content.
            if (!Object.prototype.hasOwnProperty.call(row, fieldName)) {
              unreturnedFields.add(fieldName);
              continue;
            }
            files.push({
              name: fieldName,
              type: fieldType,
              content: row[fieldName] ?? "",
            });
          }

          // DX22: the sidecar is synthesized, not fetched — it is one JSON
          // document built from columns the row already carries, so it costs no
          // extra request. Only for records that actually asked for it: a
          // targeted refresh may be re-fetching one field of one record.
          if (wantMeta && (recordMap[sysId] ?? []).some(isMetaFile)) {
            files.push({
              name: META_FILE_NAME,
              type: META_FILE_TYPE,
              content: serializeMetaFields(row, metaFields, tableName),
            });
          }

          setRecord(records, name, { sys_id: sysId, name, files });
        }

        if (unusableRows > 0) {
          logger.warn(
            `Table ${tableName}: skipped ${unusableRows} record(s) the instance returned without a usable sys_id.`
          );
        }

        if (withheldSecrets > 0) {
          // Info, not warn: it is the rule working, and `dev` re-runs this on
          // every refresh interval at warn level.
          logger.info(
            `Table ${tableName}: withheld ${withheldSecrets} secret field value(s) ` +
              `(${secretRuleColumns.join(", ")} of a password-typed or unclassifiable ` +
              "record) — they are never written to the working tree."
          );
        }

        if (unreturnedFields.size > 0) {
          logger.warn(
            `Table ${tableName}: the instance returned no value for field(s) ${[...unreturnedFields]
              .sort()
              .join(", ")} — leaving the local file(s) untouched instead of blanking them.`
          );
        }

        if (Object.keys(records).length > 0) {
          result[tableName] = { records };
        }
      } catch (e) {
        if (!isTableSkippableError(e)) {
          throw e;
        }
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`Skipping inaccessible table ${tableName}: ${message}`);
      }
    })
  );

  return result;
}

// ─── Public: listAppsFromTableAPI ────────────────────────────────────────────
// Equivalent of SincUtilsMS.getAppList() — queries sys_app directly

export async function listAppsFromTableAPI(
  client: SNClient
): Promise<SN.App[]> {
  try {
    // Paged. This feeds the `init` application picker, so a truncated list does
    // not error — the app the user came to provision is simply not offered, and
    // there is no signal distinguishing that from "the instance does not have
    // it". Instances with more than 200 active applications are ordinary once
    // store apps are counted.
    const rows = await tableAPIGetAllRows(
      client,
      "sys_app",
      "active=true",
      "sys_id,scope,name",
      200
    );
    return rows.map((r) => ({
      sys_id: r.sys_id,
      scope: r.scope,
      displayName: r.name,
    }));
  } catch (e) {
    // "No apps" and "the request failed" are different answers: only report
    // an empty list when the endpoint itself is unavailable (ACL/404).
    if (!isTableSkippableError(e)) {
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`sys_app listing unavailable, returning empty app list: ${message}`);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isScopedEndpointUnavailableError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { response?: { status?: number }; status?: number };
  const status = err.response?.status ?? err.status;
  return typeof status === "number" && isEndpointNotFoundStatus(status);
}

export function isNotFoundError(e: unknown): boolean {
  return isScopedEndpointUnavailableError(e);
}
