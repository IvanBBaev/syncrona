// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Property-based coverage for the serializer (INV-1, INV-7, §8).
 *
 * The golden fixtures pin the bytes for ten hand-chosen inputs. What they cannot
 * do is show that the RULES hold for inputs nobody thought of, and that is
 * exactly the risk profile of this module: it consumes whatever an instance
 * happens to contain — a column named "10", a blob that is almost JSON, a value
 * that is an object rather than a string — and the mirror's entire value rests on
 * the claim that a re-run of an unchanged instance produces an unchanged tree.
 *
 * "Idempotence" is asserted here in the three senses that actually matter:
 *
 *  1. **Repetition.** Serializing the same row twice yields the same bytes.
 *  2. **Input-order independence.** The same logical row with its keys inserted in
 *     a different order yields the same bytes. This is the sense that matters in
 *     production: the Table API makes no ordering promise, so a run whose output
 *     depended on key order would diff against itself for no reason.
 *  3. **Re-canonicalization.** Canonical text parsed and canonicalized again is
 *     the same text — the fixed point that lets a later stage (redactor, writer,
 *     a migration) re-render a value without moving a byte.
 */
import fc from "fast-check";
import { RAW_MARKER_PREFIX } from "../src/constants";
import type { FieldDescriptor, TableCatalogEntry } from "../src/contracts";
import {
  canonicalJsonText,
  serializeRow,
} from "../src/serialize/serializer";

/**
 * The column names properties are drawn from.
 *
 * A fixed pool rather than random identifiers, because the interesting cases are
 * specific and a random generator would essentially never produce them: keys that
 * JavaScript hoists and re-orders numerically ("9" before "10" — §8 demands the
 * opposite), keys that differ only by case (uppercase sorts before lowercase by
 * code unit), the `_`-vs-`i` pair that separates code-unit order from anything
 * locale-aware, and the one key that turns a naive object copy into prototype
 * pollution.
 */
const ELEMENT_POOL = [
  "sys_id",
  "script",
  "cache",
  "9",
  "10",
  "u_flag",
  "unique",
  "A",
  "a",
  "__proto__",
] as const;

const descriptorArbitrary = (element: string): fc.Arbitrary<FieldDescriptor> =>
  fc
    .record({
      extractAs: fc.constantFrom(null, "js", "json", "txt"),
      isJsonBlob: fc.boolean(),
      isNoise: fc.boolean(),
      isDenied: fc.boolean(),
    })
    .map((flags) => ({
      element,
      internalType: "string",
      reference: null,
      maxLength: null,
      ...flags,
    }));

const catalogArbitrary: fc.Arbitrary<TableCatalogEntry> = fc
  .tuple(...ELEMENT_POOL.map((element) => descriptorArbitrary(element)))
  .map((fields) => ({
    name: "u_property",
    sysId: "00000000000000000000000000000000",
    superClass: null,
    isMetadata: true,
    tier: 1,
    rowCount: null,
    maxUpdatedOn: null,
    fields,
    status: "included" as const,
  }));

/**
 * The cell values properties are drawn from — every wire form the Fetcher can
 * hand over, weighted towards the ones that exercise a branch: the empty string
 * that rule 2 drops, text that parses as JSON, text that nearly does, and the
 * `{ link, value }` reference form the Table API sends unless the client asks it
 * not to (M7).
 */
const valueArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  {
    // "\u0065\u0301" is a decomposed e-acute: content the serializer must NOT
    // normalize, written as an escape because the composed form is
    // indistinguishable from it in an editor.
    arbitrary: fc.constantFrom("", "x", "0", "  ", "a\nb", "\u0065\u0301"),
    weight: 4,
  },
  {
    arbitrary: fc
      .jsonValue({ maxDepth: 3 })
      .map((value) => JSON.stringify(value)),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom("{", "[1,2", "not json", '{"a":}', "raw:already"),
    weight: 2,
  },
  { arbitrary: fc.string({ maxLength: 12 }), weight: 2 },
  {
    arbitrary: fc.record({
      link: fc.constant("https://example.service-now.com/api/now/table/x/y"),
      value: fc.constantFrom("", "cc11000000000000000000000000dd22"),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.oneof(fc.boolean(), fc.integer(), fc.constant(null)),
    weight: 1,
  }
);

/** One row's worth of cells, as ordered [key, value] pairs. */
const rowEntriesArbitrary = fc.uniqueArray(
  fc.tuple(fc.constantFrom(...ELEMENT_POOL), valueArbitrary),
  { selector: ([element]) => element, maxLength: ELEMENT_POOL.length }
);

/**
 * Build a row from ordered pairs.
 *
 * `Object.create(null)` is required, not stylistic: on a normal object the
 * assignment `row["__proto__"] = …` reaches the inherited setter, so the test
 * fixture itself would either lose the key or mutate its own prototype — and the
 * pollution path would never be exercised.
 */
const buildRow = (
  entries: ReadonlyArray<readonly [string, unknown]>
): Record<string, unknown> => {
  const row: Record<string, unknown> = Object.create(null);
  for (const [element, value] of entries) {
    row[element] = value;
  }
  return row;
};

/**
 * The top-level keys of a canonical document, in the order they were EMITTED.
 *
 * `Object.keys` would answer the insertion order of the in-memory object, which
 * is precisely the thing §8 says not to trust (JavaScript hoists integer-index
 * keys). Reading them back out of the rendered text is the only way to assert
 * what was actually written. Top-level keys are the ones at exactly one indent —
 * nested keys are deeper, and no value can masquerade as a key line because
 * JSON.stringify escapes newlines inside strings.
 */
const emittedTopLevelKeys = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => /^ {2}("(?:[^"\\]|\\.)*"):/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => JSON.parse(match[1]) as string);

const isSortedByCodeUnit = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1] < value);

describe("serializeRow properties", () => {
  it("is deterministic: the same input twice produces the same bytes", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const first = serializeRow(buildRow(entries), entry);
        const second = serializeRow(buildRow(entries), entry);

        expect(canonicalJsonText(second.recordJsonValue)).toBe(
          canonicalJsonText(first.recordJsonValue)
        );
        expect(second.extractedFiles).toEqual(first.extractedFiles);
        expect(second.parseFailures).toEqual(first.parseFailures);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("ignores the order the row's keys arrived in", () => {
    fc.assert(
      fc.property(
        rowEntriesArbitrary.chain((entries) =>
          fc.tuple(
            fc.constant(entries),
            fc.shuffledSubarray(entries, {
              minLength: entries.length,
              maxLength: entries.length,
            })
          )
        ),
        catalogArbitrary,
        ([entries, shuffled], entry) => {
          const asGiven = serializeRow(buildRow(entries), entry);
          const reordered = serializeRow(buildRow(shuffled), entry);

          expect(canonicalJsonText(reordered.recordJsonValue)).toBe(
            canonicalJsonText(asGiven.recordJsonValue)
          );
          expect(reordered.extractedFiles).toEqual(asGiven.extractedFiles);
          // parseFailures is derived from the same sorted iteration, so its order
          // is a property of the record, not of the response.
          expect(reordered.parseFailures).toEqual(asGiven.parseFailures);
          return true;
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("emits top-level keys in code-unit order", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const record = serializeRow(buildRow(entries), entry);
        const keys = emittedTopLevelKeys(
          canonicalJsonText(record.recordJsonValue)
        );

        expect(isSortedByCodeUnit(keys)).toBe(true);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("writes nothing the row did not contain and nothing it was told to suppress", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const row = buildRow(entries);
        const record = serializeRow(row, entry);
        const suppressed = new Set(
          entry.fields
            .filter((field) => field.isNoise || field.isDenied)
            .map((field) => field.element)
        );
        const present = new Set(Object.keys(row));

        const blobs = new Set(
          entry.fields
            .filter((field) => field.isJsonBlob)
            .map((field) => field.element)
        );

        for (const key of Object.keys(record.recordJsonValue)) {
          // Every envelope key is a column the response actually carried…
          expect(present.has(key)).toBe(true);
          // …and no suppressed column survives (D19: `password2` is ciphertext,
          // not a mask, so a leak here is a recoverable secret in git).
          expect(suppressed.has(key)).toBe(false);
          if (!blobs.has(key)) {
            // Rule 2 drops empty CELLS. Blobs are excluded deliberately: a blob
            // whose wire text is the two characters `""` is a non-empty cell
            // holding the JSON document for the empty string, and its parsed
            // value is data. See the unit test of the same name.
            expect(record.recordJsonValue[key]).not.toBe("");
          }
        }

        // A suppressed column must not escape through the sibling-file path
        // either — extraction and suppression are independent flags.
        for (const file of record.extractedFiles) {
          for (const element of suppressed) {
            expect(file.fileName.startsWith(`${element}.`)).toBe(false);
          }
        }

        // Each column lands in at most one place, so nothing can be written twice.
        expect(
          Object.keys(record.recordJsonValue).length +
            record.extractedFiles.length
        ).toBeLessThanOrEqual(present.size);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("marks and reports every column it could not parse, and only those", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const row = buildRow(entries);
        const record = serializeRow(row, entry);

        for (const element of record.parseFailures) {
          // F6 keeps the value in the envelope even for an extracted column: a
          // `<field>.json` file that is not JSON would break every reader
          // downstream, whereas the marker is unambiguous.
          const value = record.recordJsonValue[element];
          expect(typeof value).toBe("string");
          expect((value as string).startsWith(RAW_MARKER_PREFIX)).toBe(true);
          expect(
            record.extractedFiles.some((file) =>
              file.fileName.startsWith(`${element}.`)
            )
          ).toBe(false);
        }

        // The other direction, which is the one R3 is about: a blob that cannot
        // be parsed may not be quietly dropped or quietly written raw — it must
        // be NAMED. Decided here from `JSON.parse` alone, which agrees with the
        // implementation for values of this size (the walk and the render can
        // only fail on input deep enough to overflow the stack, which the
        // generators above never produce; that path has its own unit test).
        for (const field of entry.fields) {
          const cell = row[field.element];
          const isBlobStringCell =
            field.isJsonBlob &&
            !field.isNoise &&
            !field.isDenied &&
            typeof cell === "string" &&
            cell !== "";
          if (!isBlobStringCell) {
            continue;
          }
          let parses = true;
          try {
            JSON.parse(cell as string);
          } catch {
            parses = false;
          }
          expect(record.parseFailures.includes(field.element)).toBe(!parses);
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("never mutates the row or the catalog entry it was given (INV-7)", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const row = buildRow(entries);
        const rowBefore = JSON.stringify(row);
        const entryBefore = JSON.stringify(entry);

        serializeRow(row, entry);

        expect(JSON.stringify(row)).toBe(rowBefore);
        expect(JSON.stringify(entry)).toBe(entryBefore);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it("produces extracted files in a stable, sorted order with a trailing newline", () => {
    fc.assert(
      fc.property(rowEntriesArbitrary, catalogArbitrary, (entries, entry) => {
        const row = buildRow(entries);
        const record = serializeRow(row, entry);
        const names = record.extractedFiles.map((file) => file.fileName);

        // Default `sort()` is code-unit order, the same order §8 uses for keys.
        expect([...names].sort()).toEqual(names);
        for (const file of record.extractedFiles) {
          expect(file.contents.endsWith("\n")).toBe(true);
        }

        // A non-blob extracted field is reproduced VERBATIM apart from that
        // final newline. This is the contract an extracted file exists for: the
        // mirror records what the instance has, so any trimming, re-indenting or
        // Unicode normalization of CONTENT would make the tree disagree with the
        // instance it claims to mirror.
        for (const field of entry.fields) {
          const cell = row[field.element];
          const isVerbatimCell =
            !field.isJsonBlob &&
            !field.isNoise &&
            !field.isDenied &&
            field.extractAs !== null &&
            typeof cell === "string" &&
            cell !== "";
          if (!isVerbatimCell) {
            continue;
          }
          const expectedName = `${field.element}.${field.extractAs}`.normalize(
            "NFC"
          );
          const file = record.extractedFiles.find(
            (candidate) => candidate.fileName === expectedName
          );
          expect(file?.contents).toBe(
            (cell as string).endsWith("\n") ? cell : `${cell as string}\n`
          );
        }
        return true;
      }),
      { numRuns: 500 }
    );
  });
});

describe("canonicalJsonText properties", () => {
  it("is idempotent: re-canonicalizing canonical text changes nothing", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const once = canonicalJsonText(value);
        const twice = canonicalJsonText(JSON.parse(once));

        expect(twice).toBe(once);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("preserves the value through the round trip", () => {
    // Canonicalization is a FORMATTING operation, not a transformation: it may
    // reorder keys and change whitespace and nothing else. A sort that dropped a
    // duplicate-looking key, or a property-list render that lost a key the walk
    // failed to collect, would show up here and nowhere else.
    //
    // The reference is plain `JSON.stringify`, not the input value, because JSON
    // itself is lossy in one respect the serializer neither causes nor can fix:
    // there is no negative zero in JSON, so `-0` comes back as `0` through ANY
    // JSON round trip. Comparing against the input would make this test assert a
    // property of JSON rather than a property of the serializer, and it would
    // fail on roughly one run in a thousand — a flake that teaches the team to
    // re-run the suite instead of reading it.
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        expect(JSON.parse(canonicalJsonText(value))).toEqual(
          JSON.parse(JSON.stringify(value))
        );
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("ends with exactly one LF and contains no carriage return or BOM", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), (value) => {
        const text = canonicalJsonText(value);

        expect(text.endsWith("\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
        // JSON.stringify escapes both, so a literal here would mean the renderer
        // stopped going through JSON.stringify.
        expect(text).not.toContain("\r");
        expect(text.charCodeAt(0)).not.toBe(0xfeff);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it("does not depend on the order an object's keys were inserted in", () => {
    // The deep version of the same promise `serializeRow` makes at the top level:
    // a blob that arrives with its keys shuffled must still render identically,
    // or two instances holding the same data would diff.
    fc.assert(
      fc.property(
        fc
          .uniqueArray(
            fc.tuple(
              fc.constantFrom("b", "a", "10", "9", "A", "__proto__", "0"),
              fc.jsonValue({ maxDepth: 2 })
            ),
            { selector: ([key]) => key }
          )
          .chain((entries) =>
            fc.tuple(
              fc.constant(entries),
              fc.shuffledSubarray(entries, {
                minLength: entries.length,
                maxLength: entries.length,
              })
            )
          ),
        ([entries, shuffled]) => {
          expect(canonicalJsonText(buildRow(shuffled))).toBe(
            canonicalJsonText(buildRow(entries))
          );
          return true;
        }
      ),
      { numRuns: 1000 }
    );
  });
});
