// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Column policy — one `sys_dictionary` row becomes one {@link FieldDescriptor} (§5.3, design §7.1).
 *
 * Everything the serializer is allowed to know about a column is decided here,
 * because D7 requires every active suppression to be ENUMERABLE: a rule that
 * lived in the serializer would drop bytes that no report could name. The
 * serializer's own docblock states the other half of that contract — it applies
 * no suppression list of its own.
 *
 * Why the extension table is declared in this package
 * ---------------------------------------------------
 * `packages/core/src/fieldMap.ts` holds the same eight rows for the v1 CLI, and
 * this module deliberately does NOT import them: `@syncrona/mirror` depends on
 * `@syncrona/sn-transport`, `@syncrona/credential-store` and
 * `@syncrona/redaction` and on nothing else, and a leaf library that imported
 * the CLI it is consumed by would invert the dependency graph the workspace
 * rule protects. The duplication is a known cost, and it is a cost worth
 * pricing: the two tables decide file EXTENSIONS in two different trees, so a
 * divergence is a format change under INV-8 rather than a cosmetic difference.
 * If a third consumer appears, the table belongs in `@syncrona/sn-transport`
 * next to the other shared platform knowledge — see "Contracts change needed".
 *
 * What is deliberately NOT here
 * -----------------------------
 * Design §7.1 also allows per-table JSON-blob overrides (a flow `snapshot`
 * column is `internal_type: string` on the wire and JSON in fact, M13/P3).
 * {@link PerTableConfig} has no field for that, and inventing a curated
 * table→column map inside the engine would hardcode instance knowledge the D21
 * rule exists to avoid. So blob detection is type-driven only, and the override
 * lands the day the config contract grows a place to spell it.
 */
import { SYS_ID_RE } from "../constants";
import type { FieldDescriptor } from "../contracts";

/**
 * `internal_type` → file extension for fields extracted to a sibling file (§7.1).
 *
 * A `null` result (any type absent here) means "keep the value in the record
 * envelope". The entries mirror the v1 CLI's `SN_TYPE_MAP` exactly; see the
 * module docblock for why the table is copied rather than imported.
 */
export const EXTRACTED_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  css: "css",
  html: "html",
  html_script: "html",
  html_template: "html",
  script: "js",
  script_plain: "js",
  script_server: "js",
  xml: "xml",
};

/**
 * `internal_type` values that hold a JSON document as a string (§7.2).
 *
 * Conservative on purpose. A false positive is not silent — the serializer
 * writes the value behind `RAW_MARKER_PREFIX` and reports the parse failure —
 * but it still puts a `raw:` marker on a column that was never JSON, which
 * reads to an operator as a broken instance rather than a mis-typed catalog.
 * Adding a type here is cheap; removing one after a tree has been committed is
 * a format change (INV-8), so the set starts at the two types whose whole
 * purpose is to carry JSON.
 */
export const JSON_BLOB_TYPES: ReadonlySet<string> = new Set(["json", "json_translations"]);

/**
 * Field types that must never reach the tree, whatever the value looks like (D19).
 *
 * A `password2` column is returned to an authorized caller as a 106-character
 * CIPHERTEXT, not as a mask (M10) — a serializer that treated it as an ordinary
 * string would commit a recoverable secret to git, where rewriting history is
 * the only remedy. The deny is by type rather than by name because the column
 * is called `password` on one table and something else on the next.
 */
export const DENIED_FIELD_TYPES: ReadonlySet<string> = new Set(["password", "password2"]);

/**
 * Built-in churn columns, dropped from every table (design §7.1).
 *
 * These three change on every write and carry no information a git history does
 * not already hold better: `sys_updated_on` and `sys_updated_by` restate the
 * commit, and `sys_mod_count` is a counter. Keeping them would make every sync
 * produce a diff for records whose content never changed, which is the failure
 * mode that makes a mirror unreadable. They stay out of `record.json` but not
 * out of the catalog: the planner still needs `sys_updated_on` for watermarks,
 * which it reads from the wire row, not from the descriptor.
 */
export const NOISE_ELEMENTS: ReadonlySet<string> = new Set([
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
]);

/** What {@link describeField} needs beyond the dictionary row itself. */
export interface FieldPolicyContext {
  /** `PerTableConfig.ignoreFields` for the table being described (D7). */
  ignoreFields: ReadonlySet<string>;
  /** Resolve a `sys_db_object` sys_id to a table name; `null` when unknown. */
  tableNameOfSysId: (sysId: string) => string | null;
}

/**
 * Own-property lookup on the extension table.
 *
 * `internal_type` arrives from the instance, and a plain index would answer
 * `EXTRACTED_TYPE_EXTENSIONS["constructor"]` with a function — an `extractAs`
 * that is not a string, written into a file name. The same guard is used in the
 * v1 CLI's field map for the same reason.
 */
const ownExtension = (internalType: string): string | null =>
  Object.prototype.hasOwnProperty.call(EXTRACTED_TYPE_EXTENSIONS, internalType)
    ? EXTRACTED_TYPE_EXTENSIONS[internalType]
    : null;

/**
 * Whether a `sys_dictionary` row describes a column this catalog can use.
 *
 * Two rejections, both load-bearing:
 *
 *  - An EMPTY `element` is how the dictionary describes the TABLE itself
 *    (`internal_type: "collection"`), not a column. Taken as a column it would
 *    produce a descriptor named `""`, and the serializer would look for a wire
 *    value under the empty key on every record of every table.
 *  - `active=false` is a column the platform no longer delivers. The sweep
 *    already asks the instance to filter these out, and this check is the
 *    reason that request is an optimization rather than a dependency: M12/D20
 *    measured that a condition naming a column the table does not have is
 *    SILENTLY dropped and the query then matches everything, so a filter that
 *    is quietly ignored must not be the only thing enforcing the rule.
 */
export const isActiveColumnRow = (row: Record<string, string>): boolean =>
  (row.element ?? "") !== "" && (row.active ?? "") !== "false";

/**
 * Resolve `sys_dictionary.reference` to a table NAME.
 *
 * The value's shape depends on the instance, not on the mirror: with
 * `sysparm_exclude_reference_link=true` a reference column returns the raw
 * stored value, which for `sys_dictionary.reference` is the `sys_db_object`
 * sys_id — while a fixture, an export or a future platform release may hand
 * over the name directly. {@link TableCatalogEntry} promises a name, so a
 * sys_id-shaped value (INV-6) is translated through the table index and
 * anything else is taken as the name it already is. An unresolvable sys_id
 * becomes `null` rather than a 32-hex string masquerading as a table name.
 */
const resolveReference = (raw: string, context: FieldPolicyContext): string | null => {
  if (raw === "") {
    return null;
  }
  return SYS_ID_RE.test(raw) ? context.tableNameOfSysId(raw) : raw;
};

/**
 * `sys_dictionary.max_length` as a number, or `null` when the dictionary declares none.
 *
 * The empty-string case is separated from the parse because `Number("")` is 0
 * (M8: an absent value arrives as `""`, never as null), and a declared maximum
 * length of zero is a claim a downstream truncation check would act on.
 */
const resolveMaxLength = (raw: string): number | null => {
  if (raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Build the descriptor for one column.
 *
 * `isNoise` merges two independent decisions — the engine's churn list and the
 * operator's `ignoreFields` — because the serializer needs one boolean. The
 * decomposition D7 asks for is not lost: `CatalogService` reports the two lists
 * separately, which is why this function takes the ignore set of the table
 * being described rather than of the table that OWNS the dictionary row. An
 * inherited column suppressed on the child must stay unsuppressed on the parent.
 */
export function describeField(
  row: Record<string, string>,
  context: FieldPolicyContext
): FieldDescriptor {
  const element = row.element ?? "";
  const internalType = row.internal_type ?? "";
  return {
    element,
    internalType,
    extractAs: ownExtension(internalType),
    isJsonBlob: JSON_BLOB_TYPES.has(internalType),
    isNoise: NOISE_ELEMENTS.has(element) || context.ignoreFields.has(element),
    isDenied: DENIED_FIELD_TYPES.has(internalType),
    reference: resolveReference(row.reference ?? "", context),
    maxLength: resolveMaxLength(row.max_length ?? ""),
  };
}
