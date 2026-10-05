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

/**
 * The same text without a leading UTF-8 byte-order mark.
 *
 * Node decodes the three-byte BOM to a single U+FEFF and hands it to us as the
 * first character of the string; every JSON parser refuses it. Exported because
 * the sidecar is the one file in the workspace that is PARSED rather than
 * transferred, so it is the one place the mark matters.
 */
export const stripBOM = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

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
 * This list is now the ONLY name-based exclusion, and it is deliberately tiny:
 * the sidecar's job is to carry everything about a record that the working tree
 * would otherwise lose, so a column earns a place here only by being actively
 * harmful to keep.
 *
 * Each of these is a per-save audit stamp the platform rewrites on its own. They
 * describe the last write, not the artifact, so carrying them would make every
 * pull produce a diff on records nobody touched — turning `git status` into
 * noise and hiding the real metadata changes underneath it. `sys_id` is excluded
 * for a different reason: the manifest already owns it, it is the key of the
 * update rather than a value in it, and a hand-edited one would silently retarget
 * the push at another record.
 *
 * Everything else the dictionary reports — including the rest of the `sys_`
 * family (`sys_name`, `sys_policy`, `sys_scope`, `sys_package`, `sys_class_name`,
 * `sys_domain`, `sys_overrides`, `sys_update_name`, …) — is carried. Most of it
 * is read-only on the instance and is labelled as such rather than dropped (and
 * the few the dictionary does not mark read-only are never pushed: see
 * META_PUSH_PROTECTED_FIELDS): a
 * value you cannot write is still a value you want to READ next to the script,
 * and hiding it is what made the pre-DX22 workspace uninformative.
 */
export const META_FIELD_DENYLIST: ReadonlySet<string> = new Set([
  "sys_id",
  "sys_created_by",
  "sys_created_on",
  "sys_updated_by",
  "sys_updated_on",
  "sys_mod_count",
]);

/**
 * System columns carried in the sidecar for reading but never written back.
 *
 * The dictionary does not mark them read-only, so without this list an edited
 * (or stale) sidecar would PATCH them: `sys_scope` and `sys_package` would move
 * the record into another application, `sys_policy` would change its protection
 * policy, and `sys_update_name` would rename its update-set identity. None of
 * that is an edit of the record; the platform owns those columns. A key named
 * here is dropped from the update and reported like a read-only one.
 */
export const META_PUSH_PROTECTED_FIELDS: ReadonlySet<string> = new Set([
  "sys_scope",
  "sys_package",
  "sys_policy",
  "sys_update_name",
]);

/**
 * Dictionary types whose value must never become a working-tree file of any
 * kind: credentials, append-only journals and binaries. The sidecar excludes
 * them through NON_META_INTERNAL_TYPES; the data-field fallback
 * (`SYNCRONA_DATA_TABLES` / `SYNCRONA_INCLUDE_DATA_FIELDS`), which turns every
 * column into a `.txt` field file, excludes them through this set directly.
 */
export const UNSAFE_VALUE_INTERNAL_TYPES: ReadonlySet<string> = new Set([
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
  ...UNSAFE_VALUE_INTERNAL_TYPES,
]);

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

/**
 * Whether a dictionary row describes a column worth putting in the sidecar.
 *
 * The rule is "carry everything the instance will show us", narrowed by exactly
 * three exclusions, each with a concrete cost behind it:
 *
 *  - META_FIELD_DENYLIST — the per-save audit stamps and `sys_id`. Carrying them
 *    would rewrite untouched files on every pull.
 *  - NON_META_INTERNAL_TYPES — the file-field types (already written as their own
 *    files), credentials, journals and binaries. A password in the working tree
 *    is a leak, and the rest have no round-trippable string form.
 *  - the table's own file fields, removed by the caller, so no column has two
 *    writers.
 *
 * An earlier revision also rejected every `sys_`-prefixed column outright. That
 * blanket rule dropped real, useful, human-meaningful metadata — the scope and
 * package a record belongs to, whether it is protected, what it overrides — for
 * the sake of the six audit stamps that are now named individually. Anything the
 * default still refuses can be forced back with an explicit
 * `tableOptions.<table>.metaFields` list, which bypasses discovery entirely.
 */
export const isMetaFieldCandidate = (
  element: string | undefined,
  internalType: unknown
): boolean => {
  if (!element) {
    return false;
  }
  if (META_FIELD_DENYLIST.has(element)) {
    return false;
  }
  return !NON_META_INTERNAL_TYPES.has(dictionaryInternalType(internalType));
};

/**
 * The type name of a `sys_dictionary.internal_type` cell.
 *
 * `internal_type` is a REFERENCE (to sys_glide_object, keyed by name), and the
 * client does not send `sysparm_exclude_reference_link`, so the Table API may
 * hand the cell back as `{ link, value }` rather than as the bare name.
 * `String()` on that object is "[object Object]" — a type no lookup knows — so
 * every type filter keyed on it failed open: a `password2` or `journal` column
 * passed the sidecar filter, and a `script` field fell back to `.txt`. Every
 * consumer of the column goes through this instead of `String()`.
 */
export const dictionaryInternalType = (raw: unknown): string => metaValueText(raw).trim();

/**
 * Own properties only.
 *
 * A column NAME here comes from `sys_dictionary.element` or from an operator's
 * `tableOptions.<table>.metaFields`, so nothing in this process chooses it — and
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` are all valid
 * ServiceNow column-name shapes that are also members of `Object.prototype`. A
 * bare `field in row` answers true for every one of them on a row that carries
 * no such column, which is the exact opposite of what the caller asks it. Same
 * guard, and the same reason, as `ownLookup` in fieldMap.
 */
const rowHasColumn = (row: Record<string, unknown>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(row, field);

/**
 * Columns whose secrecy is decided by a sibling column, not by their own type.
 *
 * NON_META_INTERNAL_TYPES catches a column whose dictionary type is `password`,
 * but `sys_properties.value` is a plain string column: a property is a secret
 * when its record's `type` is `password` or `password2`. The dictionary cannot
 * say that, so the rule is per table. `classifier` is the column that decides
 * and must be fetched alongside the sidecar columns.
 */
export const META_RECORD_SECRET_RULES: Readonly<
  Record<string, { classifier: string; secretValues: readonly string[]; columns: readonly string[] }>
> = Object.freeze({
  sys_properties: { classifier: "type", secretValues: ["password", "password2"], columns: ["value"] },
});

// Own properties only: `table` comes from the instance or a hand-edited
// manifest, and `constructor` is a valid table-name shape that a bare index
// resolves to Object's own function — a "rule" whose `columns` is undefined.
const secretRuleFor = (
  table: string | undefined
): (typeof META_RECORD_SECRET_RULES)[string] | undefined =>
  table && Object.prototype.hasOwnProperty.call(META_RECORD_SECRET_RULES, table)
    ? META_RECORD_SECRET_RULES[table]
    : undefined;

/**
 * The columns of `table` a record-level secret rule may withhold, whatever the
 * record. Empty for a table without a rule.
 */
export const metaSecretRuleColumns = (table: string | undefined): readonly string[] => {
  const rule = secretRuleFor(table);
  return rule ? rule.columns : [];
};

/**
 * Whether `column` of `table` is one a record-level secret rule may withhold.
 * Its absence from the working tree is then not evidence of a gap: for a
 * password-typed record it is the rule working, and nothing local says which
 * records those are.
 */
export const isSecretRuleColumn = (table: string | undefined, column: string): boolean =>
  metaSecretRuleColumns(table).includes(column);

/**
 * Splits a missing-file map into what a consistency report should count and the
 * number of files a record-level secret rule may be withholding. A governed
 * column (`sys_properties.value`) of a password-typed record is never written,
 * so it is "missing" on every run by design; counted, it kept `repair` from
 * ever converging. Same exemption as collectUnfetchedFields (downloadPipeline) applies to a fetch.
 *
 * Only the COUNT uses this: refresh and `repair --apply` still fetch every
 * listed governed column (processMissingFiles recomputes the full map) — repair
 * runs that fetch whenever `exempt` > 0, even when nothing counted is missing —
 * and the Table API path writes the value of a non-secret record while a
 * password-typed one stays withheld.
 */
export const withoutSecretRuleColumns = (
  missing: SN.MissingFileTableMap
): { missing: SN.MissingFileTableMap; exempt: number } => {
  const counted: SN.MissingFileTableMap = Object.create(null);
  let exempt = 0;
  for (const [table, records] of Object.entries(missing)) {
    for (const [sysId, files] of Object.entries(records ?? {})) {
      const kept = (files ?? []).filter((file) => !isSecretRuleColumn(table, file.name));
      exempt += (files ?? []).length - kept.length;
      if (kept.length === 0) continue;
      if (!counted[table]) counted[table] = Object.create(null);
      counted[table][sysId] = kept;
    }
  }
  return { missing: counted, exempt };
};

/** The classifier columns a sidecar read of `table` must also fetch. */
export const metaSecretClassifierFields = (table: string | undefined): string[] => {
  const rule = secretRuleFor(table);
  return rule ? [rule.classifier] : [];
};

/**
 * Columns of `row` that must not be written to the working tree — neither into
 * its sidecar nor as a field file (an `includes` entry or the data-field
 * fallback can make `sys_properties.value` a field file, and the rule is about
 * the value, not the file it would land in).
 *
 * Fails closed: a row whose classifier column is missing or unreadable (a
 * column-level read ACL, or a `metaFields` override that left it out) is
 * treated as a secret, because writing a credential to the working tree cannot
 * be undone by a later push. An omitted column is never cleared on push (see
 * resolveMetaUpdate), so redaction does not touch the instance value.
 */
export const metaSecretColumns = (
  table: string | undefined,
  row: Record<string, unknown>
): string[] => {
  const rule = secretRuleFor(table);
  if (!rule) {
    return [];
  }
  const kind = rowHasColumn(row, rule.classifier)
    ? metaValueText(row[rule.classifier]).trim().toLowerCase()
    : "";
  return kind !== "" && !rule.secretValues.includes(kind) ? [] : [...rule.columns];
};

/**
 * How the value of `column` of `table` may reach the working tree.
 *
 *  - "unsafe" — its dictionary type is in UNSAFE_VALUE_INTERNAL_TYPES (a
 *    credential, journal or binary). Never written, whatever selected the
 *    column: discovery, an `includes` entry or the data-field fallback.
 *  - "secret" — a record-level secret rule (META_RECORD_SECRET_RULES) governs
 *    it. Written only from a Table API read that carries the rule's classifier,
 *    and then per row as metaSecretColumns decides.
 *  - "unknown" — its dictionary type could not be read (no row, or an empty
 *    type). Kept, and the caller says so: dropping it would make `includes`
 *    unusable where sys_dictionary reads are restricted.
 *  - "safe" — anything else.
 *
 * The one column-level decision: the Table API manifest build, the
 * scoped-endpoint post-processing, the `includes` filter, init's content
 * re-read and the download fetcher all route through it. `dictType` is the raw
 * `sys_dictionary.internal_type` cell; a caller with no dictionary row passes
 * nothing, and only the record-level rule can then be told apart.
 */
export type ColumnClass = "unsafe" | "secret" | "unknown" | "safe";

export const classifyColumn = (
  table: string | undefined,
  column: string,
  dictType?: unknown
): ColumnClass => {
  const type = dictionaryInternalType(dictType);
  if (UNSAFE_VALUE_INTERNAL_TYPES.has(type)) {
    return "unsafe";
  }
  if (secretRuleFor(table)?.columns.includes(column)) {
    return "secret";
  }
  return type === "" ? "unknown" : "safe";
};

/** A value with a single unambiguous column form. */
const isColumnScalar =(raw: unknown): boolean =>
  typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean";

/**
 * The string form of one Table-API cell.
 *
 * Reference columns arrive as `{ link, value }` (the client does not pass
 * `sysparm_exclude_reference_link`), and `String({...})` on that object yields
 * "[object Object]" — a value that looks like data, survives into the file, and
 * is wrong. Unwrap to the referenced sys_id, which is also the only form a
 * future push-back could send.
 *
 * The unwrap accepts any scalar `value`, not just a string. The wire form of a
 * cell is the transport's choice, not ours — a client configured with
 * `sysparm_display_value`, or a typed transport that preserves the column's own
 * type, hands back `{ value: 100 }` or `{ value: false }` — and answering "" for
 * those reported a column that HAS a value as empty. That is the same silent
 * loss the empty-vs-absent rule below exists to prevent, one layer down.
 */
export const metaValueText = (raw: unknown): string => {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "object") {
    const value = (raw as { value?: unknown }).value;
    return isColumnScalar(value) ? String(value) : "";
  }
  return isColumnScalar(raw) ? String(raw) : "";
};

/**
 * The sidecar body for one row.
 *
 * Every tracked column the instance returned is written, INCLUDING the ones that
 * are currently empty — those are written as `""`. An earlier revision dropped
 * empty values, which made the file smaller and the feature much worse: a column
 * that happened to be blank at pull time was simply invisible, so the one thing
 * a reader most needs from this file — "what can I set on this record?" — could
 * not be answered from the file at all. Measured on a live instance:
 * `sys_script_include.caller_access` is tracked and writable, and was missing
 * from every sidecar for exactly this reason.
 *
 * A column the response omitted ENTIRELY is still absent rather than written as
 * "". That is a different state — a column-level read ACL hid it — and the file
 * must never claim a value it was not shown.
 *
 * Keys are sorted so the file is a function of the record and nothing else: the
 * Table API gives no column ordering guarantee, so without the sort a re-pull of
 * an unchanged record would still produce a diff and a workspace that re-pulls on
 * every refresh would never stop churning git.
 */
export const serializeMetaFields = (
  row: Record<string, unknown>,
  fields: string[],
  table?: string
): string => {
  const secret = new Set(metaSecretColumns(table, row));
  // Null-prototype: `body["__proto__"] = "x"` on a plain object hits the
  // Object.prototype setter, which ignores a non-object — no own property, and
  // the column vanishes from a file whose whole contract is "every tracked
  // column is in here". Building the body without a prototype makes every column
  // name an ordinary key.
  const body: Record<string, string> = Object.create(null);
  for (const field of [...new Set(fields)].sort()) {
    if (!rowHasColumn(row, field) || secret.has(field)) {
      continue;
    }
    body[field] = metaValueText(row[field]);
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
 *  - a key that is ABSENT is not a request to clear the column. The update is a
 *    merge, not a replacement of the record: a sidecar written by an older
 *    version, trimmed by hand, or produced under a column-level read ACL is
 *    missing keys for reasons that have nothing to do with intent, and reading
 *    absence as "clear it" would wipe columns nobody touched. Clearing is done by
 *    writing `""`, which is explicit and round-trips — the serializer now writes
 *    empty columns as `""`, so the next pull shows the cleared column still
 *    there, still empty, still editable.
 */
export const resolveMetaUpdate = (
  content: string,
  known: { metaFields?: readonly string[]; readOnlyFields?: readonly string[] }
): MetaUpdate => {
  let parsed: unknown;
  try {
    // A leading U+FEFF is what Notepad, PowerShell redirection and a VS Code
    // workspace set to `utf8bom` all write, and this tool ships for Windows and
    // WSL. JSON.parse rejects it outright, so a sidecar the user edited
    // correctly failed the push with "not valid JSON" pointing at a file that
    // looks perfectly valid in the editor that produced it.
    parsed = JSON.parse(stripBOM(content));
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
  // Null-prototype for the same reason the serializer uses one: a column named
  // `__proto__` was matched as writable, assigned, and then silently missing
  // from the update body — a push that reports success and changes nothing,
  // which is the one outcome this function exists to make impossible.
  const fields: Record<string, string> = Object.create(null);
  const skipped: string[] = [];
  const unknown: string[] = [];
  const unusable: string[] = [];

  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!writable.has(key)) {
      unknown.push(key);
      continue;
    }
    if (readOnly.has(key) || META_PUSH_PROTECTED_FIELDS.has(key)) {
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
    // An empty `metaFields` is not "this table tracks other columns" — it is a
    // manifest that never got a metadata layer, usually because the dictionary
    // read failed during the refresh that wrote it. Telling the user to fix
    // their file would send them to edit a file that is perfectly correct, so
    // the degraded manifest is named instead.
    if (writable.size === 0) {
      throw new Error(
        `${META_SIDECAR_FILE_NAME} cannot be pushed: the manifest records no ` +
          "metadata columns for this table, so there is nothing to match its " +
          `${unknown.length} key(s) against. The manifest was written without a ` +
          "metadata layer — run `syncrona refresh` to rebuild it (watch for a " +
          "warning about the dictionary being unreadable), or set " +
          "`tableOptions.<table>.metaFields` explicitly if the dictionary is " +
          "not readable for this user."
      );
    }
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
