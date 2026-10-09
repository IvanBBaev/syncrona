// SPDX-License-Identifier: GPL-3.0-or-later
// The single mapping from a table's records to their local folder names.
//
// A record lives at `<sourceDir>/<table>/<folder>/<field>.<ext>` (or, in the
// flat layout, `<sourceDir>/<table>/<folder>~<field>.<ext>`), and the manifest
// stores that folder name as both the record's key and its `name`. Every
// consumer — the download writer, the refresh missing-file probe, the push/dev
// path -> record lookup and repair's orphan scan — reads the name back off the
// manifest, so the manifest is the only place a folder name is decided. This
// module is the only code that decides it: the Table API build, the scoped
// endpoint's manifest and the scoped endpoint's missing-file answer all pass
// through it, so no producer can name a record differently from another.
//
// Rules, in order:
//   1. Names that are the same on disk collide. "The same on disk" is decided by
//      canonicalFolderKey — NFC, lower-case (final sigma folded to σ), trailing
//      dots/spaces dropped — which
//      covers APFS/NTFS case-insensitivity, HFS+/SMB normalisation and Windows'
//      trailing-dot stripping.
//   2. Every member of a colliding group (two or more distinct sys_ids) gets the
//      suffix `_<sys_id>`, inside the same byte budget (a long name is cut
//      further to make room). The decision depends on the SET of records only, never
//      on the order the instance returned them, so a refresh does not move
//      folders. A record that does not collide keeps its name byte for byte, so
//      existing checkouts keep their folders.
//   3. One warning per colliding group, not per member.
//   4. Before any of that, a name is made storable (sanitizeRecordFolderName):
//      control characters are replaced and an overlong name is cut on a code
//      point boundary and given a hash of the whole name, so the folder fits
//      the 255-byte segment limit with room for, in the flat layout, the
//      `~<field>.<ext>` tail.
//   5. The rules are a fixed point: every name they produce comes back unchanged
//      when it passes through them again, so a manifest one producer named is
//      named the same by the next (assignManifestFolderNames re-checks both).
import { SN } from "@syncrona/types";
import { createHash } from "crypto";
import fs, { promises as fsp } from "fs";
import path from "path";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import { isSafePathComponent, MAX_PATH_SEGMENT_BYTES } from "./genericUtils.js";
import { logger } from "./Logger.js";

/**
 * The form in which two folder names are "the same name" on some filesystem a
 * checkout may live on. `toLowerCase`, never `toLocaleLowerCase`: the latter is
 * locale-dependent (Turkish dotless ı) and would make naming depend on the
 * operator's locale. repairCommand compares on-disk names to manifest names
 * with this same function.
 *
 * `toLowerCase` alone is not quite the fold a case-insensitive volume applies:
 * it lowers a word-final "Σ" to "ς", so "ΟΔΟΣ" and "οδοσ" would get two keys
 * while APFS and NTFS store them as one folder. The final sigma is therefore
 * folded to "σ". Nothing beyond that is folded — full case folding would also
 * merge "ß" with "ss", which those volumes keep apart, and a false collision
 * would rename folders for no reason.
 */
export const canonicalFolderKey = (name: string): string =>
  name
    .normalize("NFC")
    .toLowerCase()
    .replace(/ς/gu, "σ")
    .replace(/[.\s]+$/u, "");

/**
 * Stores a record under its folder name.
 *
 * `records[name] = record` is not total: on an object literal the one key
 * `"__proto__"` invokes the inherited setter and the record vanishes.
 * `__proto__` is a legal display name and a legal directory name, so the
 * property is defined instead — own, enumerable and JSON-serialisable.
 */
export function setRecord(
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

/**
 * The byte budget of a record folder name, collision suffix included. 255 is the
 * segment limit; the bytes above 180 are left for a flat layout's
 * `~<field>.<ext>`. A colliding name is cut further so that `_<sys_id>` fits
 * inside this budget too: every name the rules produce is at most this long, so
 * passing it through the rules again leaves it alone.
 */
export const MAX_RECORD_NAME_BYTES = 180;
const HASH_HEX_LENGTH = 8;

const shortHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, HASH_HEX_LENGTH);

/**
 * `name` itself when it fits in `limit` UTF-8 bytes; otherwise the longest
 * prefix that ends on a whole code point and leaves room for
 * `_<first 8 hex of sha256(name)>`, followed by that hash. Deterministic, and a
 * fixed point: the result always fits, so fitting it again returns it as is.
 */
function fitToBytes(name: string, limit: number): string {
  if (Buffer.byteLength(name, "utf8") <= limit) return name;
  const budget = Math.max(0, limit - HASH_HEX_LENGTH - 1);
  let kept = "";
  let bytes = 0;
  for (const codePoint of name) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > budget) break;
    kept += codePoint;
    bytes += size;
  }
  return `${kept}_${shortHash(name)}`;
}

/**
 * Makes a record's display name storable as one path segment, deterministically
 * and only when it has to: a name that is already storable is returned as is,
 * and so is every name this function returns (it is idempotent).
 *   - C0/C1 control characters and DEL become `_`. NUL truncates the name in every
 *     OS call; the rest are refused by Windows or break terminals and git.
 *   - A lone UTF-16 surrogate becomes U+FFFD, which is what Node would write in
 *     its place anyway — so the manifest names the file that is actually on disk.
 *   - A name over MAX_RECORD_NAME_BYTES of UTF-8 is cut at the last whole code
 *     point that fits and gets `_<first 8 hex of sha256(whole name)>`, so two long
 *     names that share a prefix still differ, and the same name always maps to
 *     the same folder. Separators are not handled here; buildRecordName maps
 *     them to `〳` the way the server does.
 */
export function sanitizeRecordFolderName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "_")
    .replace(/[\ud800-\udfff]/gu, "\ufffd");
  return fitToBytes(cleaned, MAX_RECORD_NAME_BYTES);
}

export interface FolderNameEntry {
  sysId: string;
  /** The record's on-disk name before disambiguation. */
  name: string;
}

const collisionSuffix = (sysId: string): string => `_${sysId}`;

/** How many times the suffix is repeated before a counter is used instead. */
const REPEATED_SUFFIX_ROUNDS = 4;

/**
 * The suffixes a colliding member of `sysId` tries, in order: `_<sys_id>`, then
 * the suffix repeated (a display name may literally be `<other>_<sys_id>`), then
 * `_<sys_id>_<n>`, so the suffix never outgrows the budget.
 */
function* collisionSuffixes(sysId: string): Generator<string> {
  let suffix = "";
  for (let round = 0; round < REPEATED_SUFFIX_ROUNDS; round += 1) {
    suffix += collisionSuffix(sysId);
    yield suffix;
  }
  for (let n = 2; ; n += 1) yield `${collisionSuffix(sysId)}_${n}`;
}

/** `base` cut so that `suffix` fits behind it inside MAX_RECORD_NAME_BYTES. */
const withSuffix = (base: string, suffix: string): string =>
  `${fitToBytes(base, MAX_RECORD_NAME_BYTES - Buffer.byteLength(suffix, "utf8"))}${suffix}`;

/**
 * The folder name of every record of one table, keyed by sys_id.
 *
 * Pure apart from the warning: the same set of entries always yields the same
 * map, whatever order they arrive in.
 */
export function assignRecordFolderNames(
  tableName: string,
  entries: readonly FolderNameEntry[]
): Map<string, string> {
  // One name per sys_id (a duplicated row is the same record twice); the lowest
  // name wins so the choice does not depend on row order either.
  const nameBySysId = new Map<string, string>();
  for (const entry of entries) {
    const { sysId } = entry;
    const name = sanitizeRecordFolderName(entry.name);
    const prior = nameBySysId.get(sysId);
    if (prior === undefined || name < prior) nameBySysId.set(sysId, name);
  }

  const groups = new Map<string, string[]>();
  for (const [sysId, name] of nameBySysId) {
    const key = canonicalFolderKey(name);
    const group = groups.get(key);
    if (group) group.push(sysId);
    else groups.set(key, [sysId]);
  }

  const result = new Map<string, string>();
  const taken = new Set<string>();
  const colliding: string[][] = [];
  // Records that do not collide are placed first and keep their names, so a
  // suffixed name can never displace one of them.
  for (const [key, sysIds] of groups) {
    if (sysIds.length === 1) {
      result.set(sysIds[0], nameBySysId.get(sysIds[0]) as string);
      taken.add(key);
    } else {
      colliding.push([...sysIds].sort());
    }
  }
  colliding.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const sysIds of colliding) {
    const names = [...new Set(sysIds.map((id) => nameBySysId.get(id) as string))].sort();
    const stored: string[] = [];
    for (const sysId of sysIds) {
      const base = nameBySysId.get(sysId) as string;
      // The first suffixed name that is still free. Deterministic, and it
      // terminates: the counter suffixes are all distinct.
      let folder = "";
      for (const suffix of collisionSuffixes(sysId)) {
        folder = withSuffix(base, suffix);
        if (!taken.has(canonicalFolderKey(folder))) break;
      }
      taken.add(canonicalFolderKey(folder));
      result.set(sysId, folder);
      stored.push(folder);
    }
    logger.warn(
      `Record name collision in ${tableName}: ${sysIds.length} records share the folder name ` +
        `${names.map((n) => JSON.stringify(n)).join(", ")} on case-insensitive or ` +
        `Unicode-normalizing filesystems; storing them as ` +
        `${stored.map((n) => JSON.stringify(n)).join(", ")} so no record overwrites another.`
    );
  }
  return result;
}

/**
 * Re-keys one table's records by their assigned folder names. Records without a
 * usable sys_id cannot be disambiguated (the suffix is the sys_id) and keep
 * their key; the download writer refuses an unsafe one loudly.
 */
function assignTableFolderNames(
  tableName: string,
  records: SN.TableConfigRecords
): SN.TableConfigRecords {
  const entries = Object.entries(records);
  const named = entries.filter(([, record]) => isSafePathComponent(record?.sys_id));
  const folders = assignRecordFolderNames(
    tableName,
    named.map(([key, record]) => ({ sysId: record.sys_id, name: record.name || key }))
  );
  const changed = named.some(([key, record]) => folders.get(record.sys_id) !== key);
  if (!changed) return records;
  const next: SN.TableConfigRecords = {};
  for (const [key, record] of entries) {
    const folder = isSafePathComponent(record?.sys_id)
      ? (folders.get(record.sys_id) as string)
      : key;
    setRecord(next, folder, folder === key ? record : { ...record, name: folder });
  }
  return next;
}

/**
 * Applies the folder-name rules to a manifest some other producer named — the
 * scoped `sinc/getManifest` endpoint names records by display value only. Works
 * in place and is idempotent: a manifest already named by these rules (the
 * Table API build) comes back unchanged.
 */
export function assignManifestFolderNames(manifest: SN.AppManifest): SN.AppManifest {
  for (const [tableName, table] of Object.entries(manifest.tables ?? {})) {
    if (!table || typeof table.records !== "object" || table.records === null) continue;
    const records = assignTableFolderNames(tableName, table.records);
    if (records !== table.records) table.records = records;
  }
  return manifest;
}

/**
 * Re-keys a fetched table map onto the manifest's folder names (table -> sys_id
 * -> name). The scoped bulk endpoint names the records it returns by display
 * value, so without this a disambiguated record would be written at the
 * colliding path the manifest just moved it away from.
 */
export function applyManifestFolderNames(
  tables: SN.TableMap,
  namesBySysId: Record<string, Record<string, string>>
): SN.TableMap {
  for (const [tableName, table] of Object.entries(tables ?? {})) {
    const names = Object.prototype.hasOwnProperty.call(namesBySysId, tableName)
      ? namesBySysId[tableName]
      : undefined;
    if (!names || !table?.records) continue;
    const entries = Object.entries(table.records);
    const target = (key: string, record: SN.MetaRecord): string => {
      const sysId = record?.sys_id;
      const name =
        typeof sysId === "string" && Object.prototype.hasOwnProperty.call(names, sysId)
          ? names[sysId]
          : undefined;
      return typeof name === "string" && name.length > 0 ? name : key;
    };
    if (entries.every(([key, record]) => target(key, record) === key)) continue;
    const records: SN.TableConfigRecords = {};
    for (const [key, record] of entries) {
      const folder = target(key, record);
      setRecord(records, folder, folder === key ? record : { ...record, name: folder });
    }
    table.records = records;
  }
  return tables;
}

/** The first collision forms the rules can give `base` for `sysId`. */
const suffixedForms = (base: string, sysId: string): string[] => {
  const forms: string[] = [];
  for (const suffix of collisionSuffixes(sysId)) {
    forms.push(withSuffix(base, suffix));
    if (forms.length >= REPEATED_SUFFIX_ROUNDS + 2) break;
  }
  return forms;
};

/** `name` without the trailing collision suffixes of `sysId`. */
const stripCollisionSuffixes = (name: string, sysId: string): string => {
  const suffix = collisionSuffix(sysId);
  let core = name;
  const counter = /_\d+$/u.exec(core);
  if (counter && core.slice(0, counter.index).endsWith(suffix)) {
    core = core.slice(0, counter.index);
  }
  while (core.length > suffix.length && core.endsWith(suffix)) {
    core = core.slice(0, -suffix.length);
  }
  return core;
};

/**
 * The kept prefix of a name fitToBytes cut, or undefined for an uncut name. A
 * cut fills the budget to within one code point (at most 3 bytes short), which
 * tells it apart from a short display name that happens to end in `_<8 hex>`.
 */
const cutPrefix = (core: string, whole: string): string | undefined => {
  if (Buffer.byteLength(whole, "utf8") < MAX_RECORD_NAME_BYTES - 3) return undefined;
  const match = /^(.+)_[0-9a-f]{8}$/su.exec(core);
  return match ? match[1] : undefined;
};

/**
 * True when a folder name changed because of the naming rules rather than
 * because the record was renamed on the instance:
 *   - the new name is the old one made storable (sanitizeRecordFolderName), with
 *     or without the collision suffix;
 *   - the old name carried the collision suffix and the new one is its base
 *     made storable, with or without a suffix (a collision that dissolved, or a
 *     suffix earlier rules put on top of the budget);
 *   - both are the same long name cut at different lengths: a cut name is the
 *     only trace left of the display name, so the kept prefixes are compared.
 *     A new cut name must keep a prefix of the old name, so a short name renamed
 *     on the instance to a long one does not pass for a rule.
 */
export function isRuleDrivenRename(oldName: string, newName: string, sysId: string): boolean {
  const base = sanitizeRecordFolderName(oldName);
  if (base !== oldName && base === newName) return true;
  if (suffixedForms(base, sysId).includes(newName)) return true;
  const oldCore = stripCollisionSuffixes(oldName, sysId);
  if (oldCore !== oldName) {
    const coreBase = sanitizeRecordFolderName(oldCore);
    if (coreBase === newName || suffixedForms(coreBase, sysId).includes(newName)) return true;
  }
  const newKept = cutPrefix(stripCollisionSuffixes(newName, sysId), newName);
  if (newKept === undefined) return false;
  const oldKept = cutPrefix(oldCore, oldName);
  if (oldKept === undefined) return oldCore.startsWith(newKept);
  return oldKept.startsWith(newKept) || newKept.startsWith(oldKept);
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/** True when both paths exist and are the same filesystem entry. */
const sameEntry = async (a: string, b: string): Promise<boolean> => {
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
};

const SHARED_REASON =
  "records whose names collide shared it, so its files cannot be attributed to one of them";

const recordNameOf = (key: string, record: SN.MetaRecord): string =>
  record?.name || key;

/** The flat-layout files of one record: `<name>~<field>.<ext>` in the table dir. */
const flatFilesOf = async (tableDir: string, recordName: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(tableDir);
  } catch {
    return [];
  }
  const prefix = `${recordName}${FLAT_FIELD_SEPARATOR}`;
  // A field name never contains the separator, so the remainder must not either:
  // that keeps record "Foo" from claiming the files of record "Foo~Bar".
  return entries.filter(
    (entry) =>
      entry.startsWith(prefix) &&
      entry.length > prefix.length &&
      !entry.slice(prefix.length).includes(FLAT_FIELD_SEPARATOR)
  );
};

export interface FolderMigrationResult {
  moved: Array<{ table: string; from: string; to: string }>;
  leftBehind: Array<{ table: string; folder: string; reason: string }>;
}

/**
 * Upgrade step for an existing checkout: when a refresh or download renames a
 * record's folder because of the naming rules, move the folder the previous
 * manifest wrote instead of downloading a second copy beside an orphan. Local,
 * unpushed edits in the folder move with it. That includes a collision that
 * dissolved — the other member was deleted, so `Foo_<sys_id>` becomes `Foo`.
 *
 * A folder is moved only when the move is unambiguous: the previous manifest
 * gave the folder to exactly one record, no record of the new manifest still
 * claims it, and nothing exists at the destination yet. A folder that two
 * records shared before (the overwrite this naming fixes) cannot be attributed
 * to either one; it is left in place with a warning, the records are downloaded
 * fresh into their new folders, and `syncrona repair` reports the old folder's
 * files as orphans. Never throws: a failed move is a warning, not a failed run.
 */
// The folder an older checkout wrote for a name the current rules no longer
// store verbatim. A tab or newline was a legal file name on macOS and Linux, so
// such a folder exists and must be movable; everything isSafePathComponent
// refuses for traversal (separators, dot-only names) or that no call could have
// created (NUL, a lone surrogate, over 255 bytes) is still refused.
function isMovableOldFolder(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !/^\.+$/u.test(name) &&
    !/[/\\]/u.test(name) &&
    !/\u0000|[\ud800-\udfff]/u.test(name) &&
    Buffer.byteLength(name, "utf8") <= MAX_PATH_SEGMENT_BYTES
  );
}

export async function migrateRenamedRecordFolders(
  previous: SN.AppManifest | undefined,
  next: SN.AppManifest,
  sourcePath: string,
  flat: boolean
): Promise<FolderMigrationResult> {
  const result: FolderMigrationResult = { moved: [], leftBehind: [] };
  if (!previous || previous.scope !== next.scope) return result;
  const hasOwn = (map: object, key: string) => Object.prototype.hasOwnProperty.call(map, key);

  for (const [tableName, table] of Object.entries(next.tables ?? {})) {
    if (!hasOwn(previous.tables ?? {}, tableName)) continue;
    if (!isSafePathComponent(tableName)) continue;
    const prevRecords = previous.tables[tableName]?.records ?? {};
    const prevNameBySysId = new Map<string, string>();
    // canonical key -> the exact names the previous manifest gave it.
    const prevClaims = new Map<string, Set<string>>();
    for (const [key, record] of Object.entries(prevRecords)) {
      const name = recordNameOf(key, record);
      prevNameBySysId.set(record?.sys_id, name);
      const canonical = canonicalFolderKey(name);
      const claims = prevClaims.get(canonical) ?? new Set<string>();
      claims.add(name);
      prevClaims.set(canonical, claims);
    }
    const nextClaims = new Set(
      Object.entries(table?.records ?? {}).map(([key, record]) =>
        canonicalFolderKey(recordNameOf(key, record))
      )
    );
    const tableDir = path.join(sourcePath, tableName);
    const reported = new Set<string>();

    for (const [key, record] of Object.entries(table?.records ?? {})) {
      const newName = recordNameOf(key, record);
      const oldName = prevNameBySysId.get(record?.sys_id);
      if (oldName === undefined || oldName === newName) continue;
      if (!isRuleDrivenRename(oldName, newName, record.sys_id)) continue;
      if (!isMovableOldFolder(oldName) || !isSafePathComponent(newName)) continue;
      const oldKey = canonicalFolderKey(oldName);
      const leave = (reason: string) => {
        if (reported.has(oldKey)) return;
        reported.add(oldKey);
        result.leftBehind.push({ table: tableName, folder: oldName, reason });
        logger.warn(
          `Left "${path.join(tableName, oldName)}" in place: ${reason}. Its records are ` +
            `downloaded into their new folders; review the old one and delete it ` +
            `(\`syncrona repair\` lists its files as orphans).`
        );
      };
      if (nextClaims.has(oldKey)) continue; // still a live folder of another record
      // Names that differ only by case or normal form ("Foo" and "foo") were
      // two folders on a case-sensitive volume but ONE on APFS/NTFS, where both
      // records wrote into it. The filesystem answers which: the other spelling
      // resolving to the same entry means the folder was shared.
      const otherNames = [...(prevClaims.get(oldKey) ?? [])].filter((n) => n !== oldName);

      try {
        if (flat) {
          const files = await flatFilesOf(tableDir, oldName);
          if (files.length === 0) continue;
          const moves = files.map((file) => ({
            from: path.join(tableDir, file),
            to: path.join(tableDir, `${newName}${file.slice(oldName.length)}`),
          }));
          let shared = false;
          for (const file of files) {
            const suffix = file.slice(oldName.length);
            for (const other of otherNames) {
              if (await sameEntry(path.join(tableDir, file), path.join(tableDir, `${other}${suffix}`))) {
                shared = true;
              }
            }
          }
          if (shared) {
            leave(SHARED_REASON);
            continue;
          }
          const blocked = [];
          for (const move of moves) if (await exists(move.to)) blocked.push(move.to);
          if (blocked.length > 0) {
            leave(`files of the new name "${newName}" already exist`);
            continue;
          }
          for (const move of moves) await fsp.rename(move.from, move.to);
        } else {
          const from = path.join(tableDir, oldName);
          const to = path.join(tableDir, newName);
          if (!(await exists(from))) continue;
          let shared = false;
          for (const other of otherNames) {
            if (await sameEntry(from, path.join(tableDir, other))) shared = true;
          }
          if (shared) {
            leave(SHARED_REASON);
            continue;
          }
          if (await exists(to)) {
            leave(`the new folder "${newName}" already exists`);
            continue;
          }
          await fsp.rename(from, to);
        }
        result.moved.push({ table: tableName, from: oldName, to: newName });
        logger.warn(
          `Renamed "${path.join(tableName, oldName)}" to "${path.join(tableName, newName)}" ` +
            `(record ${record.sys_id}) to follow the folder naming rules; commit the rename.`
        );
      } catch (e) {
        leave(`moving it failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  return result;
}
