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
  isMetaFieldCandidate,
  isMetaFile,
  isReadOnlyDictionaryRow,
  metaFile,
  serializeMetaFields,
} from "./metaFields.js";
import type { SNClient } from "./snClient.js";
import { getErrorResponseStatus } from "./snClient.js";
import * as ConfigManager from "./config.js";
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
    const files: SN.File[] = rows
      .filter((r) => r.element && r.internal_type)
      .map((r) => ({
        name: r.element,
        type: getFileTypeForInternalType(r.internal_type) as SN.FileType,
      }));

    // Apply field-level includes overrides
    if (tableName in includes && typeof includes[tableName] === "object") {
      const tableIncludes = includes[tableName] as Sync.FieldMap;
      for (const [fieldName, fieldConfig] of Object.entries(tableIncludes)) {
        if (!files.find((f) => f.name === fieldName)) {
          files.push({ name: fieldName, type: fieldConfig.type || ("txt" as SN.FileType) });
        }
      }
    }

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
      "element",
      500
    );

    const seen = new Set<string>();
    const files: SN.File[] = [];
    for (const row of rows) {
      const fieldName = row.element;
      if (!fieldName || seen.has(fieldName)) {
        continue;
      }
      seen.add(fieldName);
      files.push({ name: fieldName, type: "txt" as SN.FileType });
    }

    if (tableName in includes && typeof includes[tableName] === "object") {
      const tableIncludes = includes[tableName] as Sync.FieldMap;
      for (const [fieldName, fieldConfig] of Object.entries(tableIncludes)) {
        if (!files.find((f) => f.name === fieldName)) {
          files.push({ name: fieldName, type: fieldConfig.type || ("txt" as SN.FileType) });
        }
      }
    }

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
    return NO_META_FIELDS;
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
  let name = override || fieldText(record[displayField]) || sysId;

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
  recordFiles: SN.File[] = files
): Promise<SN.TableConfigRecords> {
  const displayField = getDisplayField(tableName);
  const baseQuery = `sys_scope=${scopeId}^sys_class_name=${tableName}`;
  const query = tableOptions?.query
    ? `${baseQuery}^${tableOptions.query}`
    : baseQuery;

  const tableFields = buildRecordFieldList(
    displayField,
    files.map((f) => f.name),
    tableOptions
  );

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
        return { sysId, name, normalized: name.normalize("NFC").toLowerCase() };
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
        files: recordFiles.map((f) => ({ name: f.name, type: f.type })),
      });
    }

    return records;
  };

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

// ─── Public: buildManifestFromTableAPI ──────────────────────────────────────
// Full equivalent of SincUtilsMS.getManifest() using only Table API

export async function buildManifestFromTableAPI(
  scopeName: string,
  client: SNClient,
  config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions" | "meta">
): Promise<SN.AppManifest> {
  const includes = config.includes || {};
  const excludes = config.excludes || {};
  const tableOptions = config.tableOptions || {};
  // DX22: opt-out, not opt-in. A workspace holding only the scripts of its
  // records is missing most of what defines them, and a default-off flag would
  // have left every existing project in that state indefinitely.
  const metaEnabled = config.meta !== false;
  // One build is one run: every table in a scope shares most of its ancestry,
  // and the walk is memoized for the duration rather than across the process.
  resetTableHierarchyCache();

  const scopeId = await getScopeId(client, scopeName);
  if (!scopeId) {
    throw new Error(
      `Scope "${scopeName}" not found on this instance. Check the scope code.`
    );
  }

  const tableNames = await getTableNamesInScope(client, scopeName, scopeId, includes, excludes);
  if (tableNames.length === 0) {
    // A populated scope never has zero discoverable tables; an empty result
    // here almost always means connectivity/ACL trouble. Refuse to build an
    // empty manifest that would overwrite a previously good one.
    throw new Error(
      `No tables discovered for scope "${scopeName}". ` +
        "Refusing to build an empty manifest (check connectivity, credentials, and ACLs)."
    );
  }

  const manifest: SN.AppManifest = { scope: scopeName, tables: {} };
  const failedTables: string[] = [];
  // Tables whose enumeration was cut short by a skippable 400/403/404. They are
  // NOT "empty" — see the carry-forward below.
  const skippedTables: string[] = [];

  // PERF-7 (REV-100): enumerate tables through a bounded pool instead of a single
  // Promise.all that opened one request chain per table at once.
  const tableConcurrency = resolveManifestTableConcurrency(config);
  await mapWithConcurrency(tableNames, tableConcurrency, async (tableName) => {
    let skipped = false;
    const onSkip = () => {
      skipped = true;
    };
    let hierarchyTableNames: string[] | undefined;
    try {
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
      if (files.length === 0) {
        if (skipped) skippedTables.push(tableName);
        return;
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

      const records = await getRecordsForTable(
        client,
        tableName,
        scopeId,
        files,
        tableOptions[tableName],
        onSkip,
        hasMeta ? [...files, metaFile()] : files
      );
      if (Object.keys(records).length === 0) {
        if (skipped) skippedTables.push(tableName);
        return;
      }

      // metaReadOnlyFields is omitted when empty rather than written as []: the
      // manifest is diffed by humans and committed, so an always-present empty
      // key would be noise on every table that has no read-only column.
      manifest.tables[tableName] = !hasMeta
        ? { records }
        : meta.readOnly.length > 0
          ? { records, metaFields: meta.fields, metaReadOnlyFields: meta.readOnly }
          : { records, metaFields: meta.fields };
      // A partially refused read (one `sys_idIN` chunk denied while the others
      // answered) still yields records — but an incomplete set. Committing it as
      // authoritative is the same data loss as dropping the table: the records
      // that fell out stop mapping to their local files, so `push` ignores edits
      // to them and `repair --prune` deletes them. Report the skip so the
      // carry-forward below restores whatever the refused part would have held.
      if (skipped) skippedTables.push(tableName);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to enumerate table ${tableName}: ${message}`);
      failedTables.push(tableName);
    }
  });

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
      const current = manifest.tables[tableName]?.records;
      manifest.tables[tableName] =
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

  return manifest;
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
  config: Pick<Sync.Config, "tableOptions" | "meta">
): Promise<SN.AppManifest> {
  // Same opt-out as the builder: `meta: false` means a project has decided it
  // wants the pre-DX22 workspace, and that decision must hold on both paths.
  if (config.meta === false) {
    return manifest;
  }
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
  const result: SN.TableMap = {};

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
      const tableFields = buildRecordFieldList(
        defaultDisplayField,
        wantMeta ? [...allFiles.keys(), ...metaFields] : [...allFiles.keys()],
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

          for (const [fieldName, fieldType] of allFiles.entries()) {
            // A field the response did not return AT ALL (column-level ACL,
            // dropped from the projection) is "not fetched" — not "empty".
            // `row[fieldName] || ""` erased that distinction, and because
            // downloadAllFiles writes with forceWrite the resulting empty
            // string overwrote the local file: silent data loss on every
            // download of a read-restricted field. Omit the file instead, so
            // the existing content is left untouched.
            if (!(fieldName in row)) {
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
              content: serializeMetaFields(row, metaFields),
            });
          }

          setRecord(records, name, { sys_id: sysId, name, files });
        }

        if (unusableRows > 0) {
          logger.warn(
            `Table ${tableName}: skipped ${unusableRows} record(s) the instance returned without a usable sys_id.`
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
