// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Record redactor — architecture §5.7, §4.6, §8; INV-3.
 *
 * This is the last stage that can still see a secret and the only one that mints a
 * {@link RedactedRecord}. Everything downstream of it writes to a git repository
 * that is backup-equivalent and forever (§9), so the rules here are ordered by how
 * much they are trusted, strongest first, and every "I cannot tell" resolves toward
 * redaction:
 *
 *  1. **Field-TYPE deny (D19) — drop the column entirely.** Load-bearing, not
 *     hygiene: measured on a real instance, a `password2` column returns a
 *     106-character ciphertext over the Table API, so the wire genuinely carries
 *     encrypted secret material that no value-shape rule would recognise. The
 *     serializer already omits denied columns; this stage re-checks rather than
 *     assumes, because the two stages fail independently and the cost of the check
 *     is one map lookup per field.
 *  2. **Key-pattern deny** (`isSensitiveKey`) — replace the value with
 *     `__SYNCRONA_REDACTED__<sha256-12>` of the plaintext.
 *  3. **Value scan** (`looksLikeSecretValue`) on every remaining string, wherever it
 *     sits: a top-level column, a leaf inside a parsed JSON blob, or the body of an
 *     extracted script. A secret smuggled under a benign key is the failure mode
 *     this rule exists for.
 *  4. **Scan-budget overflow (F7)** — a value longer than `SCAN_BUDGET` cannot be
 *     scanned in full, so it is redacted WHOLE with reason `scan-overflow`, which
 *     the run report maps to `redaction-overflow` and exit code 2. Fail closed: the
 *     historical alternative (skip the scan, keep the value) meant padding a secret
 *     past the budget was enough to launder it (REV-145).
 *
 * The marker embeds a digest of the plaintext rather than being a constant, and that
 * is an INV-1 requirement, not a nicety: a constant marker would make a rotated
 * credential produce no diff, so the mirror would claim nothing changed at the exact
 * moment something security-relevant did. The digest is one-way and 48 bits — enough
 * to confirm a guess, never enough to invert — which is why §9 keeps a mirror
 * repository private regardless.
 *
 * PURITY. Like the serializer (INV-7), this module is a pure function of its
 * arguments: no configuration read at module scope, no clock, no filesystem, no
 * ambient state. The allowlist and the catalog entry arrive as parameters precisely
 * so that "what got redacted" is reproducible from the inputs alone — an unchanged
 * instance must produce an unchanged tree (INV-1), and a hidden input would break
 * that in the one stage whose output is unverifiable by inspection.
 * `test/redactorPurity.test.ts` reads this module's import graph and enforces it.
 */
import {
  SCAN_BUDGET,
  isSensitiveKey,
  looksLikeSecretValue,
  redactValue,
} from "@syncrona/redaction";

import type {
  FieldDescriptor,
  MirrorConfig,
  RedactedRecord,
  SerializedRecord,
  TableCatalogEntry,
} from "../contracts";
import {
  canonicalJsonBytes,
  canonicalJsonText,
  encodeUtf8,
  withTrailingNewline,
} from "./serializer";

/** One entry of {@link RedactedRecord.redactions}, named for reuse below. */
export type Redaction = RedactedRecord["redactions"][number];

/** Why a value was replaced or dropped (§4.6). */
export type RedactionReason = Redaction["reason"];

/** Everything the redactor needs from outside the record itself. */
export interface RedactionOptions {
  /**
   * Catalog entry for the record's table — the source of the field-TYPE deny
   * flags (D19). Passed whole rather than as a pre-computed deny list so that the
   * redactor reads the same descriptors the serializer did, from the same object.
   */
  table: TableCatalogEntry;
  /**
   * The resolved config's `redaction` section (§4.1). Optional, and its absence
   * means an EMPTY allowlist rather than a permissive one: a caller who forgot to
   * pass config gets more redaction, never less.
   */
  redaction?: MirrorConfig["redaction"];
}

/** The table whose rows carry an operator-defined key/value pair. */
const SYS_PROPERTIES_TABLE = "sys_properties";
/** The column holding a `sys_properties` row's property NAME. */
const PROPERTY_NAME_FIELD = "name";
/** The column holding a `sys_properties` row's property VALUE. */
const PROPERTY_VALUE_FIELD = "value";

/**
 * Index a catalog entry's columns by name, first entry wins.
 *
 * The tie-break has to agree with the serializer's `indexDescriptors`, because a
 * child table may redeclare a parent's column along the `super_class` chain (D21)
 * and the two stages must resolve that duplicate the same way — a serializer that
 * kept a column the redactor would have denied is exactly the leak INV-3 is about.
 * The rule is duplicated rather than shared only because the serializer keeps its
 * helper private; `test/redactor.test.ts` pins the two against each other on a
 * duplicated descriptor so the copies cannot drift apart silently.
 */
function indexDescriptors(
  fields: readonly FieldDescriptor[]
): Map<string, FieldDescriptor> {
  const byElement = new Map<string, FieldDescriptor>();
  for (const field of fields) {
    if (!byElement.has(field.element)) {
      byElement.set(field.element, field);
    }
  }
  return byElement;
}

/**
 * The column an extracted file came from — the inverse of the serializer's
 * `<element>.<extension>` naming.
 *
 * A ServiceNow column name cannot contain a dot, so the last dot is the extension
 * separator and the inverse is exact for every name the serializer can mint. A name
 * with no dot at all cannot have come from that function; it is mapped to itself,
 * which keeps the key-pattern rule applying to SOMETHING rather than silently
 * skipping the file.
 */
function elementOfFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * The marker that replaces a value of any JSON type.
 *
 * A string hashes as itself, so the marker for a field equals
 * `redactValue(plaintext)` and two mirrors of the same instance agree. Anything
 * else — an object or array under a sensitive key, a number, a boolean — hashes as
 * its canonical JSON text, which is the only rendering of it this package considers
 * stable (§8 key ordering included). Redacting a non-string whole is deliberate:
 * under a key named `password`, a structure is credential material regardless of
 * how it is shaped.
 */
function markerFor(value: unknown): string {
  return typeof value === "string"
    ? redactValue(value)
    : redactValue(canonicalJsonText(value));
}

/**
 * Classify a string that survived the key-pattern rule: `null` keeps it verbatim.
 *
 * The length test comes FIRST and is not redundant with the scan. `looksLikeSecretValue`
 * already answers `true` for an over-budget value — that is its fail-closed guard —
 * but it cannot say WHY, and the two answers are not interchangeable downstream: a
 * pattern hit is normal operation, while an unscannable value is F7 and must surface
 * as `redaction-overflow` with exit code 2, because the operator is entitled to know
 * that content was destroyed defensively rather than identified.
 */
function scanReason(text: string): RedactionReason | null {
  if (text.length > SCAN_BUDGET) {
    return "scan-overflow";
  }
  return looksLikeSecretValue(text) ? "value-scan" : null;
}

/**
 * Redact one node inside a parsed JSON blob (rules 2–4), returning the rewritten
 * value and appending to `redactions`.
 *
 * The scan unit is the string LEAF, not the enclosing document. A JSON blob is a
 * value the serializer parsed and re-emitted canonically, so its structure is data
 * the mirror understands; redacting a whole variables map because one member is a
 * password would destroy the record without protecting anything the leaf rule does
 * not already protect. `path` is the dotted/indexed route to the node, so a reader
 * of the run report can find the thing that changed.
 *
 * Objects are rebuilt with `Object.create(null)` for the same reason the serializer
 * does it: `__proto__` arrives from `JSON.parse` as an ordinary own property, and
 * assigning it on a normal object would either lose the value or repoint the
 * prototype on content the mirror does not control.
 */
function redactNode(
  node: unknown,
  path: string,
  redactions: Redaction[]
): unknown {
  if (typeof node === "string") {
    const reason = scanReason(node);
    if (reason === null) {
      return node;
    }
    redactions.push({ field: path, reason });
    return redactValue(node);
  }

  if (Array.isArray(node)) {
    return node.map((item, index) =>
      redactNode(item, `${path}[${index}]`, redactions)
    );
  }

  if (node === null || typeof node !== "object") {
    return node;
  }

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);
  // A bare `sort()` is UTF-16 code-unit order by definition, which is the order
  // §8 uses. It is not the BYTES that need it — `canonicalJsonBytes` sorts those
  // itself — but the redaction LIST, which is otherwise built in whatever order
  // the parsed object happens to carry and would differ between two runs of an
  // unchanged instance.
  for (const key of Object.keys(source).sort()) {
    const childPath = `${path}.${key}`;
    const child = source[key];
    if (isSensitiveKey(key)) {
      redactions.push({ field: childPath, reason: "key-pattern" });
      result[key] = markerFor(child);
      continue;
    }
    result[key] = redactNode(child, childPath, redactions);
  }
  return result;
}

/**
 * Whether a `sys_properties` row's `value` column must be redacted by key pattern.
 *
 * Three points that are easy to get wrong, all of them one-way:
 *
 *  - The key tested is the PROPERTY name (the row's `name` column), never the
 *    literal column name `value`. Testing `"value"` would pass every property
 *    through, including `glide.rest.outbound.password`.
 *  - The allowlist is an exact-match escape hatch for the key-pattern rule ONLY.
 *    It exists because that rule is deliberately over-eager — `/key/` matches
 *    `glide.ui.polaris.keyboard_shortcuts` — and narrowing the pattern for
 *    everyone is the wrong repair. It does not exempt a property from the value
 *    scan: an allowlisted property whose value is a PEM private key is still a PEM
 *    private key.
 *  - A row with no readable name fails CLOSED. The name is what the decision rests
 *    on, so without it there is no decision to make, and a `sys_properties` row
 *    with an empty name is malformed data rather than a case worth accommodating.
 */
function propertyValueIsSensitive(
  propertyName: string | null,
  allowlist: readonly string[]
): boolean {
  if (propertyName === null) {
    return true;
  }
  if (allowlist.includes(propertyName)) {
    return false;
  }
  return isSensitiveKey(propertyName);
}

/**
 * Read a `sys_properties` row's property name out of the serialized envelope.
 *
 * `null` when the column is absent — which, after serialization, also covers the
 * empty-value case, since an empty column is dropped rather than written as `""`.
 */
function propertyNameOf(
  table: string,
  recordJsonValue: Record<string, unknown>
): string | null {
  if (table !== SYS_PROPERTIES_TABLE) {
    return null;
  }
  const name = recordJsonValue[PROPERTY_NAME_FIELD];
  return typeof name === "string" ? name : null;
}

/**
 * Apply rules 2–4 to an extracted file's body, returning the text to write.
 *
 * Extraction is a layout decision — a script lives in `script.js` instead of inside
 * the envelope so that diffs are readable — and a layout decision must not be a
 * security decision. So the body goes through the same chain as any other value,
 * keyed on the column it came from. Two consequences worth naming: a column called
 * `key` or `cert` has its whole body replaced even though it is legitimately a
 * script (over-eager by construction, and the direction to err in), and a body over
 * `SCAN_BUDGET` is replaced whole under F7 — which on a real instance is a
 * routinely-reached size for a large business rule.
 */
function redactExtracted(
  fileName: string,
  element: string,
  contents: string,
  redactions: Redaction[]
): string {
  if (isSensitiveKey(element)) {
    redactions.push({ field: fileName, reason: "key-pattern" });
    return redactValue(contents);
  }
  const reason = scanReason(contents);
  if (reason === null) {
    return contents;
  }
  redactions.push({ field: fileName, reason });
  return redactValue(contents);
}

/**
 * Redact one canonicalized record and render it to final bytes (§5.7).
 *
 * This function is the ONLY place in the package that mints a
 * {@link RedactedRecord} (INV-3, §9): the Writer accepts nothing else, so a stage
 * that tried to put un-redacted bytes on disk would have to forge the brand, and
 * the forge is a single greppable construct that `test/redactedRecordBrand.test.ts`
 * fails on wherever else it appears.
 */
export function redactRecord(
  record: SerializedRecord,
  options: RedactionOptions
): RedactedRecord {
  const descriptors = indexDescriptors(options.table.fields);
  const allowlist = options.redaction?.propertyAllowlist ?? [];
  const propertyName = propertyNameOf(record.table, record.recordJsonValue);

  const redactions: Redaction[] = [];
  const envelope: Record<string, unknown> = Object.create(null);

  // Sorted for the same reason as the nested walk above: the redaction list is
  // part of the run report, and a report that reordered itself between two runs
  // of an unchanged instance would be a diff nobody asked for.
  for (const element of Object.keys(record.recordJsonValue).sort()) {
    const value = record.recordJsonValue[element];

    // Rule 1. The serializer omits denied columns already; if one is here anyway,
    // the catalog and the serializer disagree, and the safe reading of that
    // disagreement is that the column is denied.
    if (descriptors.get(element)?.isDenied === true) {
      redactions.push({ field: element, reason: "field-type" });
      continue;
    }

    // Rule 2, with the `sys_properties` special case: for that table the operator's
    // property name is the key that carries the meaning, so it is the key the
    // pattern is tested against.
    const isPropertyValue =
      record.table === SYS_PROPERTIES_TABLE && element === PROPERTY_VALUE_FIELD;

    const keyIsSensitive = isPropertyValue
      ? propertyValueIsSensitive(propertyName, allowlist)
      : isSensitiveKey(element);

    if (keyIsSensitive) {
      redactions.push({ field: element, reason: "key-pattern" });
      envelope[element] = markerFor(value);
      continue;
    }

    // Rules 3 and 4, applied to the value's string leaves wherever they are.
    envelope[element] = redactNode(value, element, redactions);
  }

  const extractedFiles: RedactedRecord["extractedFiles"] = [];
  for (const file of record.extractedFiles) {
    const element = elementOfFileName(file.fileName);

    // Rule 1 again. An extracted file is a column's value that happens to live in
    // its own file; a denied column must not produce one, and the file is dropped
    // rather than emptied, because an empty `password.js` in the tree would be a
    // claim about the record that the mirror cannot make.
    if (descriptors.get(element)?.isDenied === true) {
      redactions.push({ field: file.fileName, reason: "field-type" });
      continue;
    }

    extractedFiles.push({
      fileName: file.fileName,
      // §8: field bytes verbatim except a single guaranteed trailing newline, UTF-8,
      // no BOM. A redacted file gets the same treatment — a marker is content now.
      contents: encodeUtf8(
        withTrailingNewline(
          redactExtracted(file.fileName, element, file.contents, redactions)
        )
      ),
    });
  }

  // The single mint site (INV-3). The assertion is unavoidable: the brand is a
  // `unique symbol` no expression can denote, which is precisely what makes every
  // OTHER `as RedactedRecord` in the package a detectable bypass rather than a
  // matter of taste. See the contract's doc comment for why the alternatives that
  // avoid a cast are weaker rather than stronger.
  return {
    sysId: record.sysId,
    table: record.table,
    recordJsonBytes: canonicalJsonBytes(envelope),
    extractedFiles,
    redactions,
  } as RedactedRecord;
}
