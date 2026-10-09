// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// Edge cases of the folder-naming rules and of the upgrade step that moves a
// renamed folder, which the sibling suites leave out: records whose manifest
// `name` is empty (the key is the name), manifests with missing or malformed
// tables, the collision-counter suffix, names that differ only by a trailing
// dot (two folders on disk, one canonical key), shared flat-layout files and
// the refusals that keep a move from overwriting or misattributing local files.
// Real filesystem under a temp dir; only the logger is mocked.

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn, error: jest.fn(), success: jest.fn() },
}));

const {
  assignRecordFolderNames,
  assignManifestFolderNames,
  applyManifestFolderNames,
  isRuleDrivenRename,
  migrateRenamedRecordFolders,
} = await import("../recordFolderNames.js");

const record = (name: string, sysId: string): SN.MetaRecord => ({
  name,
  sys_id: sysId,
  files: [{ name: "script", type: "js" }],
});

beforeEach(() => warn.mockClear());

describe("assignRecordFolderNames edge cases", () => {
  it("falls back to the raw sys_id when neither the name nor the sys_id is storable", () => {
    // "..." sanitizes to "" (trailing dots dropped), so the last resort is the
    // sys_id as given; the download writer then refuses it loudly instead of
    // the naming silently inventing a folder.
    const names = assignRecordFolderNames("t", [{ sysId: "...", name: "" }]);
    expect(names.get("...")).toBe("...");
  });

  it("orders several colliding groups by their lowest sys_id, whatever the row order", () => {
    const rows = [
      { sysId: "z1", name: "Zed" },
      { sysId: "z2", name: "zed" },
      { sysId: "m1", name: "Mid" },
      { sysId: "m2", name: "MID" },
      { sysId: "a1", name: "Alpha" },
      { sysId: "a2", name: "alpha" },
    ];
    const forward = assignRecordFolderNames("t", rows);
    const forwardWarnings = warn.mock.calls.map((call) => String(call[0]));
    warn.mockClear();
    const backward = assignRecordFolderNames("t", [...rows].reverse());
    const backwardWarnings = warn.mock.calls.map((call) => String(call[0]));

    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
    expect(forward.get("a1")).toBe("Alpha_a1");
    expect(forward.get("m2")).toBe("MID_m2");
    expect(forward.get("z2")).toBe("zed_z2");
    // One warning per group, always in the same order.
    expect(forwardWarnings).toEqual(backwardWarnings);
    expect(forwardWarnings).toHaveLength(3);
    expect(forwardWarnings[0]).toContain('"Alpha"');
    expect(forwardWarnings[1]).toContain('"MID"');
    expect(forwardWarnings[2]).toContain('"Zed"');
  });
});

describe("assignManifestFolderNames edge cases", () => {
  it("names a record whose manifest name is empty by its key", () => {
    const manifest: SN.AppManifest = {
      scope: "x",
      tables: {
        t: { records: { Util: record("", "s1"), util: record("", "s2"), Bar: record("", "b1") } },
      },
    } as SN.AppManifest;
    assignManifestFolderNames(manifest);
    const records = manifest.tables.t.records;
    expect(Object.keys(records).sort()).toEqual(["Bar", "Util_s1", "util_s2"]);
    // The re-keyed records carry their folder as their name; the untouched one
    // keeps its (empty) name and stays the same object.
    expect(records.Util_s1).toMatchObject({ name: "Util_s1", sys_id: "s1" });
    expect(records.util_s2).toMatchObject({ name: "util_s2", sys_id: "s2" });
    expect(records.Bar.name).toBe("");
  });

  it("returns a manifest without tables, and skips null or record-less tables", () => {
    const bare = { scope: "x" } as SN.AppManifest;
    expect(assignManifestFolderNames(bare)).toBe(bare);
    expect(bare).toEqual({ scope: "x" });

    const odd = {
      scope: "x",
      tables: {
        empty: null,
        noRecords: {},
        nullRecords: { records: null },
        t: { records: { Util: record("Util", "s1"), util: record("util", "s2") } },
      },
    } as unknown as SN.AppManifest;
    assignManifestFolderNames(odd);
    const tables = odd.tables as unknown as Record<string, unknown>;
    expect(tables.empty).toBeNull();
    expect(tables.noRecords).toEqual({});
    expect(tables.nullRecords).toEqual({ records: null });
    expect(Object.keys(odd.tables.t.records).sort()).toEqual(["Util_s1", "util_s2"]);
  });
});

describe("applyManifestFolderNames edge cases", () => {
  it("tolerates a missing table map", () => {
    const tables = applyManifestFolderNames(
      undefined as unknown as SN.TableMap,
      { t: { s1: "Util_s1" } }
    );
    expect(tables).toBeUndefined();
  });

  it("keeps the key of a record the manifest names with nothing usable", () => {
    const fetched = {
      t: {
        records: {
          NoSysId: { name: "NoSysId", files: [] },
          NumericSysId: { name: "NumericSysId", sys_id: 7, files: [] },
          Unknown: record("Unknown", "u1"),
          EmptyName: record("EmptyName", "e1"),
          Util: record("Util", "s1"),
        },
      },
    } as unknown as SN.TableMap;
    applyManifestFolderNames(fetched, { t: { e1: "", s1: "Util_s1" } });
    expect(Object.keys(fetched.t.records).sort()).toEqual([
      "EmptyName",
      "NoSysId",
      "NumericSysId",
      "Unknown",
      "Util_s1",
    ]);
    expect(fetched.t.records.Util_s1.name).toBe("Util_s1");
    expect(fetched.t.records.EmptyName.name).toBe("EmptyName");
  });
});

describe("isRuleDrivenRename with the counter suffix", () => {
  it("strips a `_<sys_id>_<n>` counter suffix back to the base name", () => {
    expect(isRuleDrivenRename("Foo_s1_2", "Foo", "s1")).toBe(true);
    expect(isRuleDrivenRename("Foo_s1_2", "Foo_s1", "s1")).toBe(true);
    // A trailing number that does not follow this record's suffix is part of
    // the display name, so a different name is an instance-side rename.
    expect(isRuleDrivenRename("Foo_2", "Foo", "s1")).toBe(false);
    expect(isRuleDrivenRename("Foo_s2_2", "Foo", "s1")).toBe(false);
  });
});

describe("migrateRenamedRecordFolders edge cases", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-folder-edges-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, content: string) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const listing = (rel: string) => fs.readdirSync(path.join(root, rel)).sort();
  const manifestOf = (scope: string, names: Array<[string, string]>): SN.AppManifest => ({
    scope,
    tables: { t: { records: Object.fromEntries(names.map(([n, id]) => [n, record(n, id)])) } },
  });

  it("falls back to the manifest key when a record's name is empty", async () => {
    write("t/Solo/script.js", "local edit");
    const previous = { scope: "x", tables: { t: { records: { Solo: record("", "s1") } } } };
    const next = {
      scope: "x",
      tables: { t: { records: { Solo_s1: record("", "s1"), solo_s2: record("", "s2") } } },
    };
    const result = await migrateRenamedRecordFolders(
      previous as SN.AppManifest,
      next as SN.AppManifest,
      root,
      false
    );
    expect(result).toEqual({ moved: [{ table: "t", from: "Solo", to: "Solo_s1" }], leftBehind: [] });
    expect(read("t/Solo_s1/script.js")).toBe("local edit");
  });

  it("ignores missing, unsafe and record-less tables without touching the disk", async () => {
    write("t/Solo/script.js", "old");
    const previous = {
      scope: "x",
      tables: {
        t: {}, // no records
        "../escape": { records: { Solo: record("Solo", "s1") } },
        noRecords: { records: { Solo: record("Solo", "s1") } },
      },
    } as unknown as SN.AppManifest;
    const next = {
      scope: "x",
      tables: {
        t: { records: { Solo_s1: record("Solo_s1", "s1"), solo_s2: record("solo_s2", "s2") } },
        "../escape": { records: { Solo_s1: record("Solo_s1", "s1") } },
        notBefore: { records: { Solo_s1: record("Solo_s1", "s1") } },
        noRecords: {},
      },
    } as unknown as SN.AppManifest;
    const empty = { moved: [], leftBehind: [] };
    expect(await migrateRenamedRecordFolders(previous, next, root, false)).toEqual(empty);
    // A previous manifest without tables, and a next one without tables.
    expect(
      await migrateRenamedRecordFolders({ scope: "x" } as SN.AppManifest, next, root, false)
    ).toEqual(empty);
    expect(
      await migrateRenamedRecordFolders(previous, { scope: "x" } as SN.AppManifest, root, false)
    ).toEqual(empty);
    expect(listing("t")).toEqual(["Solo"]);
    expect(read("t/Solo/script.js")).toBe("old");
  });

  it("never moves an old folder whose name no call could have created", async () => {
    // "Foo\0" sanitizes to "Foo_", so the rename is rule-driven, but a NUL
    // truncates the name in every OS call: there is nothing to move.
    write("t/Foo/script.js", "a record called Foo");
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Foo\u0000", "s1"]]),
      manifestOf("x", [["Foo_", "s1"]]),
      root,
      false
    );
    expect(result).toEqual({ moved: [], leftBehind: [] });
    expect(listing("t")).toEqual(["Foo"]);
  });

  it("leaves a folder another record of the new manifest still claims", async () => {
    // s1's collision dissolved (Foo_s1 -> Foo) while s3 is literally named
    // "Foo_s1" now: the folder belongs to a live record and must not move.
    write("t/Foo_s1/script.js", "s1 local edit");
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Foo_s1", "s1"], ["foo_s2", "s2"]]),
      manifestOf("x", [["Foo", "s1"], ["Foo_s1", "s3"]]),
      root,
      false
    );
    expect(result).toEqual({ moved: [], leftBehind: [] });
    expect(listing("t")).toEqual(["Foo_s1"]);
    expect(read("t/Foo_s1/script.js")).toBe("s1 local edit");
  });

  it("skips a record whose old folder is not on disk (folder layout)", async () => {
    fs.mkdirSync(path.join(root, "t"), { recursive: true });
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Solo", "s1"]]),
      manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]),
      root,
      false
    );
    expect(result).toEqual({ moved: [], leftBehind: [] });
    expect(listing("t")).toEqual([]);
  });

  it("skips a record with no flat files and one whose table directory is missing", async () => {
    write("t/Other~script.js", "unrelated");
    const previous = manifestOf("x", [["Solo", "s1"]]);
    const next = manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]);
    expect(await migrateRenamedRecordFolders(previous, next, root, true)).toEqual({
      moved: [],
      leftBehind: [],
    });
    expect(listing("t")).toEqual(["Other~script.js"]);
    fs.rmSync(path.join(root, "t"), { recursive: true });
    expect(await migrateRenamedRecordFolders(previous, next, root, true)).toEqual({
      moved: [],
      leftBehind: [],
    });
  });

  it.each([
    ["folder", false, ["Foo/script.js", "Foo./script.js"], ["Foo_s1/script.js", "Foo_s2/script.js"]],
    ["flat", true, ["Foo~script.js", "Foo.~script.js"], ["Foo_s1~script.js", "Foo_s2~script.js"]],
  ])(
    "moves both records of a trailing-dot pair, which were two entries on disk (%s layout)",
    async (_layout, flat, [fooFile, dotFile], [fooTarget, dotTarget]) => {
      // "Foo" and "Foo." share a canonical key, but outside Windows they are
      // two folders (and two flat stems): neither one's files belong to the
      // other, so both move to their suffixed names.
      write(`t/${fooFile}`, "s1 edit");
      write(`t/${dotFile}`, "s2 edit");
      const result = await migrateRenamedRecordFolders(
        manifestOf("x", [["Foo", "s1"], ["Foo.", "s2"]]),
        manifestOf("x", [["Foo_s1", "s1"], ["Foo_s2", "s2"]]),
        root,
        flat
      );
      expect(result.leftBehind).toEqual([]);
      expect(result.moved).toEqual([
        { table: "t", from: "Foo", to: "Foo_s1" },
        { table: "t", from: "Foo.", to: "Foo_s2" },
      ]);
      expect(read(`t/${fooTarget}`)).toBe("s1 edit");
      expect(read(`t/${dotTarget}`)).toBe("s2 edit");
      expect(fs.existsSync(path.join(root, "t", fooFile))).toBe(false);
      expect(fs.existsSync(path.join(root, "t", dotFile))).toBe(false);
    }
  );

  it("leaves flat files two records shared in place, reported once", async () => {
    // "Foo" and "foo" were one flat stem on a case-insensitive volume. A hard
    // link reproduces that on a case-sensitive one: both spellings resolve to
    // the same entry, so the files cannot be attributed to either record.
    write("t/Foo~script.js", "written by both");
    const lower = path.join(root, "t", "foo~script.js");
    if (!fs.existsSync(lower)) fs.linkSync(path.join(root, "t", "Foo~script.js"), lower);
    const before = listing("t");
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Foo", "s1"], ["foo", "s2"]]),
      manifestOf("x", [["Foo_s1", "s1"], ["foo_s2", "s2"]]),
      root,
      true
    );
    expect(result.moved).toEqual([]);
    expect(result.leftBehind).toEqual([
      {
        table: "t",
        folder: "Foo",
        reason: expect.stringContaining("records whose names collide shared it"),
      },
    ]);
    expect(listing("t")).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("leaves flat files in place when a file of the new name already exists", async () => {
    write("t/Solo~script.js", "local edit");
    write("t/Solo~.meta.json", "{}");
    write("t/Solo_s1~script.js", "already there");
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Solo", "s1"]]),
      manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]),
      root,
      true
    );
    expect(result.moved).toEqual([]);
    expect(result.leftBehind).toEqual([
      { table: "t", folder: "Solo", reason: 'files of the new name "Solo_s1" already exist' },
    ]);
    // Nothing moved, not even the sidecar whose destination was free.
    expect(listing("t")).toEqual(["Solo_s1~script.js", "Solo~.meta.json", "Solo~script.js"]);
    expect(read("t/Solo_s1~script.js")).toBe("already there");
    expect(read("t/Solo~script.js")).toBe("local edit");
  });

  it("reports a non-Error move failure by its string form", async () => {
    write("t/Solo/script.js", "old");
    const rename = jest.spyOn(fs.promises, "rename").mockRejectedValueOnce("device busy");
    try {
      const result = await migrateRenamedRecordFolders(
        manifestOf("x", [["Solo", "s1"]]),
        manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]),
        root,
        false
      );
      expect(result.moved).toEqual([]);
      expect(result.leftBehind).toEqual([
        { table: "t", folder: "Solo", reason: "moving it failed (device busy)" },
      ]);
      expect(read("t/Solo/script.js")).toBe("old");
    } finally {
      rename.mockRestore();
    }
  });
});
