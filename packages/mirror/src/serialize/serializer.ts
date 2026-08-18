// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Record serializer — architecture §5.6, canonical byte format §8, INV-7.
 *
 * This module turns one Table API row into the canonical value set that will be
 * written for that record. It is the single place in the mirror engine where
 * "what the instance said" becomes "what git will see", which is why it is held
 * to a stricter standard than the stages around it:
 *
 *  - **INV-7 — serialization is a pure function of (row, catalog entry).** No
 *    config lookup, no clock, no filesystem, no environment, no module-level
 *    mutable state. The reason is not stylistic: the mirror's whole value is that
 *    an unchanged instance produces an unchanged tree, so a second run diffs to
 *    nothing. Any hidden input — a timestamp, a config flag read at call time, a
 *    cache that warms up — turns a re-run into a whole-tree diff and destroys the
 *    signal the mirror exists to provide. `test/serializerPurity.test.ts` reads
 *    this module's import graph and fails if a forbidden dependency appears.
 *  - **INV-8 — the bytes are versioned.** Every rule below is pinned by a golden
 *    fixture. Changing one of them is not a refactor: it is a format change that
 *    requires bumping `FORMAT_VERSION` and shipping a migration, because every
 *    existing mirror would otherwise rewrite itself on the next run.
 *
 * The byte rules (§8), each implemented exactly once below:
 *
 *  1. Object keys sorted ascending by UTF-16 code unit **at every nesting level**.
 *  2. Empty-string values dropped (M8: the Table API sends `""`, never absence,
 *     so without this every record carries dozens of meaningless keys).
 *  3. Noise and denied columns absent entirely.
 *  4. Extracted fields written as sibling files with a normalized trailing newline.
 *  5. JSON-blob columns parsed and re-emitted canonically; on failure the verbatim
 *     string behind the `raw:` marker, and the column named in `parseFailures` (F6).
 *  6. UTF-8, LF, exactly one trailing newline, two-space indent, no BOM.
 */
import { JSON_INDENT, RAW_MARKER_PREFIX } from "../constants";
import type {
  FieldDescriptor,
  SerializedRecord,
  TableCatalogEntry,
} from "../contracts";

/** The column that carries record identity on every ServiceNow table. */
const SYS_ID_FIELD = "sys_id";

/**
 * Compare two strings by UTF-16 code unit — §8's ordering, spelled out.
 *
 * `<`/`>` on strings is ECMA-262's code-unit comparison, which is exactly what
 * §8 specifies and, crucially, is the same on every machine. Do NOT replace this
 * with `localeCompare`: that is locale- and ICU-version-dependent, so two
 * developers running the same mirror against the same instance would produce
 * different key orders and therefore a diff caused by nothing but their laptops.
 * The comparator is explicit rather than relying on `sort()`'s default (which
 * happens to agree) so that the intent survives the next refactor.
 */
function codeUnitOrder(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Largest value a property key may denote and still be an "array index" for the
 * purposes of JavaScript's own-key ordering (indices run 0 … 2^32 − 2).
 */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
const ARRAY_INDEX_KEY_RE = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * Whether a key is an integer-index key, i.e. one that JavaScript will hoist
 * ahead of the string keys and re-order numerically no matter how it was
 * inserted. `{"10": …, "9": …}` is stored — and therefore stringified — as
 * `9` before `10`, while §8 demands code-unit order (`"10"` before `"9"`).
 * Detecting the situation is what lets {@link canonicalJsonText} switch to the
 * explicit-order path below instead of silently emitting the wrong order.
 */
function isArrayIndexKey(key: string): boolean {
  return ARRAY_INDEX_KEY_RE.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

/** Result of one deep walk over a JSON-shaped value. */
interface CanonicalWalk {
  /** The value with every object rebuilt in sorted-key order. */
  value: unknown;
  /** Every object key seen anywhere in the graph. */
  keys: Set<string>;
  /**
   * True when at least one integer-index key was seen, so the rendering step
   * cannot trust JavaScript's own-key order and must dictate it explicitly.
   */
  explicitOrder: boolean;
}

/**
 * Rebuild a JSON-shaped value with every object's keys in code-unit order,
 * collecting the information the renderer needs.
 *
 * Objects are rebuilt with `Object.create(null)` rather than `{}` for a concrete
 * reason: `JSON.parse` produces `__proto__` as an ordinary own data property, but
 * assigning to `__proto__` on a normal object hits the inherited setter, which
 * would silently swallow the value (data loss) or change the object's prototype
 * (prototype pollution) on content we do not control. A null-prototype object has
 * no such setter, so the key round-trips as data — which is what it is.
 */
function canonicalWalk(value: unknown): CanonicalWalk {
  const keys = new Set<string>();
  let explicitOrder = false;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => visit(item));
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    const source = node as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort(codeUnitOrder)) {
      keys.add(key);
      if (!explicitOrder && isArrayIndexKey(key)) {
        explicitOrder = true;
      }
      sorted[key] = visit(source[key]);
    }
    return sorted;
  };

  return { value: visit(value), keys, explicitOrder };
}

/** Render an already-walked value as canonical JSON text. */
function renderCanonical(walk: CanonicalWalk): string {
  // `JSON.stringify`'s replacer ARRAY is not just a filter: ECMA-262 uses it as
  // the property list, in the order given, for every object it serializes. Passing
  // the union of all keys in the graph — itself code-unit sorted — therefore forces
  // §8's order even for the integer-index keys the language would otherwise hoist,
  // and no key can be lost because the list is collected from the same walk.
  //
  // It is used only when needed. The property list is consulted per object, so it
  // costs O(objects × distinct keys) — fine for the rare blob that keys by small
  // integers, wasteful for the overwhelming majority that do not and for which
  // plain insertion order is already exactly right.
  const text = walk.explicitOrder
    ? JSON.stringify(
        walk.value,
        [...walk.keys].sort(codeUnitOrder),
        JSON_INDENT
      )
    : JSON.stringify(walk.value, null, JSON_INDENT);

  if (text === undefined) {
    // `JSON.stringify` answers `undefined` — not a string — for `undefined`,
    // functions and symbols. Interpolating that would write the six characters
    // "undefined" into the mirror as if they were data. A caller that gets here
    // has a bug, and a loud one is cheaper than a corrupt tree.
    throw new TypeError(
      "canonicalJsonText requires a JSON-serializable value; received a value " +
        "that JSON.stringify cannot represent."
    );
  }
  return `${text}\n`;
}

/**
 * The canonical JSON text of a value (§8): keys sorted by UTF-16 code unit at
 * every nesting level, two-space indent, LF, exactly one trailing newline.
 *
 * This is the ONLY supported way to render a {@link SerializedRecord}'s
 * `recordJsonValue`. A plain `JSON.stringify` would emit whatever key order the
 * object happens to carry, which is not the same thing (see
 * {@link isArrayIndexKey}) and would break INV-1's byte-identical re-run.
 */
export function canonicalJsonText(value: unknown): string {
  return renderCanonical(canonicalWalk(value));
}

/**
 * UTF-8 bytes of a string, with no BOM (§8).
 *
 * `TextEncoder` always emits UTF-8 without a byte-order mark, which is the
 * property we need: a BOM would make every file differ from its byte-identical
 * twin produced by any other tool, and git would treat it as content.
 */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The canonical bytes of a value — {@link canonicalJsonText} in UTF-8. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encodeUtf8(canonicalJsonText(value));
}

/**
 * Guarantee a single trailing newline without touching anything else.
 *
 * Extracted files hold instance content — a script, a stylesheet, a template —
 * and that content is reproduced byte for byte, because the mirror's job is to
 * record what the instance has, not to tidy it. The one exception is the final
 * newline: POSIX tools and git both treat a missing one as a defect ("\ No
 * newline at end of file" on every subsequent diff), and appending it is the only
 * edit whose absence would cost more than its presence. Note what is deliberately
 * NOT done here: interior CRLF sequences are left alone (M18 — scripts arrive
 * LF-only, and a stray CRLF is real content), and Unicode is not normalized
 * (D18's NFC rule is about file NAMES, not file contents).
 */
export function withTrailingNewline(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

/**
 * The string form of one Table API cell.
 *
 * Values arrive as strings when the client sets `sysparm_exclude_reference_link`
 * (M7), but as `{ link, value }` objects when it does not — and `String({…})`
 * yields "[object Object]", a value that looks like data, survives into git, and
 * is wrong. Both forms are accepted and reference cells are unwrapped to the
 * referenced sys_id, matching the core CLI's long-standing behaviour
 * (`packages/core/src/metaFields.ts`). Anything with no usable string form
 * becomes `""`, which rule 2 then drops — better an absent key than a fabricated
 * one.
 */
function wireValueText(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "object") {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return String(raw);
}

/** Read an own property, never one inherited from a polluted prototype. */
function ownValue(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? source[key]
    : undefined;
}

/**
 * Index a catalog entry's columns by name.
 *
 * First entry wins on a duplicate. D21 has the catalog union a table's own
 * dictionary rows with every inherited row along the `super_class` chain, and a
 * child table may redeclare a parent column — so duplicates are possible and the
 * serializer must not resolve them by accident. Precedence is the catalog's
 * decision, expressed as its ordering; the serializer only promises to honour it
 * deterministically.
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
 * File name for an extracted field.
 *
 * NFC-normalized per D18: macOS hands out decomposed (NFD) names while Linux and
 * git store what they are given, so an unnormalized name makes the same record
 * produce two different paths on two developers' machines. Normalizing at the
 * point the name is MINTED is what keeps the rule cheap. Note the serializer only
 * proposes this name — the Writer is responsible for the safety check (§5.8: no
 * separators, no traversal), the 200-byte cap and the F9 collision handling,
 * because those decisions need the whole record's file set and the target path.
 */
function extractedFileName(element: string, extension: string): string {
  return `${element}.${extension}`.normalize("NFC");
}

/** A JSON-blob column, parsed and canonicalized, in both the forms we may need. */
interface CanonicalBlob {
  value: unknown;
  text: string;
}

/**
 * Parse and canonicalize a JSON-blob column, or `null` if that is impossible.
 *
 * Parsing, walking and rendering all happen inside one `try` on purpose. The
 * content is untrusted (T4): it can be "not JSON at all" (F6), but it can equally
 * be syntactically valid JSON nested deeply enough to overflow the stack in the
 * walk or in `JSON.stringify`. All three outcomes mean the same thing — we cannot
 * produce a canonical form — and all three must therefore take the same exit, or
 * a hostile record would crash the run instead of being recorded honestly.
 */
function tryCanonicalBlob(text: string): CanonicalBlob | null {
  try {
    const walk = canonicalWalk(JSON.parse(text));
    return { value: walk.value, text: renderCanonical(walk) };
  } catch {
    return null;
  }
}

/**
 * Serialize one Table API row into its canonical, pre-redaction form (§5.6).
 *
 * Two design decisions worth stating, because both are easy to "fix" wrongly:
 *
 *  - **Iteration is over the ROW's keys, not the catalog's fields.** A column the
 *    catalog does not know about (added since the catalog was built, or exposed
 *    by a class the union missed) is still written, as a plain string. Dropping it
 *    would be a silent skip, which R3 forbids. The converse — a catalogued column
 *    the response omitted, e.g. a column-level read ACL, F5 — needs no code at
 *    all: it simply produces nothing, so the mirror never claims a value it was
 *    not shown.
 *  - **The serializer applies no suppression list of its own.** `isNoise` and
 *    `isDenied` come from the descriptor and nowhere else, so D7's requirement
 *    that every active suppression be enumerable in the run report stays true by
 *    construction. Hard-coding even one "obviously useless" column here would make
 *    the report a lie.
 */
export function serializeRow(
  row: Record<string, unknown>,
  tableEntry: TableCatalogEntry
): SerializedRecord {
  const descriptors = indexDescriptors(tableEntry.fields);
  const recordJsonValue: Record<string, unknown> = Object.create(null);
  const extractedFiles: Array<{ fileName: string; contents: string }> = [];
  const parseFailures: string[] = [];

  for (const element of Object.keys(row).sort(codeUnitOrder)) {
    const descriptor = descriptors.get(element);

    // Rule 3: noise and denied columns never reach the tree. `isDenied` is by
    // field TYPE and is load-bearing (D19): `password2` comes back as ciphertext,
    // not as a mask, so letting it through would commit a recoverable secret.
    if (descriptor !== undefined && (descriptor.isNoise || descriptor.isDenied)) {
      continue;
    }

    const text = wireValueText(row[element]);

    // Rule 2: an empty value is dropped rather than written as "". M8 measured
    // that the Table API returns every column, empty ones as `""`, so keeping
    // them would bloat every record with keys that say nothing — and an extracted
    // field with no content would produce a file holding nothing but a newline.
    if (text === "") {
      continue;
    }

    const extractAs = descriptor?.extractAs ?? null;

    if (descriptor?.isJsonBlob !== true) {
      // Rule 4: a plain extracted field is copied verbatim into its sibling file.
      if (extractAs !== null) {
        extractedFiles.push({
          fileName: extractedFileName(element, extractAs),
          contents: withTrailingNewline(text),
        });
      } else {
        recordJsonValue[element] = text;
      }
      continue;
    }

    // Rule 5. `extractAs` and `isJsonBlob` are orthogonal: the first decides
    // WHERE the value lands, the second HOW it is interpreted. A blob with an
    // extension becomes a canonical sibling document; a blob without one is
    // nested inside the record envelope, where §8's per-level sort applies to it
    // exactly as it does to the envelope's own keys.
    const blob = tryCanonicalBlob(text);
    if (blob === null) {
      // F6. The value stays in the ENVELOPE even when the column is normally
      // extracted: writing it to `<field>.json` would produce a `.json` file that
      // is not JSON, which every downstream reader would trip over. Behind the
      // marker, in the envelope, it is unambiguous — and it is reported, so the
      // run report can count it rather than the failure being discovered later by
      // whoever tried to parse the tree.
      parseFailures.push(element);
      recordJsonValue[element] = `${RAW_MARKER_PREFIX}${text}`;
      continue;
    }

    if (extractAs !== null) {
      extractedFiles.push({
        fileName: extractedFileName(element, extractAs),
        contents: blob.text,
      });
    } else {
      recordJsonValue[element] = blob.value;
    }
  }

  // Column order already implies file order for every real column name, but only
  // because ServiceNow column names cannot contain a character below `.`. NFC
  // normalization can in principle also reorder. Sorting the list outright makes
  // the guarantee unconditional and costs nothing at this size.
  extractedFiles.sort((a, b) => codeUnitOrder(a.fileName, b.fileName));

  return {
    // Reported as it arrived, including "" when the row carried no `sys_id`.
    // Validating it here would be the wrong place: INV-6 constrains PATH
    // segments, so the Planner and the Writer are the stages that must reject a
    // malformed id, and a serializer that threw would take down a whole page for
    // one bad row.
    sysId: wireValueText(ownValue(row, SYS_ID_FIELD)),
    table: tableEntry.name,
    recordJsonValue,
    extractedFiles,
    parseFailures,
  };
}
