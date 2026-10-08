// SPDX-License-Identifier: GPL-3.0-or-later
import { SN } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import { isSafePathComponent } from "./genericUtils.js";
import { logger } from "./Logger.js";
import { isMetaFile } from "./metaFields.js";

// A field a record still has on the instance but the new manifest no longer
// lists leaves its value file behind: the `includes` type filter now drops the
// column (an unsafe or secret type, see classifyColumn), or the user took it out
// of `includes`. Nothing pulls or pushes that file any more, and the column it
// came from may be a credential, so the user has to hear about it.
//
// Reported, never deleted. The file is the user's: it may hold the only copy of
// work they want to keep, and deleting files is `repair --apply --prune`'s job,
// which already lists them as orphans and deletes only what git can restore.
// The same convention as an adopted record folder (recordFolderNames.ts).
//
// The comparison is old manifest vs new manifest, so the warning appears on the
// run that withdraws the field and not again: the next run's old manifest no
// longer lists it. A record or table that left the manifest altogether is not
// reported here — that is a different event, and `repair` covers it.

export interface WithdrawnWorkspace {
  sourcePath: string;
  flat: boolean;
}

// Stem match as FileUtils.findFieldRepresentation does it (NFC, lower-case),
// so a field the workspace edits under another extension (`script.ts` for a
// `script.js` field) is found too. Kept local: callers' FileUtils seams are
// mocked in tests, and this module only ever reads.
const canonicalStem = (name: string): string => name.normalize("NFC").toLowerCase();

const findRepresentation = async (
  dir: string,
  stem: string
): Promise<string | undefined> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (_) {
    return undefined;
  }
  const wanted = canonicalStem(stem);
  const entry = entries.find((candidate) => {
    const ext = path.extname(candidate);
    return ext !== "" && canonicalStem(path.basename(candidate, ext)) === wanted;
  });
  return entry === undefined ? undefined : path.join(dir, entry);
};

const recordsBySysId = (
  records: SN.TableConfigRecords | undefined
): Map<string, { key: string; record: SN.TableConfigRecords[string] }> => {
  const bySysId = new Map<string, { key: string; record: SN.TableConfigRecords[string] }>();
  for (const [key, record] of Object.entries(records ?? {})) {
    if (record && typeof record.sys_id === "string") bySysId.set(record.sys_id, { key, record });
  }
  return bySysId;
};

/**
 * The on-disk value files of fields `previous` listed for a record that `next`
 * still has (same table, same sys_id) but no longer lists. The record is looked
 * up at its NEW folder name. The metadata sidecar is never reported.
 */
export const findWithdrawnFieldFiles = async (
  previous: SN.AppManifest,
  next: SN.AppManifest,
  sourcePath: string,
  flat: boolean
): Promise<string[]> => {
  const found: string[] = [];
  const nextTables = next.tables ?? {};
  for (const [table, previousTable] of Object.entries(previous.tables ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(nextTables, table)) continue;
    if (!isSafePathComponent(table)) continue;
    const nextBySysId = recordsBySysId(nextTables[table]?.records);
    for (const previousRecord of Object.values(previousTable?.records ?? {})) {
      const match = nextBySysId.get(previousRecord?.sys_id);
      if (!match) continue;
      const recordName = match.record.name || match.key;
      if (!isSafePathComponent(recordName)) continue;
      const kept = new Set((match.record.files ?? []).map((file) => file.name));
      for (const file of previousRecord.files ?? []) {
        if (kept.has(file.name) || isMetaFile(file)) continue;
        if (!isSafePathComponent(file.name)) continue;
        const tableDir = path.join(sourcePath, table);
        const onDisk = flat
          ? await findRepresentation(tableDir, `${recordName}${FLAT_FIELD_SEPARATOR}${file.name}`)
          : await findRepresentation(path.join(tableDir, recordName), file.name);
        if (onDisk !== undefined) found.push(onDisk);
      }
    }
  }
  return found;
};

/**
 * Warns once about the files findWithdrawnFieldFiles names. Best-effort: it
 * reads the workspace lazily and swallows every failure, because a warning must
 * never fail the refresh or download it rides on.
 */
export const warnWithdrawnFieldFiles = async (
  previous: SN.AppManifest | undefined,
  next: SN.AppManifest,
  workspace: WithdrawnWorkspace | (() => WithdrawnWorkspace)
): Promise<void> => {
  if (!previous || previous.scope !== next.scope) return;
  let stale: string[];
  try {
    const { sourcePath, flat } = typeof workspace === "function" ? workspace() : workspace;
    stale = await findWithdrawnFieldFiles(previous, next, sourcePath, flat);
  } catch (_) {
    return;
  }
  if (stale.length === 0) return;
  logger.warn(
    `${stale.length} local file(s) hold the value of a field the manifest no longer lists ` +
      "(the `includes` type filter now drops the column, or it left `includes`). " +
      "They are no longer synced and can be deleted; they may hold a credential. " +
      "`syncrona repair` lists them as orphans:\n" +
      stale.map((file) => `  ${file}`).join("\n")
  );
};
