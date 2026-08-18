// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for `src/write/recordPath.ts` — D18 naming and F9 collisions (WP-M7).
 *
 * D18 has three parts and the resolver has one property, and the property is the
 * part that matters:
 *
 *  1. NFC, so a decomposed name does not become a second directory beside its
 *     composed twin on a filesystem that hands back the composed form.
 *  2. A `MAX_NAME_BYTES` cap measured in UTF-8 BYTES. Every byte-cap test below
 *     uses a genuinely multi-byte name, because a `.length` cap passes an ASCII
 *     test and fails on the first Cyrillic record on a real instance.
 *  3. Case-insensitive uniqueness, resolved with a deterministic `_<sysId>`
 *     suffix on EVERY member of a colliding group.
 *
 * The property is order-independence, and it is what INV-1 rests on: the resolver
 * is fed one record at a time as a sweep pages through a table, so if its answer
 * depended on arrival order then an unchanged instance would produce a different
 * tree on every run and every mirror commit would look like a change. The
 * `describe("order independence")` block asserts it directly — the same record
 * set in two orders, and the incremental answer against `resolveUniqueNames` over
 * the whole directory at once.
 *
 * Note for a reader following the source: `src/write/recordPath.ts` points here for
 * both properties it claims. They are deliberately not split into a separate
 * `*.property.test.ts` — one module's tests belong in one file, and the fuzzed
 * assertions read as the last `describe` below rather than as a second suite.
 */
import fc from "fast-check";

import {
  buildSafeRecordName,
  canonicalFoldName,
  isSafePathComponent,
  resolveUniqueNames,
  type NameCandidate,
} from "@syncrona/sn-transport";

import { MAX_NAME_BYTES } from "../src/constants";
import {
  MirrorPathRejection,
  SHARD_DIR_NAME,
  recordDirRelPath,
} from "../src/shards/shardLayout";
import { RecordNameResolver } from "../src/write/recordPath";

const UTF8 = new TextEncoder();
const byteLength = (value: string): number => UTF8.encode(value).length;

/** A valid sys_id built from a short hex stem, so tests read as `id("a")`. */
const id = (stem: string): string => stem.padEnd(32, "0");

const ID_A = id("a");
const ID_B = id("b");
const ID_C = id("c");

/** `nameOf` without a non-null assertion; an unassigned record is a test failure. */
const nameOf = (resolver: RecordNameResolver, sysId: string): string => {
  const name = resolver.nameOf(sysId);
  if (name === undefined) {
    throw new Error(`no name was assigned to ${sysId}`);
  }
  return name;
};

// Characters are written as escapes, never as literal bytes: the repository's
// source-text gate rejects invisible characters, and an escape says exactly which
// code point a reader is looking at.
const CYRILLIC = "\u042b"; // CYRILLIC CAPITAL LETTER YERU - 2 UTF-8 bytes
const CJK = "\u65e5"; // CJK ideograph for "day" - 3 UTF-8 bytes
const EMOJI = "\u{1f600}"; // GRINNING FACE - 4 UTF-8 bytes, 2 UTF-16 code units
const DECOMPOSED = "Caf\u0065\u0301"; // "Cafe" + COMBINING ACUTE ACCENT (NFD)
const COMPOSED = "Caf\u00e9"; // the same name spelled with U+00E9 (NFC)
const REPLACEMENT = "\ufffd"; // U+FFFD, what a byte-sliced truncation leaves behind

describe("RecordNameResolver — NFC (D18)", () => {
  it("writes a decomposed display name in its composed form", () => {
    // Without the fold, a record created on Linux as NFD and re-read on macOS as
    // NFC is two different directory names for one record, and the mirror deletes
    // and recreates it on alternate runs.
    const resolver = new RecordNameResolver();
    const admission = resolver.admit(ID_A, DECOMPOSED);
    expect(admission.name).toBe(COMPOSED);
    expect(admission.name).not.toBe(DECOMPOSED);
    expect(admission.name.normalize("NFC")).toBe(admission.name);
    expect(admission.renames).toEqual([]);
  });

  it("treats the two spellings of one name as a collision", () => {
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, DECOMPOSED);
    const second = resolver.admit(ID_B, COMPOSED);
    expect(second.name).toBe(`${COMPOSED}_${ID_B}`);
    expect(nameOf(resolver, ID_A)).toBe(`${COMPOSED}_${ID_A}`);
    expect(second.renames).toEqual([
      { sysId: ID_A, from: COMPOSED, to: `${COMPOSED}_${ID_A}` },
    ]);
  });
});

describe("RecordNameResolver — the cap is UTF-8 bytes, not code units (D18)", () => {
  it("truncates a two-byte-per-character name at the byte cap", () => {
    // MAX_NAME_BYTES Cyrillic characters are exactly 2x MAX_NAME_BYTES bytes, so
    // a `.length` cap would return the input unchanged and both assertions below
    // would fail.
    const raw = CYRILLIC.repeat(MAX_NAME_BYTES);
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, raw);
    expect(byteLength(raw)).toBe(2 * MAX_NAME_BYTES);
    expect(byteLength(name)).toBe(MAX_NAME_BYTES);
    expect(name.length).toBe(Math.floor(MAX_NAME_BYTES / 2));
    expect(name.length).toBeLessThan(raw.length);
    expect([...name].every((char) => char === CYRILLIC)).toBe(true);
  });

  it("never splits a character whose bytes do not divide the cap", () => {
    // 3 does not divide MAX_NAME_BYTES, so the cut lands mid-character unless the
    // implementation walks code points. A byte-slicing truncation yields U+FFFD.
    const raw = CJK.repeat(MAX_NAME_BYTES);
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, raw);
    const expectedChars = Math.floor(MAX_NAME_BYTES / 3);
    expect(name.length).toBe(expectedChars);
    expect(byteLength(name)).toBe(expectedChars * 3);
    expect(byteLength(name)).toBeLessThan(MAX_NAME_BYTES);
    expect(name).not.toContain(REPLACEMENT);
    expect([...name].every((char) => char === CJK)).toBe(true);
  });

  it("never leaves half a surrogate pair behind", () => {
    // A code-unit truncation of an emoji name ends on a high surrogate, which is
    // not a valid string: it encodes to U+FFFD, so the name on disk stops
    // matching the name in the shard.
    const raw = EMOJI.repeat(MAX_NAME_BYTES);
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, raw);
    expect([...name]).toHaveLength(Math.floor(MAX_NAME_BYTES / 4));
    expect([...name].every((char) => char === EMOJI)).toBe(true);
    const paired = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
    expect(/[\uD800-\uDFFF]/.test(paired)).toBe(false);
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it("keeps a colliding name inside the cap once the suffix is appended", () => {
    // The path a `.length` budget breaks on: reserving 33 CHARACTERS for the
    // suffix leaves 167 Cyrillic characters — 334 bytes — and the name written to
    // disk is 367 bytes, well over what ext4 and APFS accept.
    const raw = CYRILLIC.repeat(MAX_NAME_BYTES);
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, raw);
    resolver.admit(ID_B, raw);
    for (const sysId of [ID_A, ID_B]) {
      const name = nameOf(resolver, sysId);
      expect(name.endsWith(`_${sysId}`)).toBe(true);
      expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect(isSafePathComponent(name)).toBe(true);
    }
  });
});

describe("RecordNameResolver — collisions (D18, F9)", () => {
  it("suffixes both sides of a case-only collision, not just the newcomer", () => {
    // "First writer keeps the plain name" needs no rename and is exactly the
    // order-dependent rule D18 rejects: it makes the tree a function of the
    // Table API's paging order.
    const resolver = new RecordNameResolver();
    const first = resolver.admit(ID_A, "Widget");
    expect(first.name).toBe("Widget");

    const second = resolver.admit(ID_B, "widget");
    expect(second.name).toBe(`widget_${ID_B}`);
    expect(nameOf(resolver, ID_A)).toBe(`Widget_${ID_A}`);
    expect(second.renames).toEqual([
      { sysId: ID_A, from: "Widget", to: `Widget_${ID_A}` },
    ]);
  });

  it("collides names that differ only by a trailing dot or space", () => {
    // Windows drops both when creating a file, so `Report.` and `Report` are one
    // file there. The mirror takes the stronger fold up front rather than
    // discovering it on a Windows checkout.
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, "Report.");
    const second = resolver.admit(ID_B, "Report ");
    const third = resolver.admit(ID_C, "Report");
    expect(nameOf(resolver, ID_A)).toBe(`Report._${ID_A}`);
    expect(second.name).toBe(`Report _${ID_B}`);
    expect(third.name).toBe(`Report_${ID_C}`);
  });

  it("charges the rename to the collision, not to every later arrival", () => {
    // The third record in a group costs nothing: the first two already moved to
    // their suffixed names, so a sweep pays one rename per collision rather than
    // one per record.
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, "dup");
    const second = resolver.admit(ID_B, "dup");
    const third = resolver.admit(ID_C, "dup");
    expect(second.renames).toHaveLength(1);
    expect(third.renames).toEqual([]);
    expect(third.name).toBe(`dup_${ID_C}`);
  });

  it("releases the suffix when a renamed record leaves its fold group", () => {
    // Re-admission is not a corner case: an incremental sweep re-fetches a record
    // whose display name changed. Both groups have to be re-resolved — the old one
    // drops back to a single member and must LOSE its suffix, or the tree keeps a
    // suffix that no longer stands for anything.
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, "shared");
    resolver.admit(ID_B, "shared");

    const moved = resolver.admit(ID_A, "unique");
    expect(moved.name).toBe("unique");
    expect(nameOf(resolver, ID_B)).toBe("shared");
    expect(moved.renames).toEqual([
      { sysId: ID_B, from: `shared_${ID_B}`, to: "shared" },
      { sysId: ID_A, from: `shared_${ID_A}`, to: "unique" },
    ]);
  });

  it("reports nothing when the same record is admitted twice unchanged", () => {
    const resolver = new RecordNameResolver();
    const first = resolver.admit(ID_A, "Widget");
    const again = resolver.admit(ID_A, "Widget");
    expect(again.name).toBe(first.name);
    expect(again.renames).toEqual([]);
    expect(resolver.snapshot().size).toBe(1);
  });
});

describe("RecordNameResolver — unusable display names", () => {
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["a single dot", "."],
    ["a parent traversal", ".."],
    ["dots only", "....."],
    ["a tab", "\t"],
  ])("falls back to the sys_id for %s", (_label, raw) => {
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, raw);
    expect(name).toBe(ID_A);
    expect(isSafePathComponent(name)).toBe(true);
  });

  it("does not make two nameless records collide with each other", () => {
    // They fall back to their own sys_ids, which are distinct by definition, so
    // the suffix machinery must stay out of it.
    const resolver = new RecordNameResolver();
    const first = resolver.admit(ID_A, "");
    const second = resolver.admit(ID_B, "   ");
    expect(first.name).toBe(ID_A);
    expect(second.name).toBe(ID_B);
    expect(second.renames).toEqual([]);
  });

  it("lets a display name carrying a NUL through (known gap, pinned not endorsed)", () => {
    // `isSafePathComponent` is shared with v1's download pipeline and screens
    // empty, dots-only and separator-bearing names, but not C0 controls. Such a
    // name therefore reaches `fs.writeFile`, where Node rejects it with
    // ERR_INVALID_ARG_VALUE — loud, and never a truncated path, but classified as
    // a local I/O failure (F8) instead of as the bad input it is. The source
    // documents this as sn-transport's call to make, so this test pins the
    // current behaviour and goes red the day the predicate is widened, which is
    // when the F-class of the failure changes. Escape, never a literal byte.
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, "bad\u0000name");
    expect(name).toBe("bad\u0000name");
    expect(name).not.toBe(ID_A);
    expect(isSafePathComponent(name)).toBe(true);
  });

  it("replaces path separators instead of rejecting the name", () => {
    const resolver = new RecordNameResolver();
    const { name } = resolver.admit(ID_A, "incident/close");
    expect(name).not.toMatch(/[/\\]/);
    expect(name).toHaveLength("incident/close".length);
    expect(isSafePathComponent(name)).toBe(true);
  });

  it("folds both separator directions to the same component, so they collide", () => {
    // If `/` and `\` mapped to different replacements, these two records would
    // get distinct names and the second admission would report no rename — which
    // is what this test would catch.
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, "a/b");
    const second = resolver.admit(ID_B, "a\\b");
    expect(second.renames).toHaveLength(1);
    expect(second.name.endsWith(`_${ID_B}`)).toBe(true);
    expect(nameOf(resolver, ID_A).endsWith(`_${ID_A}`)).toBe(true);
  });
});

describe("RecordNameResolver — INV-6", () => {
  it.each([
    ["empty", ""],
    ["31 digits", "0".repeat(31)],
    ["33 digits", "0".repeat(33)],
    ["uppercase hex", "A".repeat(32)],
    ["a non-hex letter", `${"0".repeat(31)}z`],
    ["a traversal", "../../../etc/passwd"],
    // Escape, never a literal byte — see the note at the top of this file.
    ["an embedded NUL at the right length", `${"0".repeat(31)}\u0000`],
  ])("refuses to admit a record whose sys_id is %s", (_label, sysId) => {
    // The gate has to come first: `buildSafeRecordName` falls back to the sys_id
    // when the display name folds away, so an unvalidated sys_id would become a
    // directory name one line later.
    const resolver = new RecordNameResolver();
    expect(() => resolver.admit(sysId, "Widget")).toThrow(MirrorPathRejection);
    expect(resolver.nameOf(sysId)).toBeUndefined();
    expect(resolver.snapshot().size).toBe(0);
  });

  it("refuses to seed a baseline entry whose sys_id is not a sys_id", () => {
    const resolver = new RecordNameResolver();
    expect(() => resolver.seed("not-a-sys-id", "Widget")).toThrow(MirrorPathRejection);
    expect(resolver.snapshot().size).toBe(0);
  });

  it("rejects a non-string sys_id", () => {
    const resolver = new RecordNameResolver();
    expect(() => resolver.admit(undefined as unknown as string, "Widget")).toThrow(
      MirrorPathRejection
    );
  });
});

describe("RecordNameResolver.seed — the incremental baseline", () => {
  it("stops a newcomer from being written into an un-refetched record's directory", () => {
    // The collision this exists for: A is called `Widget` and is not re-fetched
    // this sweep; B is renamed to `widget` inside the same window. Without the
    // seed, B is the only member of the fold group, takes the plain name, and is
    // written straight into A's directory.
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, "Widget");
    const admitted = resolver.admit(ID_B, "widget");
    expect(admitted.name).toBe(`widget_${ID_B}`);
    expect(admitted.renames).toEqual([
      { sysId: ID_A, from: "Widget", to: `Widget_${ID_A}` },
    ]);
  });

  it("recovers the base name from a stored suffix, so no spurious rename is reported", () => {
    // A seeded name is the FINAL on-disk name and may already carry the suffix.
    // Treating it as a base would key the group on `widget_<sysId>`, miss the
    // collision, and then report a rename for a directory that is already right.
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, `Widget_${ID_A}`);
    const admitted = resolver.admit(ID_B, "widget");
    expect(admitted.name).toBe(`widget_${ID_B}`);
    expect(admitted.renames).toEqual([]);
    expect(nameOf(resolver, ID_A)).toBe(`Widget_${ID_A}`);
  });

  it("keeps a name that is nothing but a suffix usable", () => {
    // Stripping would leave "", which is not a path component. The stored name is
    // one, so it is kept.
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, `_${ID_A}`);
    expect(nameOf(resolver, ID_A)).toBe(`_${ID_A}`);
    const readmitted = resolver.admit(ID_A, `_${ID_A}`);
    expect(readmitted.name).toBe(`_${ID_A}`);
    expect(readmitted.renames).toEqual([]);
  });

  it("reports no rename when a seeded record comes back unchanged", () => {
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, "Widget");
    const admitted = resolver.admit(ID_A, "Widget");
    expect(admitted.name).toBe("Widget");
    expect(admitted.renames).toEqual([]);
  });

  it("reports a self-rename when a seeded record comes back renamed", () => {
    // The writer has to MOVE the directory; writing the new name and leaving the
    // old one behind is an orphan the reconciler would then delete and re-fetch.
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, "Widget");
    const admitted = resolver.admit(ID_A, "Gadget");
    expect(admitted.name).toBe("Gadget");
    expect(nameOf(resolver, ID_A)).toBe("Gadget");
  });

  it("returns undefined for a record it has never seen", () => {
    expect(new RecordNameResolver().nameOf(ID_A)).toBeUndefined();
  });

  it("hands out a snapshot the caller cannot use to mutate the resolver", () => {
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, "Widget");
    const snapshot = resolver.snapshot();
    snapshot.set(ID_A, "tampered");
    expect(nameOf(resolver, ID_A)).toBe("Widget");
  });
});

// ---------------------------------------------------------------------------
// The one name a record may not have
// ---------------------------------------------------------------------------

/**
 * `.shards` is a legal ServiceNow display name that survives the entire naming
 * pipeline untouched, and `recordDirRelPath` would then derive exactly the string
 * `shardDirRelPath` derives — the record lands inside the table's shard index, and
 * `applyAuthorizedDeletion`, re-deriving the same path, deletes the index for the
 * whole table. `shardLayout` refuses the derivation outright; the resolver is what
 * makes sure the writer never asks for it, by handing such a record the `_<sysId>`
 * suffix D18 already uses for collisions.
 */
describe("RecordNameResolver — the reserved shard directory name", () => {
  it("renames a record literally called .shards", () => {
    const resolver = new RecordNameResolver();
    expect(resolver.admit(ID_A, SHARD_DIR_NAME).name).toBe(
      `${SHARD_DIR_NAME}_${ID_A}`
    );
  });

  it("catches the fold variants too, not just the exact string", () => {
    // The fold lowercases and strips trailing dots and spaces, so all of these
    // reach `recordDirRelPath` as a directory that collides with the shard set on a
    // case-insensitive filesystem or after Windows drops the trailing characters.
    for (const raw of [".SHARDS", ".Shards", ".shards ", ".shards.", ".shards   "]) {
      const resolver = new RecordNameResolver();
      expect(resolver.admit(ID_A, raw).name).toBe(`${SHARD_DIR_NAME}_${ID_A}`);
    }
  });

  it("keeps the renamed result inside the byte cap whatever the input length", () => {
    // Why the replacement is the constant `.shards_<sysId>` and not
    // `<candidate>_<sysId>`: a name of `.shards` followed by 190 spaces folds to the
    // reserved key too, and appending 33 bytes to THAT would breach the cap.
    const resolver = new RecordNameResolver();
    const name = resolver.admit(ID_A, `${SHARD_DIR_NAME}${" ".repeat(190)}`).name;
    expect(name).toBe(`${SHARD_DIR_NAME}_${ID_A}`);
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it("gives two records that both want the name two distinct names", () => {
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, SHARD_DIR_NAME);
    resolver.admit(ID_B, ".SHARDS ");
    expect(nameOf(resolver, ID_A)).toBe(`${SHARD_DIR_NAME}_${ID_A}`);
    expect(nameOf(resolver, ID_B)).toBe(`${SHARD_DIR_NAME}_${ID_B}`);
  });

  it("still separates a record that is literally called .shards_<the other's sysId>", () => {
    // The pathological case the reservation must not create: renaming before
    // grouping puts both candidates under the same fold key, where the ordinary
    // collision machinery suffixes them again. Renaming AFTER grouping would have
    // produced two identical directories.
    const resolver = new RecordNameResolver();
    resolver.admit(ID_A, SHARD_DIR_NAME);
    resolver.admit(ID_B, `${SHARD_DIR_NAME}_${ID_A}`);
    const a = nameOf(resolver, ID_A);
    const b = nameOf(resolver, ID_B);
    expect(a).not.toBe(b);
    expect([a, b].every((name) => isSafePathComponent(name))).toBe(true);
  });

  it("leaves a name that merely starts with the reserved one alone", () => {
    const resolver = new RecordNameResolver();
    expect(resolver.admit(ID_A, ".shards-config").name).toBe(".shards-config");
  });

  it("seeds a baseline entry under the same fold key admission produces", () => {
    // Without the reservation in `seed`, the seeded copy is filed under the
    // reserved key while the admission files the same record under the suffixed
    // one, and the seeded entry lingers in a group it can never be resolved out of.
    const resolver = new RecordNameResolver();
    resolver.seed(ID_A, `${SHARD_DIR_NAME}_${ID_A}`);
    expect(resolver.admit(ID_A, SHARD_DIR_NAME)).toEqual({
      name: `${SHARD_DIR_NAME}_${ID_A}`,
      renames: [],
    });
  });

  it("never returns a name recordDirRelPath refuses", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const resolver = new RecordNameResolver();
        const { name } = resolver.admit(ID_A, raw);
        expect(() =>
          recordDirRelPath({
            scope: "global",
            table: "sys_script",
            sysId: ID_A,
            name,
          })
        ).not.toThrow();
      })
    );
  });
});

// ---------------------------------------------------------------------------
// The property INV-1 rests on
// ---------------------------------------------------------------------------

/**
 * Raw display names chosen so the pool collides in every way D18 cares about:
 * case, normalization form, trailing dot/space, separator folding, byte-cap
 * truncation (the two over-cap Cyrillic names truncate to the SAME prefix), and
 * names that fold away entirely and fall back to the sys_id.
 */
const NAME_POOL = [
  "Widget",
  "widget",
  "WIDGET",
  COMPOSED,
  DECOMPOSED,
  "Report",
  "Report.",
  "Report ",
  "a/b",
  "a\\b",
  "",
  "   ",
  "...",
  CYRILLIC.repeat(150),
  CYRILLIC.repeat(160),
  CJK.repeat(80),
  `${EMOJI}x`,
  "unique-1",
  "unique-2",
];

const SYS_IDS = ["a", "b", "c", "d", "e", "f", "0", "1", "2", "3", "4", "5"].map(id);

interface RawRecord {
  sysId: string;
  rawName: string;
}

const recordsArb: fc.Arbitrary<RawRecord[]> = fc
  .uniqueArray(
    fc.tuple(fc.constantFrom(...SYS_IDS), fc.constantFrom(...NAME_POOL)),
    { minLength: 1, maxLength: SYS_IDS.length, selector: ([sysId]) => sysId }
  )
  .map((pairs) => pairs.map(([sysId, rawName]) => ({ sysId, rawName })));

const admitAll = (records: readonly RawRecord[]): Map<string, string> => {
  const resolver = new RecordNameResolver();
  for (const record of records) {
    resolver.admit(record.sysId, record.rawName);
  }
  return resolver.snapshot();
};

const sortedEntries = (names: Map<string, string>): Array<[string, string]> =>
  [...names.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

describe("order independence (INV-1)", () => {
  it("assigns the same names whatever order the records arrive in", () => {
    // THE test in this file. The resolver is fed one record at a time as the
    // sweep pages through a table, and the Table API's paging order is not a
    // stable input. A resolver whose output depended on it would make an
    // unchanged instance re-run to a DIFFERENT tree — INV-1 gone, and every
    // mirror commit a diff of renames nobody asked for.
    fc.assert(
      fc.property(
        recordsArb.chain((records) =>
          fc.tuple(
            fc.constant(records),
            fc.shuffledSubarray(records, {
              minLength: records.length,
              maxLength: records.length,
            })
          )
        ),
        ([records, shuffled]) => {
          expect(sortedEntries(admitAll(shuffled))).toEqual(
            sortedEntries(admitAll(records))
          );
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("agrees with resolveUniqueNames over the whole directory at once", () => {
    // The equivalence the module's design argument rests on: collision groups are
    // independent, so resolving one growing group record by record must land on
    // the same answer as resolving every candidate together. The batch function
    // is the independent expectation — it is what a non-streaming writer would
    // have produced.
    fc.assert(
      fc.property(recordsArb, (records) => {
        const candidates: NameCandidate[] = records.map((record) => ({
          sysId: record.sysId,
          name: buildSafeRecordName(record.rawName, record.sysId),
        }));
        const batch = resolveUniqueNames(candidates);
        expect(batch.unusable).toEqual([]);
        expect(sortedEntries(admitAll(records))).toEqual(sortedEntries(batch.names));
      }),
      { numRuns: 1000 }
    );
  });

  it("keeps every assigned name usable, unique and inside the byte cap", () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const names = admitAll(records);
        expect(names.size).toBe(records.length);
        for (const name of names.values()) {
          expect(isSafePathComponent(name)).toBe(true);
          expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
        }
        // Uniqueness is under the FOLD, not under equality: two names that differ
        // only in case are one file on APFS and NTFS, so a resolver that made
        // them distinct-but-folding-equal would still lose a record.
        const folded = [...names.values()].map((name) => canonicalFoldName(name));
        expect(new Set(folded).size).toBe(folded.length);
      }),
      { numRuns: 1000 }
    );
  });

  it("never produces an empty or unsafe name, for any display name at all", () => {
    // The theorem `NameAdmission.name` states in prose: because INV-6 has already
    // established that the sys_id is 32 hex digits, the fallback in
    // `buildSafeRecordName` can never return "". If sn-transport ever tightens
    // `isSafePathComponent` and breaks it, this goes red instead of the resolver
    // starting to throw its internal-error guard in production.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.constantFrom(...NAME_POOL),
          fc.constantFrom(
            "\u200bzero-width",
            REPLACEMENT,
            "  .  ",
            "\u3033",
            "con",
            "NUL",
            ".shards"
          )
        ),
        fc.constantFrom(...SYS_IDS),
        (rawName, sysId) => {
          const resolver = new RecordNameResolver();
          const { name } = resolver.admit(sysId, rawName);
          expect(name).not.toBe("");
          expect(isSafePathComponent(name)).toBe(true);
          expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
          expect(buildSafeRecordName(rawName, sysId)).not.toBe("");
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("is order-independent across seeded and freshly admitted records alike", () => {
    // An incremental sweep mixes both: the baseline is seeded in shard-file order
    // and the fetched records arrive in paging order. The final assignment must
    // still be a function of the SET.
    fc.assert(
      fc.property(
        recordsArb.filter((records) => records.length >= 2),
        fc.nat({ max: 5 }),
        (records, rawSplit) => {
          const split = Math.min(rawSplit, records.length - 1);
          const seeded = records.slice(0, split);
          const admitted = records.slice(split);

          const build = (order: readonly RawRecord[]): Map<string, string> => {
            const resolver = new RecordNameResolver();
            for (const record of seeded) {
              resolver.seed(record.sysId, buildSafeRecordName(record.rawName, record.sysId));
            }
            for (const record of order) {
              resolver.admit(record.sysId, record.rawName);
            }
            return resolver.snapshot();
          };

          expect(sortedEntries(build([...admitted].reverse()))).toEqual(
            sortedEntries(build(admitted))
          );
        }
      ),
      { numRuns: 500 }
    );
  });
});
