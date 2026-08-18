// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for `src/shards/shardLayout.ts` — INV-6, D15 and D16 (WP-M7).
 *
 * Three things are being defended here, and each test says which one it belongs
 * to so a future reader can tell a rule from an incidental detail:
 *
 *  - **INV-6** — nothing becomes part of a path before it has been through
 *    `/^[0-9a-f]{32}$/`. The interesting cases are the ones where a naive
 *    implementation would skip the check because the value is not *used*: fan-out
 *    0 slices zero characters off the sys_id, and `recordDirRelPath` never puts
 *    the sys_id in its result at all.
 *  - **D16** — hex-prefix fan-out, sticky per table. "Sticky" is only meaningful
 *    as a negative: the record count must NOT be able to move a level that
 *    already exists.
 *  - **D15** — no monolithic manifest, and shard entries pretty-printed one field
 *    per line so git can line-merge two people's edits. That is a claim about
 *    BYTES, so the golden below asserts bytes.
 *
 * A note on what is deliberately not asserted: nowhere does a test restate a
 * constant the source declares and compare it to itself. Where a literal appears
 * (`instance/global/sys_script/.shards`, `all.json`) it is the on-disk contract —
 * the thing a human reads out of a checked-out repo — and changing it is supposed
 * to break a test.
 */
import fc from "fast-check";

import { isSafePathComponent } from "@syncrona/sn-transport";

import {
  FORMAT_VERSION,
  SHARD_FANOUT_THRESHOLD_1,
  SHARD_FANOUT_THRESHOLD_2,
} from "../src/constants";
import type { RecordEntry } from "../src/contracts";
import {
  INSTANCE_DIR_NAME,
  MirrorPathRejection,
  RECORD_FILE_NAME,
  SHARD_DIR_NAME,
  SHARD_FILE_SUFFIX,
  SINGLE_SHARD_FILE,
  ShardManifestCorrupt,
  assertMirrorPathComponent,
  assertMirrorSysId,
  buildShardManifest,
  chooseShardFanout,
  enumerateShardKeys,
  isContainedRepoPath,
  isMirrorSysId,
  parseShardManifest,
  recordDirRelPath,
  renderShardManifest,
  repoPath,
  shardDirRelPath,
  shardFileName,
  shardFileNamesFor,
  shardKeyFor,
  stickyFanout,
  type ShardFanout,
} from "../src/shards/shardLayout";

const ALL_FANOUTS: ShardFanout[] = [0, 1, 2];

/** Two sys_ids that share the prefix "0", so both live in shard "0"/"0a"… "0b". */
const ID_A = `0${"a".repeat(31)}`;
const ID_B = `0${"b".repeat(31)}`;
const ID_C = `0${"c".repeat(31)}`;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const HEX_DIGITS = "0123456789abcdef";
/**
 * A 32-character lowercase hex string.
 *
 * Built from `constantFrom` rather than `fc.hexaString`, whose default length and
 * alphabet have changed between fast-check majors; a generator that silently
 * started producing 10-character strings would make every INV-6 property below
 * pass vacuously.
 */
const sysIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX_DIGITS.split("")), { minLength: 32, maxLength: 32 })
  .map((chars) => chars.join(""));

const fanoutArb: fc.Arbitrary<ShardFanout> = fc.constantFrom(...ALL_FANOUTS);

const entry = (name: string, over: Partial<RecordEntry> = {}): RecordEntry => ({
  path: repoPath(INSTANCE_DIR_NAME, "global", "sys_script", name),
  name,
  sysUpdatedOn: "2026-01-01 00:00:00",
  sysUpdatedBy: "admin",
  sysModCount: 3,
  contentHash: "sha256:aaa",
  files: [RECORD_FILE_NAME],
  ...over,
});

// ---------------------------------------------------------------------------
// INV-6 — the sys_id gate
// ---------------------------------------------------------------------------

describe("isMirrorSysId / assertMirrorSysId (INV-6)", () => {
  it("accepts every 32-digit lowercase hex string", () => {
    fc.assert(
      fc.property(sysIdArb, (sysId) => {
        expect(isMirrorSysId(sysId)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it.each([
    ["empty", ""],
    ["31 digits", "0".repeat(31)],
    ["33 digits", "0".repeat(33)],
    ["uppercase hex", "A".repeat(32)],
    ["non-hex letter", `${"0".repeat(31)}g`],
    ["leading space", ` ${"0".repeat(31)}`],
    ["trailing newline", `${"0".repeat(32)}\n`],
    ["traversal, padded to 32", "../".repeat(10).slice(0, 32)],
    // Written as an escape, never as a literal byte: a raw NUL turns this file
    // into `data` for grep and the repository source-text gate rejects it.
    ["embedded NUL at the right length", `${"0".repeat(31)}\u0000`],
  ])("rejects %s", (_label, value) => {
    expect(isMirrorSysId(value)).toBe(false);
    expect(() => {
      assertMirrorSysId(value);
    }).toThrow(MirrorPathRejection);
  });

  it.each<[string, unknown]>([
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["array of the right length", Array.from({ length: 32 }, () => "0")],
    ["boxed string", Object("0".repeat(32))],
  ])("rejects a non-string %s", (_label, value) => {
    expect(isMirrorSysId(value)).toBe(false);
  });

  it("gives the same answer on repeated calls with the same value", () => {
    // `SYS_ID_RE` is shared across packages. Were it ever given a /g or /y flag,
    // `test` would carry `lastIndex` between calls and this validator would pass
    // every other invocation — a defect that is invisible to any single-call test.
    const sysId = "0".repeat(32);
    expect([isMirrorSysId(sysId), isMirrorSysId(sysId), isMirrorSysId(sysId)]).toEqual([
      true,
      true,
      true,
    ]);
    const bad = "z".repeat(32);
    expect([isMirrorSysId(bad), isMirrorSysId(bad), isMirrorSysId(bad)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("names the field in the rejection so a caller can tell which id failed", () => {
    expect(() => {
      assertMirrorSysId("nope");
    }).toThrow(/sys_id/);
    expect(() => {
      assertMirrorSysId("nope", "record key");
    }).toThrow(/record key/);
    try {
      assertMirrorSysId("nope", "record key");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MirrorPathRejection);
      expect((error as MirrorPathRejection).what).toBe("record key");
    }
  });

  it("narrows to string, so a validated sys_id needs no cast", () => {
    const value: unknown = "0".repeat(32);
    assertMirrorSysId(value);
    // Compiles only because the assertion signature narrowed `unknown`; if the
    // declaration ever degrades to `boolean`, this file stops type-checking.
    expect(value.slice(0, 2)).toBe("00");
  });
});

describe("MirrorPathRejection message hygiene", () => {
  it("escapes a hostile value instead of letting it write the message", () => {
    // The rejected values come from an instance (or from someone with write
    // access to one). Interpolated raw, a newline plus an ANSI clear would push
    // the real error off a CI log — log forging through an error message.
    const hostile = "abc\ndef\u001b[2Jghi";
    const error = new MirrorPathRejection("record name", hostile);
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\u001b");
    expect(error.sample).toContain("\\n");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MirrorPathRejection");
  });

  it("bounds the sample so padding cannot bury the rest of the message", () => {
    const atCap = new MirrorPathRejection("scope", "a".repeat(60));
    expect(atCap.sample.endsWith("\u2026")).toBe(false);
    const overCap = new MirrorPathRejection("scope", "a".repeat(4096));
    expect(overCap.sample.endsWith("\u2026")).toBe(true);
    expect(overCap.message.length).toBeLessThan(200);
  });

  it("reports a non-string by type rather than by value", () => {
    expect(new MirrorPathRejection("sys_id", 42).sample).toBe("number");
    expect(new MirrorPathRejection("sys_id", undefined).sample).toBe("undefined");
    expect(new MirrorPathRejection("sys_id", { a: 1 }).sample).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// D16 — fan-out choice and stickiness
// ---------------------------------------------------------------------------

describe("chooseShardFanout (D16 thresholds)", () => {
  it("treats the thresholds as strictly-greater boundaries", () => {
    expect(chooseShardFanout(0)).toBe(0);
    expect(chooseShardFanout(SHARD_FANOUT_THRESHOLD_1)).toBe(0);
    expect(chooseShardFanout(SHARD_FANOUT_THRESHOLD_1 + 1)).toBe(1);
    expect(chooseShardFanout(SHARD_FANOUT_THRESHOLD_2)).toBe(1);
    expect(chooseShardFanout(SHARD_FANOUT_THRESHOLD_2 + 1)).toBe(2);
  });

  it("never decreases as the record count grows", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.nat({ max: 100 }),
          fc.integer({ min: SHARD_FANOUT_THRESHOLD_1 - 5, max: SHARD_FANOUT_THRESHOLD_1 + 5 }),
          fc.integer({ min: SHARD_FANOUT_THRESHOLD_2 - 5, max: SHARD_FANOUT_THRESHOLD_2 + 5 }),
          fc.nat({ max: 2_000_000 })
        ),
        fc.nat({ max: 2_000_000 }),
        (a, b) => {
          const low = Math.min(a, b);
          const high = Math.max(a, b);
          expect(chooseShardFanout(high)).toBeGreaterThanOrEqual(chooseShardFanout(low));
        }
      ),
      { numRuns: 500 }
    );
  });

  it("keeps the mean shard at or under the first threshold up to 16x the second", () => {
    // The independent expectation D16 exists to deliver: whatever the count, the
    // number of records the average shard file has to hold stays under the size
    // at which a single shard was judged unmergeable. Derived from the thresholds
    // and the fan-out cardinality, not copied from the implementation's `if`s —
    // a swapped comparison or a threshold typo breaks it.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 16 * SHARD_FANOUT_THRESHOLD_2 }), (count) => {
        const shards = enumerateShardKeys(chooseShardFanout(count)).length;
        expect(count / shards).toBeLessThanOrEqual(SHARD_FANOUT_THRESHOLD_1);
      }),
      { numRuns: 500 }
    );
  });

  it("caps at fan-out 2, where a large enough table exceeds that bound by design", () => {
    // The honest other side of the property above: D16 has three levels and no
    // more, so past 16 x THRESHOLD_2 records the mean shard does grow past
    // THRESHOLD_1. Pinned so the ceiling is a known consequence rather than a
    // surprise found in production.
    const count = 16 * SHARD_FANOUT_THRESHOLD_2 + 16;
    expect(chooseShardFanout(count)).toBe(2);
    expect(count / enumerateShardKeys(2).length).toBeGreaterThan(SHARD_FANOUT_THRESHOLD_1);
  });

  it.each<[string, number]>([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects a %s record count", (_label, count) => {
    // A count arrives from the Aggregate API, which reports it as a STRING; a
    // failed conversion produces NaN, and `NaN > threshold` is false, so an
    // unguarded implementation would quietly pick fan-out 0 for a table of
    // unknown size and put every record in one file.
    expect(() => chooseShardFanout(count)).toThrow(MirrorPathRejection);
  });
});

describe("stickyFanout (D16 stickiness)", () => {
  it("ignores the record count entirely when a shard set already exists", () => {
    fc.assert(
      fc.property(fanoutArb, fc.nat({ max: 5_000_000 }), (existing, count) => {
        expect(stickyFanout(existing, count)).toBe(existing);
      }),
      { numRuns: 300 }
    );
  });

  it("does not collapse a fanned-out table back when its count dips", () => {
    // The failure this rule prevents: a table oscillating around a threshold
    // would re-choose its layout every sync and rewrite every shard path twice a
    // day, which is an INV-1 violation with no visible cause.
    expect(stickyFanout(2, 3)).toBe(2);
    expect(shardFileNamesFor(stickyFanout(2, 3))).toHaveLength(256);
    expect(stickyFanout(1, SHARD_FANOUT_THRESHOLD_2 + 1)).toBe(1);
    expect(stickyFanout(0, 900_000)).toBe(0);
  });

  it("falls back to the threshold rule only for a shard set that does not exist yet", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2_000_000 }), (count) => {
        expect(stickyFanout(null, count)).toBe(chooseShardFanout(count));
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Shard keys: derivation and enumeration must agree
// ---------------------------------------------------------------------------

describe("shardKeyFor / enumerateShardKeys", () => {
  it.each(ALL_FANOUTS)("enumerates exactly 16^%s keys, ascending and distinct", (fanout) => {
    const keys = enumerateShardKeys(fanout);
    expect(keys).toHaveLength(16 ** fanout);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
    const shape = new RegExp(`^[0-9a-f]{${fanout}}$`);
    expect(keys.every((key) => shape.test(key))).toBe(true);
  });

  it.each(ALL_FANOUTS)(
    "lists every key a sys_id can produce at fan-out %s",
    (fanout) => {
      // The agreement that makes a sweep complete: the store deletes shard files
      // the enumeration does not claim, so a key `shardKeyFor` can emit but
      // `enumerateShardKeys` omits is a shard written and then deleted, losing
      // every record in it.
      const listed = new Set(enumerateShardKeys(fanout));
      fc.assert(
        fc.property(sysIdArb, (sysId) => {
          expect(listed.has(shardKeyFor(sysId, fanout))).toBe(true);
        }),
        { numRuns: 400 }
      );
    }
  );

  it.each(ALL_FANOUTS)("lists no key at fan-out %s that no sys_id can reach", (fanout) => {
    // The converse direction. An enumerated key with no possible member would
    // make the store write (and commit) an empty shard file forever.
    for (const key of enumerateShardKeys(fanout)) {
      const witness = key.padEnd(32, "0");
      expect(isMirrorSysId(witness)).toBe(true);
      expect(shardKeyFor(witness, fanout)).toBe(key);
    }
  });

  it.each(ALL_FANOUTS)("asserts INV-6 before slicing, even at fan-out %s", (fanout) => {
    // Fan-out 0 slices zero characters, so an implementation that validated
    // "only when it matters" would return "" for `../../etc/passwd` and hand the
    // caller a sys_id it never checked — which is then used as the shard's
    // record key and as the record-name fallback.
    expect(() => shardKeyFor("../../etc/passwd", fanout)).toThrow(MirrorPathRejection);
    expect(() => shardKeyFor(`${"0".repeat(31)}G`, fanout)).toThrow(MirrorPathRejection);
    expect(() => shardKeyFor(undefined, fanout)).toThrow(MirrorPathRejection);
  });
});

describe("shardFileName / shardFileNamesFor", () => {
  it("names the single shard so that no fanned-out level can produce the name", () => {
    // `mirror migrate` deletes the files the NEW level does not claim; if
    // `all.json` were also a fan-out-1 name, migrating would delete the file it
    // had just written.
    expect(shardFileName("", 0)).toBe(SINGLE_SHARD_FILE);
    expect(shardFileName("a", 1)).toBe("a.json");
    expect(shardFileName("ab", 2)).toBe("ab.json");
    const everyLevel = [
      ...shardFileNamesFor(0),
      ...shardFileNamesFor(1),
      ...shardFileNamesFor(2),
    ];
    expect(everyLevel).toHaveLength(1 + 16 + 256);
    expect(new Set(everyLevel).size).toBe(everyLevel.length);
    expect(everyLevel.every((name) => name.endsWith(SHARD_FILE_SUFFIX))).toBe(true);
    expect(everyLevel.every((name) => isSafePathComponent(name))).toBe(true);
  });

  it.each<[string, string, ShardFanout]>([
    ["a key too long for the fan-out", "a", 0],
    ["an empty key at fan-out 1", "", 1],
    ["a fan-out-2 key at fan-out 1", "ab", 1],
    ["a fan-out-1 key at fan-out 2", "a", 2],
    ["uppercase hex", "A", 1],
    ["a non-hex letter", "g", 1],
    ["a half-hex pair", "0g", 2],
    // Right length for fan-out 2, so a length-only check would accept it and
    // emit "...json" — a shard file one directory up.
    ["a traversal of the right length", "..", 2],
    ["a separator of the right length", "/x", 2],
  ])("rejects %s", (_label, key, fanout) => {
    expect(() => shardFileName(key, fanout)).toThrow(MirrorPathRejection);
  });
});

// ---------------------------------------------------------------------------
// Path derivation and containment
// ---------------------------------------------------------------------------

describe("repoPath / shardDirRelPath / recordDirRelPath", () => {
  it("joins with a forward slash on every platform", () => {
    // `path.join` would emit backslashes on Windows, and `RecordEntry.path` is
    // committed: a mirror written on Windows would differ byte-for-byte from the
    // same mirror written on Linux (INV-1) with nothing in the diff to explain it.
    expect(repoPath("a", "b", "c")).toBe("a/b/c");
    expect(repoPath("a", "b")).not.toContain("\\");
    expect(repoPath()).toBe("");
  });

  it("derives the documented on-disk layout", () => {
    expect(shardDirRelPath("global", "sys_script")).toBe(
      "instance/global/sys_script/.shards"
    );
    expect(
      recordDirRelPath({
        scope: "global",
        table: "sys_script",
        sysId: ID_A,
        name: "Business Rule",
      })
    ).toBe("instance/global/sys_script/Business Rule");
    expect(SHARD_DIR_NAME).toBe(".shards");
    expect(INSTANCE_DIR_NAME).toBe("instance");
  });

  it("produces a contained, four-segment path for any safe components", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("global", "x_acme_app", "sys"),
        fc.constantFrom("sys_script", "incident", "sys_ui_policy"),
        fc.constantFrom("Alpha", "a b c", "Caf\u00e9", "-", "..leading"),
        sysIdArb,
        (scope, table, name, sysId) => {
          const relPath = recordDirRelPath({ scope, table, sysId, name });
          expect(isContainedRepoPath(relPath)).toBe(true);
          expect(relPath.split("/")).toHaveLength(4);
          expect(relPath.startsWith(`${INSTANCE_DIR_NAME}/`)).toBe(true);
          expect(isContainedRepoPath(repoPath(relPath, RECORD_FILE_NAME))).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it.each([
    ["parent traversal", ".."],
    ["current directory", "."],
    ["dots only", "..."],
    ["empty", ""],
    ["a forward slash", "a/b"],
    ["a backslash", "a\\b"],
    ["an absolute path", "/etc"],
    ["a bare separator", "/"],
  ])("rejects %s as a path component", (_label, component) => {
    expect(() => assertMirrorPathComponent(component, "record name")).toThrow(
      MirrorPathRejection
    );
    expect(() =>
      recordDirRelPath({ scope: "global", table: "sys_script", sysId: ID_A, name: component })
    ).toThrow(MirrorPathRejection);
    expect(() => shardDirRelPath(component, "sys_script")).toThrow(MirrorPathRejection);
    expect(() => shardDirRelPath("global", component)).toThrow(MirrorPathRejection);
  });

  it("rejects a non-string component", () => {
    expect(() => assertMirrorPathComponent(null, "table name")).toThrow(MirrorPathRejection);
    expect(() => assertMirrorPathComponent(7, "table name")).toThrow(MirrorPathRejection);
  });

  it("names the offending component a scope, not a table, when a scope is what failed", () => {
    // The message is the whole product of a rejection — nothing recovers from one,
    // it just has to say where to look. `instance/<scope>/<table>/` has two string
    // components, and reporting the first as the second sends the reader to the
    // wrong half of their configuration. Asserted on both derivation sites because
    // they take the scope in different positions and each was wrong separately.
    expect(() => shardDirRelPath("bad/scope", "sys_script")).toThrow(/scope name/);
    expect(() =>
      recordDirRelPath({
        scope: "bad/scope",
        table: "sys_script",
        sysId: ID_A,
        name: "Alpha",
      })
    ).toThrow(/scope name/);
    // And the table still reports as a table — the fix must not have swapped the
    // labels rather than added one.
    expect(() => shardDirRelPath("global", "bad/table")).toThrow(/table name/);
  });

  it("validates the sys_id even though it never appears in the result", () => {
    // The sys_id is the shard key this path will be filed under, and the
    // fallback the record NAME uses when the display name folds away. Letting an
    // unvalidated one through here just moves the failure one frame later.
    expect(() =>
      recordDirRelPath({
        scope: "global",
        table: "sys_script",
        sysId: "not-a-sys-id",
        name: "Alpha",
      })
    ).toThrow(MirrorPathRejection);
  });
});

describe("isContainedRepoPath", () => {
  it.each([
    "instance/global/sys_script/Alpha",
    "instance/global/sys_script/.shards/all.json",
    "a",
    "a/b",
    ".mirror/state/checkpoint.json",
  ])("accepts %s", (value) => {
    expect(isContainedRepoPath(value)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["bare root", "/"],
    ["parent traversal", "../a"],
    ["embedded traversal", "a/../../b"],
    ["trailing traversal", "instance/global/.."],
    ["single dot segment", "a/./b"],
    ["double separator", "a//b"],
    ["trailing separator", "a/"],
    ["backslash traversal", "..\\a"],
    ["windows separator", "a\\b"],
    ["windows drive, forward slash", "C:/Windows"],
    ["windows drive, backslash", "c:\\Windows"],
  ])("rejects %s", (_label, value) => {
    expect(isContainedRepoPath(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D15 — the bytes of a shard file
// ---------------------------------------------------------------------------

describe("renderShardManifest (D15 bytes)", () => {
  const goldenManifest = buildShardManifest({
    table: "sys_script",
    shardKey: "0",
    fanout: 1,
    complete: true,
    sweepId: "sweep-1",
    records: {
      [ID_A]: {
        path: "instance/global/sys_script/Alpha",
        name: "Alpha",
        sysUpdatedOn: "2026-01-01 00:00:00",
        sysUpdatedBy: "admin",
        sysModCount: 3,
        contentHash: "sha256:aaa",
        files: ["record.json", "script.js"],
      },
      [ID_B]: {
        path: "instance/global/sys_script/Beta",
        name: "Beta",
        sysUpdatedOn: "2026-01-02 00:00:00",
        sysUpdatedBy: "system",
        sysModCount: 0,
        contentHash: "sha256:bbb",
        files: ["record.json"],
      },
    },
  });

  /**
   * The exact file a checkout contains, written out by hand from §8's rules
   * (keys sorted by UTF-16 code unit at every level, two-space indent, LF, one
   * trailing newline) rather than captured from a run. Every scalar sits on its
   * own line — that IS D15: a minified shard would put two developers' edits on
   * the same line and turn a mergeable change into a conflict on a file neither
   * of them can read.
   */
  const GOLDEN = [
    "{",
    '  "complete": true,',
    '  "fanout": 1,',
    '  "formatVersion": 1,',
    '  "records": {',
    '    "0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {',
    '      "contentHash": "sha256:aaa",',
    '      "files": [',
    '        "record.json",',
    '        "script.js"',
    "      ],",
    '      "name": "Alpha",',
    '      "path": "instance/global/sys_script/Alpha",',
    '      "sysModCount": 3,',
    '      "sysUpdatedBy": "admin",',
    '      "sysUpdatedOn": "2026-01-01 00:00:00"',
    "    },",
    '    "0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {',
    '      "contentHash": "sha256:bbb",',
    '      "files": [',
    '        "record.json"',
    "      ],",
    '      "name": "Beta",',
    '      "path": "instance/global/sys_script/Beta",',
    '      "sysModCount": 0,',
    '      "sysUpdatedBy": "system",',
    '      "sysUpdatedOn": "2026-01-02 00:00:00"',
    "    }",
    "  },",
    '  "shard": "0",',
    '  "sweepId": "sweep-1",',
    '  "table": "sys_script"',
    "}",
  ].join("\n");

  it("renders the exact bytes a checkout contains", () => {
    expect(decode(renderShardManifest(goldenManifest))).toBe(`${GOLDEN}\n`);
  });

  it("ends with exactly one LF and carries no CR and no BOM", () => {
    const text = decode(renderShardManifest(goldenManifest));
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(renderShardManifest(goldenManifest)[0]).toBe("{".charCodeAt(0));
  });

  it("puts every scalar field of every entry on its own line (D15)", () => {
    // Counted rather than eyeballed. Each of the two entries contributes seven
    // lines at entry depth: six scalars plus the `"files": [` opener. A renderer
    // that started emitting `"files": ["a", "b"]` inline, or minifying an entry
    // onto one line, moves both counts — and that is the D15 regression, because
    // a single-line entry makes two developers editing two different records of
    // the same shard a git conflict instead of a line merge.
    const lines = decode(renderShardManifest(goldenManifest)).split("\n");
    expect(lines[lines.length - 1]).toBe("");
    const atEntryDepth = lines.filter((line) => /^ {6}"/.test(line));
    const fileOpeners = atEntryDepth.filter((line) => line === '      "files": [');
    expect(fileOpeners).toHaveLength(2);
    expect(atEntryDepth).toHaveLength(2 * 6 + fileOpeners.length);
    // One file name per line, one entry carrying one and the other two.
    expect(lines.filter((line) => /^ {8}"/.test(line))).toHaveLength(3);
  });

  it("is byte-identical across two renders of an equal value (INV-1)", () => {
    const first = renderShardManifest(goldenManifest);
    const second = renderShardManifest(
      buildShardManifest({
        table: "sys_script",
        shardKey: "0",
        fanout: 1,
        complete: true,
        sweepId: "sweep-1",
        // Same entries, inserted in the opposite order: key ORDER in the object
        // must not reach the bytes, or an instance that paged its rows
        // differently would produce a different tree.
        records: {
          [ID_B]: goldenManifest.records[ID_B],
          [ID_A]: goldenManifest.records[ID_A],
        },
      })
    );
    expect(second).toEqual(first);
  });
});

describe("buildShardManifest", () => {
  it("stamps the format version and carries every part through", () => {
    const manifest = buildShardManifest({
      table: "incident",
      shardKey: "ab",
      fanout: 2,
      complete: false,
      sweepId: "sweep-9",
      records: {},
    });
    expect(manifest.formatVersion).toBe(FORMAT_VERSION);
    expect(manifest).toMatchObject({
      table: "incident",
      shard: "ab",
      fanout: 2,
      complete: false,
      sweepId: "sweep-9",
      records: {},
    });
  });

  it.each<[string, string, ShardFanout]>([
    ["a key longer than the fan-out", "ab", 1],
    ["a key shorter than the fan-out", "a", 2],
    ["a key at all when the fan-out is 0", "0", 0],
  ])("rejects %s", (_label, shardKey, fanout) => {
    // Mixing two fan-outs writes a shard into a set that does not claim its file
    // name, and the next flush deletes it with every record it indexed.
    expect(() =>
      buildShardManifest({
        table: "incident",
        shardKey,
        fanout,
        complete: true,
        sweepId: "s",
        records: {},
      })
    ).toThrow(MirrorPathRejection);
  });

  it("refuses a right-length shard key that no fan-out level can name", () => {
    // The check was length-only until the alphabet half was added: `shardFileName`
    // requires hex, so a length-only constructor could mint a manifest whose
    // `shard` field cannot be turned into a file name, and the failure surfaced at
    // the store rather than here. `"zz"` stands for the whole class; `".."` is the
    // member that made it worth closing rather than pinning.
    for (const badKey of ["zz", "..", "ZZ", "0g"]) {
      expect(() =>
        buildShardManifest({
          table: "incident",
          shardKey: badKey,
          fanout: 2,
          complete: true,
          sweepId: "s",
          records: {},
        })
      ).toThrow(MirrorPathRejection);
    }
    const manifest = buildShardManifest({
      table: "incident",
      shardKey: "ff",
      fanout: 2,
      complete: true,
      sweepId: "s",
      records: {},
    });
    expect(manifest.shard).toBe("ff");
    // The point of the check: what the constructor accepts, the file namer accepts.
    expect(shardFileName(manifest.shard, manifest.fanout)).toBe("ff.json");
  });
});

// ---------------------------------------------------------------------------
// parseShardManifest — the trust boundary
// ---------------------------------------------------------------------------

const SHARD_PATH = "instance/global/sys_script/.shards/0.json";

const validParseInput = (): Record<string, unknown> => ({
  formatVersion: 1,
  table: "sys_script",
  shard: "0",
  fanout: 1,
  complete: true,
  sweepId: "sweep-1",
  records: { [ID_A]: entry("Alpha") },
});

const withTopLevel = (over: Record<string, unknown>): string =>
  JSON.stringify({ ...validParseInput(), ...over });

const withEntry = (over: Record<string, unknown>): string =>
  JSON.stringify({
    ...validParseInput(),
    records: { [ID_A]: { ...entry("Alpha"), ...over } },
  });

const withRecordKey = (key: string): string =>
  JSON.stringify({ ...validParseInput(), records: { [key]: entry("Alpha") } });

/**
 * A shard file whose single record key is spliced into the JSON text verbatim.
 * `rawKey` carries its own quotes. Needed for keys that cannot survive a
 * JavaScript object literal on the way to `JSON.stringify` — `__proto__` above
 * all, which sets a prototype rather than an own property.
 */
const withRecordKeyRaw = (rawKey: string): string => {
  const placeholder = "@@RAW_KEY@@";
  const text = JSON.stringify({
    ...validParseInput(),
    records: { [placeholder]: { polluted: true } },
  });
  return text.replace(`"${placeholder}"`, rawKey);
};

describe("parseShardManifest round trip", () => {
  it("re-reads what it rendered, unchanged", () => {
    const manifest = buildShardManifest({
      table: "sys_script",
      shardKey: "0",
      fanout: 1,
      complete: true,
      sweepId: "sweep-1",
      records: { [ID_A]: entry("Alpha"), [ID_B]: entry("Beta", { sysModCount: 0 }) },
    });
    const parsed = parseShardManifest(decode(renderShardManifest(manifest)), SHARD_PATH);
    expect(parsed).toEqual(manifest);
    expect(renderShardManifest(parsed)).toEqual(renderShardManifest(manifest));
  });

  it("round-trips an arbitrary manifest at every fan-out", () => {
    fc.assert(
      fc.property(
        fanoutArb,
        sysIdArb,
        fc.uniqueArray(sysIdArb, { minLength: 0, maxLength: 5 }),
        fc.string({ maxLength: 12 }),
        fc.string({ maxLength: 12 }),
        fc.boolean(),
        (fanout, keySource, ids, table, sweepId, complete) => {
          const shardKey = keySource.slice(0, fanout);
          // Every record has to live in the shard it is filed under, so the ids
          // are forced onto the key's prefix; the Set removes the collisions
          // that forcing can create.
          const members = [...new Set(ids.map((id) => shardKey + id.slice(fanout)))];
          const records: Record<string, RecordEntry> = {};
          for (const [index, id] of members.entries()) {
            records[id] = entry(`R${index}`, {
              sysModCount: index,
              files: index % 2 === 0 ? [] : ["a.js", "z.css"],
            });
          }
          const manifest = buildShardManifest({
            table,
            shardKey,
            fanout,
            complete,
            sweepId,
            records,
          });
          const bytes = renderShardManifest(manifest);
          const parsed = parseShardManifest(decode(bytes), SHARD_PATH);
          expect(parsed).toEqual(manifest);
          expect(renderShardManifest(parsed)).toEqual(bytes);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("normalizes a hand-sorted file list, so the first re-render differs from disk", () => {
    // `files` is declared sorted (§4.3) and the parser enforces it. The honest
    // consequence: a shard someone hand-edited out of order parses fine but is
    // rewritten by the next sweep. Asserted so that "the parser normalizes" is a
    // decision rather than an accident.
    const text = withEntry({ files: ["z.js", "a.js"] });
    const parsed = parseShardManifest(text, SHARD_PATH);
    expect(parsed.records[ID_A].files).toEqual(["a.js", "z.js"]);
  });

  it("round-trips RecordEntry.attachments byte-for-byte", () => {
    // The field is optional and WP-M9 is what first writes it, but the parser is
    // what decides whether a shard round-trips: a field that renders on the way out
    // and vanishes on the way back in makes an attachment-bearing shard dirty on
    // every sweep. The assertion is the re-render, not the field.
    const manifest = buildShardManifest({
      table: "sys_script",
      shardKey: "0",
      fanout: 1,
      complete: true,
      sweepId: "sweep-1",
      records: {
        [ID_A]: entry("Alpha", {
          attachments: [
            { sysId: ID_B, fileName: "logo.png", sizeBytes: 12, sha256: "abc", lfs: false },
          ],
        }),
      },
    });
    const text = decode(renderShardManifest(manifest));
    const parsed = parseShardManifest(text, SHARD_PATH);
    expect(parsed.records[ID_A].attachments).toEqual([
      { sysId: ID_B, fileName: "logo.png", sizeBytes: 12, sha256: "abc", lfs: false },
    ]);
    expect(decode(renderShardManifest(parsed))).toBe(text);
  });

  it("leaves an entry without attachments without the key, not with an undefined one", () => {
    // `canonicalJsonBytes` renders an explicitly-present `attachments: undefined`
    // differently from an absent key, so "absent in, absent out" is a byte-level
    // claim about every shard WP-M7 writes, not a cosmetic one.
    const parsed = parseShardManifest(withEntry({}), SHARD_PATH);
    expect(Object.hasOwn(parsed.records[ID_A], "attachments")).toBe(false);
  });

  it("sorts attachments by sys_id, so the instance's return order cannot dirty a shard", () => {
    const [first, second] = [ID_B, ID_C].sort();
    const text = withEntry({
      attachments: [
        { sysId: second, fileName: "b.png", sizeBytes: 2, sha256: "b", lfs: false },
        { sysId: first, fileName: "a.png", sizeBytes: 1, sha256: "a", lfs: true },
      ],
    });
    const parsed = parseShardManifest(text, SHARD_PATH);
    expect(parsed.records[ID_A].attachments?.map((a) => a.sysId)).toEqual([
      first,
      second,
    ]);
  });

  it.each([
    ["a non-array attachments field", { attachments: {} }],
    ["an attachment that is not an object", { attachments: ["logo.png"] }],
    [
      "an attachment sys_id that fails INV-6",
      { attachments: [{ sysId: "../..", fileName: "a.png", sizeBytes: 1, sha256: "a", lfs: false }] },
    ],
    [
      "an attachment fileName that escapes the record directory",
      { attachments: [{ sysId: ID_B, fileName: "../../id_rsa", sizeBytes: 1, sha256: "a", lfs: false }] },
    ],
    [
      "a negative sizeBytes",
      { attachments: [{ sysId: ID_B, fileName: "a.png", sizeBytes: -1, sha256: "a", lfs: false }] },
    ],
    [
      "a fractional sizeBytes",
      { attachments: [{ sysId: ID_B, fileName: "a.png", sizeBytes: 1.5, sha256: "a", lfs: false }] },
    ],
    [
      "a non-boolean lfs flag",
      { attachments: [{ sysId: ID_B, fileName: "a.png", sizeBytes: 1, sha256: "a", lfs: "yes" }] },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseShardManifest(withEntry(overrides), SHARD_PATH)).toThrow(
      ShardManifestCorrupt
    );
  });

  it("KNOWN GAP: silently drops an unknown top-level field instead of rejecting it", () => {
    // Reported, not fixed here. An unknown field is either a newer format the
    // build cannot honour or a hand edit that will be thrown away without a
    // word; both deserve louder treatment than a silent drop.
    const parsed = parseShardManifest(withTopLevel({ unknownField: "kept?" }), SHARD_PATH);
    expect(parsed).not.toHaveProperty("unknownField");
  });

  it("rejects a non-hex shard field of the right length, even with no records", () => {
    // The per-record check below (`sysId.slice(0, fanout) === shard`) already
    // rejected this for any shard holding at least one record — which is why the
    // length-only check survived review. An EMPTY shard has no record to disagree
    // with it, and an empty shard is exactly what a completed sweep writes for a key
    // with no records, so `"shard": ".."` would have reached `shardFileName` on the
    // next flush. Both cases are asserted so the fix is not mistaken for the
    // pre-existing per-record one.
    for (const badShard of ["zz", "..", "0G"]) {
      expect(() =>
        parseShardManifest(
          JSON.stringify({
            ...validParseInput(),
            shard: badShard,
            fanout: 2,
            records: {},
          }),
          SHARD_PATH
        )
      ).toThrow(ShardManifestCorrupt);
    }
  });
});

describe("parseShardManifest rejections", () => {
  it.each([
    ["not JSON at all", "{"],
    ["a truncated document", withTopLevel({}).slice(0, 40)],
    ["a top-level array", "[]"],
    ["a top-level null", "null"],
    ["a top-level string", '"sys_script"'],
    ["a top-level number", "17"],
    ["a missing formatVersion", withTopLevel({ formatVersion: undefined })],
    ["a future formatVersion", withTopLevel({ formatVersion: FORMAT_VERSION + 1 })],
    ["a stringified formatVersion", withTopLevel({ formatVersion: "1" })],
    ["an out-of-range fanout", withTopLevel({ fanout: 3 })],
    ["a stringified fanout", withTopLevel({ fanout: "1" })],
    ["a missing fanout", withTopLevel({ fanout: undefined })],
    ["a non-string table", withTopLevel({ table: 7 })],
    ["a missing sweepId", withTopLevel({ sweepId: undefined })],
    ["a non-string shard", withTopLevel({ shard: 0 })],
    ["a shard that disagrees with the fanout", withTopLevel({ fanout: 2 })],
    ["a non-boolean complete", withTopLevel({ complete: "true" })],
    ["a missing records map", withTopLevel({ records: undefined })],
    ["records as an array", withTopLevel({ records: [] })],
    ["records as null", withTopLevel({ records: null })],
    ["an uppercase record key", withRecordKey("A".repeat(32))],
    ["a traversal record key", withRecordKey("../../../etc/passwd")],
    ["a prototype-pollution record key", withRecordKey("__proto__")],
    ["a record filed in the wrong shard", withRecordKey(`1${"a".repeat(31)}`)],
    ["an entry that is not an object", withTopLevel({ records: { [ID_A]: "Alpha" } })],
    ["an entry that is an array", withTopLevel({ records: { [ID_A]: [] } })],
    ["an entry that is null", withTopLevel({ records: { [ID_A]: null } })],
    ["a non-string name", withEntry({ name: 7 })],
    ["an empty name", withEntry({ name: "" })],
    ["a traversal name", withEntry({ name: ".." })],
    ["a name with a separator", withEntry({ name: "a/b" })],
    ["a name with a backslash", withEntry({ name: "a\\b" })],
    ["a non-string path", withEntry({ path: 7 })],
    ["an empty path", withEntry({ path: "" })],
    ["an absolute path", withEntry({ path: "/etc/passwd" })],
    ["a traversing path", withEntry({ path: "instance/../../secrets" })],
    ["a backslash path", withEntry({ path: "instance\\global\\x" })],
    ["a windows drive path", withEntry({ path: "C:/Windows/System32" })],
    ["a non-string sysUpdatedOn", withEntry({ sysUpdatedOn: 0 })],
    ["a non-string sysUpdatedBy", withEntry({ sysUpdatedBy: null })],
    ["a non-string contentHash", withEntry({ contentHash: 12345 })],
    ["a stringified sysModCount", withEntry({ sysModCount: "3" })],
    ["a missing sysModCount", withEntry({ sysModCount: undefined })],
    ["a non-array file list", withEntry({ files: "record.json" })],
    ["a file list holding a number", withEntry({ files: ["record.json", 7] })],
    ["a file list holding null", withEntry({ files: [null] })],
    // A member of `files` becomes a path the verifier reads and the writer's
    // prune logic honours, so it earns the whole component check rather than a
    // typeof — the same rows `name` is held to, one field down.
    ["a file list holding an empty name", withEntry({ files: [""] })],
    ["a file list holding a traversal", withEntry({ files: ["../../../etc/passwd"] })],
    ["a file list holding a separator", withEntry({ files: ["nested/script.js"] })],
    ["a file list holding a backslash", withEntry({ files: ["nested\\script.js"] })],
    ["a file list holding a dot entry", withEntry({ files: ["."] })],
  ])("rejects %s", (_label, text) => {
    expect(() => parseShardManifest(text, SHARD_PATH)).toThrow(ShardManifestCorrupt);
  });

  it("carries the offending file's path on the error", () => {
    // The reconciler reads hundreds of shards; an error that does not say which
    // file failed is an error nobody can act on.
    try {
      parseShardManifest("{", SHARD_PATH);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ShardManifestCorrupt);
      expect((error as ShardManifestCorrupt).shardPath).toBe(SHARD_PATH);
      expect((error as ShardManifestCorrupt).message).toContain(SHARD_PATH);
      expect((error as ShardManifestCorrupt).name).toBe("ShardManifestCorrupt");
    }
  });

  it("does not let a corrupt shard write the error message", () => {
    const text = withRecordKey("abc\ndef\u001b[2J");
    try {
      parseShardManifest(text, SHARD_PATH);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ShardManifestCorrupt);
      expect((error as Error).message).not.toContain("\n");
      expect((error as Error).message).not.toContain("\u001b");
    }
  });

  it("leaves Object.prototype untouched when a shard tries to pollute it", () => {
    // Written as raw JSON on purpose: an object literal `{ __proto__: ... }` sets
    // the prototype instead of an own key, so `JSON.stringify` of it emits `{}`
    // and the test would pass without ever exercising the hostile key.
    const text = withRecordKeyRaw('"__proto__"');
    expect(text).toContain('"__proto__"');
    expect(() => parseShardManifest(text, SHARD_PATH)).toThrow(ShardManifestCorrupt);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("refuses to treat a corrupt shard as an empty one", () => {
    // Load-bearing: the shard is the deletion baseline. "Corrupt means empty"
    // would authorise deleting every record the shard described, so the only
    // acceptable outcome is a throw — never a manifest with zero records.
    let returned: unknown = "not reached";
    try {
      returned = parseShardManifest(withTopLevel({ records: null }), SHARD_PATH);
    } catch {
      returned = "threw";
    }
    expect(returned).toBe("threw");
  });
});

// ---------------------------------------------------------------------------
// Reported gaps that are not this module's to close alone
// ---------------------------------------------------------------------------

describe("known gaps (pinned, not endorsed)", () => {
  it("refuses to derive a record path equal to the table's shard directory", () => {
    // `isSafePathComponent(".shards")` is true, so a record whose display name is
    // ".shards" would otherwise get a record directory byte-identical to the
    // table's shard-set directory — and `applyAuthorizedDeletion` re-derives
    // exactly this string, so removing that record would remove the whole table's
    // index. Both halves of the fix are asserted: `RecordNameResolver` reserves the
    // name so nothing in the writer reaches this throw (see recordPath.test.ts),
    // and this refusal holds for any caller that bypasses the resolver.
    expect(() =>
      recordDirRelPath({
        scope: "global",
        table: "sys_script",
        sysId: ID_A,
        name: SHARD_DIR_NAME,
      })
    ).toThrow(MirrorPathRejection);
    // Only the exact name is reserved: the suffixed form the resolver hands out
    // must still derive a path, or the fix would make such a record unwritable.
    expect(
      recordDirRelPath({
        scope: "global",
        table: "sys_script",
        sysId: ID_A,
        name: `${SHARD_DIR_NAME}_${ID_A}`,
      })
    ).toBe(`${shardDirRelPath("global", "sys_script")}_${ID_A}`);
  });

  it("KNOWN GAP: a NUL inside a name or a path is not rejected here", () => {
    // Reported, not fixed here. `isSafePathComponent` (sn-transport, shared with
    // v1's download pipeline) rejects empty, dots-only and separator-bearing
    // names but not a C0 control, so such a name reaches `fs.writeFile` and is
    // classified as a local-I/O failure (F8) rather than as the bad input it is.
    // Widening the shared predicate changes v1 behaviour, which is why WP-M7
    // pins the gap instead of closing it. Escapes only — never a literal byte.
    expect(() => assertMirrorPathComponent("a\u0000b", "record name")).not.toThrow();
    expect(isContainedRepoPath("instance/global/a\u0000b")).toBe(true);
    expect(() =>
      parseShardManifest(withEntry({ name: "a\u0000b", path: "instance/a\u0000b" }), SHARD_PATH)
    ).not.toThrow();
  });

  it("KNOWN GAP: a contained path is not required to start at the instance directory", () => {
    // Reported, not fixed here. Containment only proves "inside the repo", not
    // "inside the mirror", so a committed shard can name `.github/workflows/ci.yml`
    // as a record path. It is currently harmless because the writer re-derives
    // the directory from (scope, table, name) and refuses to act on a stored
    // path that differs — but that mitigation lives in another module, and this
    // test is what says so out loud.
    expect(isContainedRepoPath(".github/workflows/ci.yml")).toBe(true);
    expect(
      parseShardManifest(withEntry({ path: ".github/workflows" }), SHARD_PATH).records[ID_A]
        .path
    ).toBe(".github/workflows");
  });
});
