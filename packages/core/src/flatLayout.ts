// DX17: optional flat local layout.
//
// SyncroNow AI stores each record as a folder of field files:
//   <sourceDir>/<table>/<record>/<field>.<ext>
// New users often expect a flatter tree. Flat mode collapses the per-record
// folder into a single file per field, keeping table + record + field so the
// mapping stays LOSSLESS and reversible:
//   <sourceDir>/<table>/<record>~<field>.<ext>
//
// The separator '~' is safe on every OS filesystem and never appears in a
// ServiceNow dictionary field name, so the record name (which may contain dots
// or other characters) is everything before the LAST '~' in the stem and the
// field is everything after it. These functions are pure (path strings only).

import path from "path";

export const FLAT_FIELD_SEPARATOR = "~";

const splitSegments = (relPath: string): string[] =>
  relPath.split(/[\\/]/).filter((seg) => seg.length > 0);

/**
 * Convert a record-folder relative path to its flat equivalent.
 * `<table>/<record>/<field>.<ext>` -> `<table>/<record>~<field>.<ext>`
 * Paths that are not record-folder files (fewer than 3 segments) are returned
 * unchanged so callers can map a mixed list safely.
 */
export function folderRelToFlat(relPath: string): string {
  const parts = splitSegments(relPath);
  if (parts.length < 3) {
    return relPath;
  }
  const file = parts[parts.length - 1];
  const record = parts[parts.length - 2];
  const tableSegments = parts.slice(0, parts.length - 2);
  const ext = path.extname(file);
  const field = path.basename(file, ext);
  return path.join(...tableSegments, `${record}${FLAT_FIELD_SEPARATOR}${field}${ext}`);
}

/**
 * Convert a flat relative path back to the record-folder layout.
 * `<table>/<record>~<field>.<ext>` -> `<table>/<record>/<field>.<ext>`
 * Paths without a '~' in the stem (i.e. not flat-encoded) are returned
 * unchanged.
 */
export function flatRelToFolder(relPath: string): string {
  const parts = splitSegments(relPath);
  if (parts.length < 2) {
    return relPath;
  }
  const file = parts[parts.length - 1];
  const tableSegments = parts.slice(0, parts.length - 1);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const sepIndex = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
  if (sepIndex < 0) {
    return relPath;
  }
  const record = stem.slice(0, sepIndex);
  const field = stem.slice(sepIndex + 1);
  // A trailing/leading separator would make the record or field empty, which
  // is not a valid flat encoding — leave such paths untouched.
  if (!record || !field) {
    return relPath;
  }
  return path.join(...tableSegments, record, `${field}${ext}`);
}

/** True when a relative path looks flat-encoded (has a `~` in its file stem). */
export function isFlatEncoded(relPath: string): boolean {
  const file = path.basename(relPath);
  const stem = path.basename(file, path.extname(file));
  const sepIndex = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
  return sepIndex > 0 && sepIndex < stem.length - 1;
}
