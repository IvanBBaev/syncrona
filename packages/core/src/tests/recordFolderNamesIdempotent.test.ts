// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { SN } from "@syncrona/types";

// The folder-name rules are a fixed point: a name the rules produced comes back
// unchanged when it passes through them again, whichever producer named it
// first. Without that, the Table API build (which names records and is then
// re-checked by assignManifestFolderNames) and the scoped endpoint (named only
// by assignManifestFolderNames) give the same records different folders, and a
// producer flip orphans the old folders.

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn, error: jest.fn(), success: jest.fn() },
}));

const {
  MAX_RECORD_NAME_BYTES,
  assignManifestFolderNames,
  assignRecordFolderNames,
  isRuleDrivenRename,
  sanitizeRecordFolderName,
} = await import("../recordFolderNames.js");

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const S1 = "1".repeat(32);
const S2 = "2".repeat(32);
const S3 = "3".repeat(32);
const long = "L".repeat(250);

const entrySets: Array<[string, Array<{ sysId: string; name: string }>]> = [
  ["two records with one overlong name", [{ sysId: S1, name: long }, { sysId: S2, name: long }]],
  [
    "a collision just under the budget",
    [
      { sysId: S1, name: "a".repeat(MAX_RECORD_NAME_BYTES) },
      { sysId: S2, name: "A".repeat(MAX_RECORD_NAME_BYTES) },
    ],
  ],
  [
    "a name that is literally another member's suffixed name",
    [
      { sysId: S1, name: "dup" },
      { sysId: S2, name: "dup" },
      { sysId: S3, name: `dup_${S2}` },
    ],
  ],
  [
    "names Windows cannot store",
    [
      { sysId: S1, name: "CON" },
      { sysId: S2, name: "Report." },
      { sysId: S3, name: "   " },
    ],
  ],
  [
    "plain names",
    [
      { sysId: S1, name: "Util" },
      { sysId: S2, name: "util" },
      { sysId: S3, name: "Other" },
    ],
  ],
];

const reassign = (names: Map<string, string>) =>
  assignRecordFolderNames(
    "t",
    [...names].map(([sysId, name]) => ({ sysId, name }))
  );

describe("assignRecordFolderNames is idempotent", () => {
  it.each(entrySets)("assign(assign(x)) === assign(x): %s", (_label, entries) => {
    const once = assignRecordFolderNames("t", entries);
    expect([...reassign(once)].sort()).toEqual([...once].sort());
    for (const folder of once.values()) {
      expect(bytes(folder)).toBeLessThanOrEqual(MAX_RECORD_NAME_BYTES);
      expect(sanitizeRecordFolderName(folder)).toBe(folder);
    }
  });

  it("keeps the sys_id of a suffixed overlong name", () => {
    const names = assignRecordFolderNames("t", entrySets[0][1]);
    expect(names.get(S1)).toMatch(new RegExp(`^L+_[0-9a-f]{8}_${S1}$`, "u"));
    expect(names.get(S2)).toMatch(new RegExp(`^L+_[0-9a-f]{8}_${S2}$`, "u"));
  });
});

describe("every producer names the same records the same way", () => {
  const manifestOf = (records: Array<[string, string, string]>): SN.AppManifest => ({
    scope: "x",
    tables: {
      t: {
        records: Object.fromEntries(
          records.map(([key, sysId, name]) => [key, { name, sys_id: sysId, files: [] }])
        ),
      },
    },
  });
  const foldersOf = (manifest: SN.AppManifest) =>
    Object.fromEntries(Object.values(manifest.tables.t.records).map((r) => [r.sys_id, r.name]));

  it.each(entrySets)("Table API and scoped endpoint agree: %s", (_label, entries) => {
    // Table API: buildRecordName sanitizes first, assignRecordFolderNames names,
    // then adoptRecordFolderNames re-applies the rules to the manifest it wrote.
    const tableApi = assignRecordFolderNames(
      "t",
      entries.map((e) => ({ sysId: e.sysId, name: sanitizeRecordFolderName(e.name) }))
    );
    const tableApiManifest = assignManifestFolderNames(
      manifestOf([...tableApi].map(([sysId, name]) => [name, sysId, name]))
    );
    // Scoped endpoint: display values verbatim, named once by the manifest pass.
    // Duplicate display names cannot share a JSON key, so each gets its own.
    const scoped = assignManifestFolderNames(
      manifestOf(entries.map((e, i) => [`k${i}`, e.sysId, e.name]))
    );
    expect(foldersOf(scoped)).toEqual(Object.fromEntries(tableApi));
    expect(foldersOf(tableApiManifest)).toEqual(Object.fromEntries(tableApi));
  });
});

describe("isRuleDrivenRename recognises the folders earlier rules wrote", () => {
  it("treats an over-budget suffixed folder and its fitted form as one record", () => {
    // Before the suffix was budgeted, the cut name kept the full budget and the
    // `_<sys_id>` went on top of it.
    const oldFolder = `${sanitizeRecordFolderName(long)}_${S1}`;
    expect(bytes(oldFolder)).toBeGreaterThan(MAX_RECORD_NAME_BYTES);
    const next = assignRecordFolderNames("t", entrySets[0][1]).get(S1) as string;
    expect(isRuleDrivenRename(oldFolder, next, S1)).toBe(true);
    expect(isRuleDrivenRename(oldFolder, next, S2)).toBe(false);
  });

  it("does not take an instance-side rename of a long record for a rule", () => {
    const next = assignRecordFolderNames("t", [{ sysId: S1, name: "M".repeat(250) }]).get(
      S1
    ) as string;
    expect(isRuleDrivenRename(`${sanitizeRecordFolderName(long)}_${S1}`, next, S1)).toBe(false);
    // A short name that merely ends like a hash is not a cut name.
    expect(isRuleDrivenRename("Foo", "Foo_deadbeef", S1)).toBe(false);
    // A short name renamed to a long one that starts with it is a real rename.
    expect(isRuleDrivenRename("L", sanitizeRecordFolderName(long), S1)).toBe(false);
  });
});
