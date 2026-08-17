// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22: the record metadata layer.
//
// A ServiceNow record is more than its script. `sys_script_include` also carries
// `api_name`, `access`, `client_callable`, `active`, `description`; a business
// rule carries `when`, `order`, `condition`, `collection`. None of that is a
// "file field" — sys_dictionary types them as string/boolean/choice/reference —
// so the file-field discovery in manifestBuilder never selected them and nothing
// downstream ever saw them. The workspace held the code and nothing else.
//
// The fix is a sidecar rather than more field files: one `.meta.json` per record
// holding every non-file column, represented in the manifest as the pseudo-file
// `{ name: ".meta", type: "json" }` inside `record.files`. That one decision is
// what keeps the change small — the sidecar rides the existing write, missing
// probe, checkpoint and repair machinery unchanged, and the one seam where a
// pseudo-file must NOT be treated as a column (the flat-layout orphan scan) is
// guarded explicitly through the predicates below.
//
// The sidecar is editable: `push`, `dev` and `deploy` expand it back into a
// Table-API update through resolveMetaUpdate below, which is where the rules
// about what may be written live.
import { SN } from "@syncrona/types";
import { SN_TYPE_MAP } from "./fieldMap.js";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";

/** Manifest name of the sidecar pseudo-file. */
export const META_FILE_NAME = ".meta";
/** Manifest type of the sidecar pseudo-file, i.e. its on-disk extension. */
export const META_FILE_TYPE: SN.FileType = "json";
/** On-disk file name in the nested layout: `<table>/<record>/.meta.json`. */
export const META_SIDECAR_FILE_NAME = `${META_FILE_NAME}.${META_FILE_TYPE}`;

/** A fresh sidecar pseudo-file entry for a manifest record. */
export const metaFile = (): SN.File => ({
  name: META_FILE_NAME,
  type: META_FILE_TYPE,
});

export const isMetaFieldName = (name: string): boolean =>
  name === META_FILE_NAME;

export const isMetaFile = (file: { name?: string }): boolean =>
  isMetaFieldName(String(file?.name ?? ""));

/**
 * True for the sidecar's own path in EITHER layout — `<record>/.meta.json`
 * nested, `<record>~.meta.json` flat.
 *
 * The nested form is already invisible to `repair --prune` (its shape filter
 * rejects any dot-prefixed path segment), but the flat form is an ordinary file
 * name that the scan does inspect — and the orphan classifier is keyed on a
 * shape filter it does not match, so without this predicate `repair --apply
 * --prune` would delete a perfectly tracked sidecar.
 *
 * It is also what the push-side path lookup keys on: neither layout's field
 * derivation reaches the right answer by itself (see getFileContextFromPath).
 */
export const isMetaSidecarPath = (filePath: string): boolean => {
  const base = filePath.split(/[/\\]/).filter((t) => t !== "").pop() || "";
  return (
    base === META_SIDECAR_FILE_NAME ||
    base.endsWith(`${FLAT_FIELD_SEPARATOR}${META_SIDECAR_FILE_NAME}`)
  );
};

/**
 * Columns never written into a sidecar, by name.
 *
 * Everything here is either instance-local bookkeeping that would rewrite the
 * file on every pull without describing the artifact (`sys_mod_count`, the
 * `sys_created_*`/`sys_updated_*` pairs), or an identifier the manifest already
 * owns (`sys_id`). Note the broader `sys_`-prefix rule in isMetaFieldCandidate:
 * this list is the readable core of it, kept explicit so the intent is testable.
 */
export const META_FIELD_DENYLIST: ReadonlySet<string> = new Set([
  "sys_id",
  "sys_class_name",
  "sys_created_by",
  "sys_created_on",
  "sys_updated_by",
  "sys_updated_on",
  "sys_mod_count",
  "sys_tags",
  "sys_domain",
  "sys_domain_path",
  "sys_scope",
  "sys_package",
  "sys_update_name",
  "sys_customer_update",
  "sys_replace_on_upgrade",
  "sys_name",
  "sys_policy",
]);

/**
 * Dictionary types never written into a sidecar.
 *
 * SN_TYPE_MAP's own keys are the file types: a field of that type either IS a
 * field file already, or was deliberately removed from the file list by a config
 * `excludes` rule — and a user who excluded `script` did not ask for it back as
 * a JSON string. The rest are excluded for their own reasons: `password` and
 * `password2` are credentials and must never reach the working tree, the
 * `journal*` family is an append-only activity stream that would churn the file
 * on every pull, and `image`/`user_image`/`collection` have no useful string
 * form at all.
 */
export const NON_META_INTERNAL_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(SN_TYPE_MAP),
  "password",
  "password2",
  "journal",
  "journal_input",
  "journal_list",
  "collection",
  "image",
  "user_image",
]);

/**
 * Whether a dictionary row describes a column worth putting in the sidecar.
 *
 * The `sys_` prefix rule is deliberately blunt: on a real table those columns
 * are platform plumbing (update-set bookkeeping, domain separation, package
 * ownership), they change without the artifact changing, and letting them
 * through would make every pull produce a diff. The few that are genuinely
 * interesting on a given table — `sys_overrides` on `sys_script`, say — are
 * recoverable through an explicit `tableOptions.<table>.metaFields` list, which
 * bypasses discovery entirely.
 */
/**
 * The `sysparm_fields` list of the metadata discovery query.
 *
 * `read_only` and `virtual` are not used to decide what goes INTO the sidecar —
 * a derived column like `sys_script_include.api_name` is exactly the kind of
 * value a reader wants next to the script. They are used to decide what may come
 * back OUT of it: see resolveMetaUpdate.
 */
export const META_DICTIONARY_FIELDS = "element,internal_type,read_only,virtual";

// The Table API renders booleans as the strings "true"/"false", but a client
// configured with sysparm_display_value=false on a typed transport can still
// hand back a real boolean. Accept both rather than depend on the wire form.
const isTrueish = (raw: unknown): boolean =>
  raw === true || String(raw ?? "").toLowerCase() === "true";

/**
 * Whether a dictionary row describes a column that cannot be written.
 *
 * `read_only` is the platform's own answer to "may a user change this", and
 * `virtual` marks a column computed on read that has no stored value to change.
 * Both are honoured because the Table API does NOT complain about either: it
 * accepts the update, drops the field, and answers 200 — so without this the
 * tool would report a successful push of a value the instance discarded.
 */
export const isReadOnlyDictionaryRow = (row: {
  read_only?: unknown;
  virtual?: unknown;
}): boolean => isTrueish(row?.read_only) || isTrueish(row?.virtual);

export const isMetaFieldCandidate = (
  element: string | undefined,
  internalType: string | undefined
): boolean => {
  if (!element) {
    return false;
  }
  if (META_FIELD_DENYLIST.has(element) || element.startsWith("sys_")) {
    return false;
  }
  return !NON_META_INTERNAL_TYPES.has(String(internalType ?? ""));
};

/**
 * The string form of one Table-API cell.
 *
 * Reference columns arrive as `{ link, value }` (the client does not pass
 * `sysparm_exclude_reference_link`), and `String({...})` on that object yields
 * "[object Object]" — a value that looks like data, survives into the file, and
 * is wrong. Unwrap to the referenced sys_id, which is also the only form a
 * future push-back could send.
 */
const metaValueText = (raw: unknown): string => {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "object") {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return String(raw);
};

/**
 * The sidecar body for one row.
 *
 * Keys are sorted and empty values dropped so the file is a function of the
 * record and nothing else: the Table API gives no column ordering guarantee, so
 * without the sort a re-pull of an unchanged record would still produce a diff,
 * and a workspace that re-pulls on every refresh would never stop churning git.
 * A column the response omitted entirely (column-level read ACL) is likewise
 * absent rather than written as "", so the sidecar never claims a value it was
 * not shown.
 */
export const serializeMetaFields = (
  row: Record<string, unknown>,
  fields: string[]
): string => {
  const body: Record<string, string> = {};
  for (const field of [...new Set(fields)].sort()) {
    if (!(field in row)) {
      continue;
    }
    const text = metaValueText(row[field]);
    if (text === "") {
      continue;
    }
    body[field] = text;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
};

/** What one edited sidecar contributes to its record's Table-API update. */
export interface MetaUpdate {
  /** Column → value, ready to merge into the update body. */
  fields: Record<string, string>;
  /** Columns present in the file but not writable; reported, not sent. */
  skipped: string[];
}

/**
 * The Table-API update for one edited sidecar.
 *
 * Three rules, and each exists because the alternative loses an edit silently:
 *
 *  - a key the table's `metaFields` does not list is a HARD error. ServiceNow
 *    ignores unknown columns in an update and still answers 200, so a typo
 *    ("descripton") would otherwise be reported as a successful push that
 *    changed nothing — the precise failure mode this whole feature exists to
 *    remove. The message names the keys so the fix is mechanical.
 *  - a key the dictionary marks read-only or virtual is DROPPED, not rejected.
 *    We put it in the file; failing on it would fail every push of an untouched
 *    sidecar and make the feature unusable. The caller reports the drop.
 *  - a key that is ABSENT is not a request to clear the column. The serializer
 *    omits empty values, so "absent" and "empty on the instance" are the same
 *    state and treating absence as a clear would wipe every column that merely
 *    happened to be empty at pull time. Clearing is done by writing `""`, which
 *    is explicit and survives the round trip (the next pull drops the key again,
 *    because by then the instance really is empty).
 */
export const resolveMetaUpdate = (
  content: string,
  known: { metaFields?: readonly string[]; readOnlyFields?: readonly string[] }
): MetaUpdate => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `${META_SIDECAR_FILE_NAME} is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${META_SIDECAR_FILE_NAME} must be a JSON object of "column": "value" pairs.`
    );
  }

  const writable = new Set(known.metaFields ?? []);
  const readOnly = new Set(known.readOnlyFields ?? []);
  const fields: Record<string, string> = {};
  const skipped: string[] = [];
  const unknown: string[] = [];
  const unusable: string[] = [];

  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!writable.has(key)) {
      unknown.push(key);
      continue;
    }
    if (readOnly.has(key)) {
      skipped.push(key);
      continue;
    }
    if (typeof raw === "string") {
      fields[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      // Convenience only: a hand-edited `"active": false` is unambiguous, and
      // rejecting it would be pedantry. Everything else (null, nested object,
      // array) has no single obvious column value and is refused below.
      fields[key] = String(raw);
    } else {
      unusable.push(key);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `${META_SIDECAR_FILE_NAME} names ${unknown.length} column(s) this table ` +
        `does not track: ${unknown.sort().join(", ")}. ServiceNow silently ` +
        "ignores unknown columns in an update, so pushing them would report " +
        "success and change nothing. Remove them, or add them to " +
        "`tableOptions.<table>.metaFields` if they are real columns."
    );
  }
  if (unusable.length > 0) {
    throw new Error(
      `${META_SIDECAR_FILE_NAME} holds a value that is not a column value for ` +
        `${unusable.sort().join(", ")}. Use a string (numbers and booleans are ` +
        "accepted); null, objects and arrays are not."
    );
  }

  return { fields, skipped: skipped.sort() };
};
