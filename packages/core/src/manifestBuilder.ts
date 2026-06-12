import { SN, Sync } from "@syncrona/types";
import { isEndpointNotFoundStatus } from "@syncrona/sn-transport";
import { SN_TYPE_MAP, SN_TYPE_QUERY, getDisplayField } from "./fieldMap";
import type { SNClient } from "./snClient";
import { getErrorResponseStatus } from "./snClient";
import { logger } from "./Logger";

type TableAPIRecord = Record<string, string>;
type TableAPIResponse = { result: TableAPIRecord[] };
const MAX_TABLE_HIERARCHY_DEPTH = 10;
const SYS_ID_CHUNK_SIZE = 200;

// 400/403/404 mean the table is not queryable for this user/instance (ACL,
// missing table) — a legitimate "skip this table" case. Anything else
// (network, 5xx, auth) is a real failure that must NOT be treated as
// "no records", otherwise an outage silently produces a truncated manifest.
function isTableSkippableError(e: unknown): boolean {
  const status = getErrorResponseStatus(e);
  return typeof status === "number" && isEndpointNotFoundStatus(status);
}

// Pages through the Table API so tables with more rows than the page size are
// fully enumerated instead of silently truncated.
async function tableAPIGetAllRows(
  client: SNClient,
  table: string,
  query: string,
  fields: string,
  pageSize: number
): Promise<TableAPIRecord[]> {
  const rows: TableAPIRecord[] = [];
  let offset = 0;
  for (;;) {
    const res = await client.tableAPIGet(table, query, fields, pageSize, offset);
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
    const res = await client.tableAPIGet(
      "sys_app",
      `scope=${scopeName}`,
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
    const res = await client.tableAPIGet(
      "sys_db_object",
      `sys_scope=${scopeId}^nameISNOTEMPTY`,
      "name",
      10000
    );
    return filterUniqueTableNames(extractResult(res.data), includes, excludes);
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
    const res = await client.tableAPIGet(
      "sys_dictionary",
      `sys_scope=${scopeId}^nameISNOTEMPTY`,
      "name",
      10000
    );
    const tables = filterUniqueTableNames(extractResult(res.data), includes, excludes);
    if (tables.length > 0) {
      return tables;
    }
  } catch {
  }

  try {
    const res = await client.tableAPIGet(
      "sys_dictionary",
      `nameLIKE${scopeName}^nameISNOTEMPTY`,
      "name",
      10000
    );
    return filterUniqueTableNames(extractResult(res.data), includes, excludes);
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
  excludes: Sync.TablePropMap
): Promise<SN.File[]> {
  try {
    // ATF step script is stored in inputs.script and is not reliably available via dictionary.
    if (tableName === "sys_atf_step") {
      return [{ name: "inputs.script", type: "js" as SN.FileType }];
    }

    const hierarchyTableNames = await getTableHierarchyTableNames(client, tableName);
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

    const res = await client.tableAPIGet(
      "sys_dictionary",
      query,
      "element,internal_type",
      200
    );
    const rows = extractResult(res.data);
    const files: SN.File[] = rows
      .filter((r) => r.element && r.internal_type)
      .map((r) => ({
        name: r.element,
        type: (SN_TYPE_MAP[r.internal_type] || "txt") as SN.FileType,
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
      return getTextFieldsForTable(client, tableName, includes, excludes, hierarchyTableNames);
    }

    return files;
  } catch (e) {
    // Only an inaccessible table may look like "no file fields"; a network
    // failure must propagate so the table lands in failedTables instead of
    // silently vanishing from the manifest.
    if (!isTableSkippableError(e)) {
      throw e;
    }
    return [];
  }
}

async function getTextFieldsForTable(
  client: SNClient,
  tableName: string,
  includes: Sync.TablePropMap,
  excludes: Sync.TablePropMap,
  hierarchyTableNames?: string[]
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

    const res = await client.tableAPIGet(
      "sys_dictionary",
      query,
      "element",
      500
    );

    const seen = new Set<string>();
    const files: SN.File[] = [];
    for (const row of extractResult(res.data)) {
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
    return [];
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
      const res = await client.tableAPIGet(
        "sys_db_object",
        `name=${current}`,
        "name,super_class.name",
        1
      );
      const rows = extractResult(res.data);
      const parentName = rows[0]?.["super_class.name"];
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

function buildRecordName(
  record: TableAPIRecord,
  displayField: string,
  tableOptions: Sync.ITableOptions | undefined
): string {
  let name = tableOptions?.displayField
    ? record[tableOptions.displayField] || record[displayField] || record.sys_id
    : record[displayField] || record.sys_id;

  if (tableOptions?.differentiatorField) {
    const isStringDiff = typeof tableOptions.differentiatorField === "string";
    const diffFields: string[] = isStringDiff
      ? [tableOptions.differentiatorField as string]
      : [...tableOptions.differentiatorField];
    for (const field of diffFields) {
      const val = record[field];
      if (val) {
        // Match SincUtilsMS behavior: string uses only value, array uses field:value.
        name = isStringDiff ? `${name} (${val})` : `${name} (${field}:${val})`;
        break;
      }
    }
  }

  // Match server-side: replace path separators
  return (name || record.sys_id).replace(/[/\\]/g, "〳");
}

async function getRecordsForTable(
  client: SNClient,
  tableName: string,
  scopeId: string,
  files: SN.File[],
  tableOptions: Sync.ITableOptions | undefined
): Promise<SN.TableConfigRecords> {
  const displayField = getDisplayField(tableName);
  const fileFields = files.map((f) => f.name).join(",");
  const baseQuery = `sys_scope=${scopeId}^sys_class_name=${tableName}`;
  const query = tableOptions?.query
    ? `${baseQuery}^${tableOptions.query}`
    : baseQuery;

  const tableFields = `sys_id,${displayField},${fileFields}`;

  const toRecords = (rows: TableAPIRecord[]): SN.TableConfigRecords => {
    const records: SN.TableConfigRecords = {};

    for (const row of rows) {
      const name = buildRecordName(row, displayField, tableOptions);
      records[name] = {
        sys_id: row.sys_id,
        name,
        files: files.map((f) => ({ name: f.name, type: f.type })),
      };
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
    rows = [];
  }

  if (rows.length > 0) {
    return toRecords(rows);
  }

  const metadataRows = await getScopeMetadataRowsForTable(client, scopeId, tableName);
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
      // Table not accessible — continue with other chunks.
    }
  }

  return toRecords(fallbackRows);
}

async function getScopeMetadataRowsForTable(
  client: SNClient,
  scopeId: string,
  tableName: string
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
  config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions">
): Promise<SN.AppManifest> {
  const includes = config.includes || {};
  const excludes = config.excludes || {};
  const tableOptions = config.tableOptions || {};

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

  await Promise.all(
    tableNames.map(async (tableName) => {
      try {
        const files = await getFileFieldsForTable(client, tableName, includes, excludes);
        if (files.length === 0) return;

        const records = await getRecordsForTable(
          client,
          tableName,
          scopeId,
          files,
          tableOptions[tableName]
        );
        if (Object.keys(records).length === 0) return;

        manifest.tables[tableName] = { records };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`Failed to enumerate table ${tableName}: ${message}`);
        failedTables.push(tableName);
      }
    })
  );

  if (failedTables.length > 0) {
    // Better to fail the whole build than to persist a partial manifest in
    // which the failed tables look like they have no records.
    throw new Error(
      `Manifest build incomplete — failed tables: ${failedTables.sort().join(", ")}`
    );
  }

  return manifest;
}

// ─── Public: buildBulkDownloadFromTableAPI ───────────────────────────────────
// Full equivalent of SincUtilsMS.processMissingFiles() using only Table API

export async function buildBulkDownloadFromTableAPI(
  missingFiles: SN.MissingFileTableMap,
  client: SNClient,
  tableOptions: Sync.ITableOptionsMap
): Promise<SN.TableMap> {
  const result: SN.TableMap = {};

  await Promise.all(
    Object.entries(missingFiles).map(async ([tableName, recordMap]) => {
      const sysIds = Object.keys(recordMap);
      if (sysIds.length === 0) return;

      const tableOpts = tableOptions[tableName];
      const displayField = tableOpts?.displayField || getDisplayField(tableName);

      // Collect all unique file fields across missing records
      const allFiles = new Map<string, SN.FileType>();
      for (const files of Object.values(recordMap)) {
        for (const f of files) {
          allFiles.set(f.name, f.type as SN.FileType);
        }
      }

      const fileFieldNames = [...allFiles.keys()].join(",");

      try {
        // Chunk the sys_id list so large record sets cannot overflow the URL
        // length limit (mirrors getRecordsForTable).
        const rows: TableAPIRecord[] = [];
        for (const chunk of chunkArray(sysIds, SYS_ID_CHUNK_SIZE)) {
          const res = await client.tableAPIGet(
            tableName,
            `sys_idIN${chunk.join(",")}`,
            `sys_id,${displayField},${fileFieldNames}`,
            500
          );
          rows.push(...extractResult(res.data));
        }
        const records: SN.TableConfigRecords = {};

        for (const row of rows) {
          const name = buildRecordName(row, displayField, tableOpts);
          const files: SN.File[] = [];

          for (const [fieldName, fieldType] of allFiles.entries()) {
            files.push({
              name: fieldName,
              type: fieldType,
              content: row[fieldName] || "",
            });
          }

          records[name] = { sys_id: row.sys_id, name, files };
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
    const res = await client.tableAPIGet(
      "sys_app",
      "active=true",
      "sys_id,scope,name",
      200
    );
    const rows = extractResult(res.data);
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
