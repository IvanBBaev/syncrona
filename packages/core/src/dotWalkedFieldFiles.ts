// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import { logger } from "./Logger.js";
import { isDotWalkedColumn, isMetaFieldName } from "./metaFields.js";

/**
 * The one dot-walked field name the CLI itself requests: the ATF step script,
 * which ServiceNow stores in the `inputs.script` variable of a sys_atf_step
 * (see getFileFieldsForTable). It is that record's own value, not another
 * record's, so it is exempt from the dot-walk refusal on the field-file paths.
 */
export const isPermittedDottedField = (tableName: string, column: string): boolean =>
  tableName === "sys_atf_step" && column === "inputs.script";

/**
 * `table.column` keys already warned about. Cleared with the manifest build's
 * own warning registry (resetTableHierarchyCache), so the warning is once per
 * table and column per build, and once per run for refresh and download.
 */
const warned = new Set<string>();

export const resetDotWalkedFieldFileWarnings = (): void => {
  warned.clear();
};

// The `.meta` sidecar pseudo-file names no column (its dot is a prefix, not a
// walk), so it is never refused here. A name that is not a string at all is
// refused: the manifest is hand-editable JSON, and an array such as
// `["sys_created_by.user_password"]` stringifies into the `fields` list as the
// dot-walk itself while a substring test on the array finds no dot in it.
const refused = (tableName: string, column: unknown): boolean =>
  typeof column !== "string" ||
  (!isMetaFieldName(column) && isDotWalkedColumn(column) && !isPermittedDottedField(tableName, column));

const warnRefused = (tableName: string, name: unknown): void => {
  const column = typeof name === "string" ? name : JSON.stringify(name) ?? String(name);
  const key = `${typeof name}:${tableName}.${column}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  logger.warn(
    typeof name === "string"
      ? `Table ${tableName}: ignoring the manifest files entry for column "${column}" — ` +
          "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
          "so it is never written to the working tree."
      : `Table ${tableName}: ignoring a manifest files entry whose name is not a string (${column}) — ` +
          "it names no column of this table, so it is never fetched or written to the working tree."
  );
};

/**
 * A missing-file map without the field files a hand-edited manifest lists under
 * a dot-walked name (`sys_created_by.user_password` is the creator's password)
 * or under a name that is not a string; the ATF step script is kept. Applied where refresh and download build the map
 * of files to fetch (findMissingFiles, buildFullMissingMap) and again by the
 * Table API download itself, so no fetch path — the scoped endpoint, the Table
 * API, or the fallback between them — is ever asked for another record's
 * value, and a refused field is not counted as missing afterwards.
 *
 * A record or table the refusal leaves with nothing to fetch is dropped; one
 * that was already empty is kept as it was. Returns `missing` itself when it
 * holds no refused name.
 */
export const withoutDotWalkedFieldFiles = (
  missing: SN.MissingFileTableMap
): SN.MissingFileTableMap => {
  const anyRefused = Object.entries(missing).some(([tableName, records]) =>
    Object.values(records ?? {}).some((files) =>
      (files ?? []).some((file) => refused(tableName, file.name))
    )
  );
  if (!anyRefused) {
    return missing;
  }
  // INJ-2: null-proto at both levels, matching the maps it filters.
  const kept: SN.MissingFileTableMap = Object.create(null);
  for (const [tableName, records] of Object.entries(missing)) {
    const table: SN.MissingFileRecord = Object.create(null);
    for (const [sysId, files] of Object.entries(records ?? {})) {
      const own = (files ?? []).filter((file) => {
        if (!refused(tableName, file.name)) {
          return true;
        }
        warnRefused(tableName, file.name);
        return false;
      });
      if (own.length > 0 || (files ?? []).length === 0) {
        table[sysId] = own;
      }
    }
    if (Object.keys(table).length > 0 || Object.keys(records ?? {}).length === 0) {
      kept[tableName] = table;
    }
  }
  return kept;
};
