// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// C6: the one function that maps a table's records to folder names. Names that
// collide on disk (equal after NFC + case fold + trailing dot/space strip) get a
// `_<sys_id>` suffix on every member, decided over the set — never the order —
// with one warning per group; every other record keeps its name byte for byte.

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn, error: jest.fn(), success: jest.fn() },
}));

const {
  assignRecordFolderNames,
  assignManifestFolderNames,
  applyManifestFolderNames,
  canonicalFolderKey,
  isRuleDrivenRename,
  migrateRenamedRecordFolders,
} = await import("../recordFolderNames.js");

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
      );

const record = (name: string, sysId: string): SN.MetaRecord => ({
  name,
  sys_id: sysId,
  files: [{ name: "script", type: "js" }],
});

beforeEach(() => warn.mockClear());

describe("canonicalFolderKey", () => {
  it("folds case, Unicode normal form and trailing dots/spaces", () => {
    expect(canonicalFolderKey("Café")).toBe(canonicalFolderKey("CAFÉ"));
    expect(canonicalFolderKey("Foo. ")).toBe("foo");
    expect(canonicalFolderKey(".hidden")).toBe(".hidden");
  });
});

describe("assignRecordFolderNames", () => {
  it("keeps every non-colliding name byte for byte and warns nothing", () => {
    const names = assignRecordFolderNames("t", [
      { sysId: "a", name: "Alpha" },
      { sysId: "b", name: "Beta" },
    ]);
    expect([...names]).toEqual([
      ["a", "Alpha"],
      ["b", "Beta"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("suffixes every member of a case-only collision with its sys_id", () => {
    const names = assignRecordFolderNames("sys_script_include", [
      { sysId: "s1", name: "Util" },
      { sysId: "s2", name: "util" },
      { sysId: "s3", name: "Other" },
    ]);
    expect(names.get("s1")).toBe("Util_s1");
    expect(names.get("s2")).toBe("util_s2");
    expect(names.get("s3")).toBe("Other");
  });

  it("treats NFC/NFD spellings and a trailing dot as the same folder", () => {
    const names = assignRecordFolderNames("t", [
      { sysId: "n1", name: "Café" },
      { sysId: "n2", name: "Café" },
      { sysId: "d1", name: "Report" },
      { sysId: "d2", name: "Report." },
    ]);
    expect(names.get("n1")).toBe("Café_n1");
    expect(names.get("n2")).toBe("Café_n2");
    expect(names.get("d1")).toBe("Report_d1");
    expect(names.get("d2")).toBe("Report._d2");
  });

  it("does not depend on the order the instance returned the records", () => {
    const entries = [
      { sysId: "s2", name: "util" },
      { sysId: "s1", name: "Util" },
      { sysId: "s3", name: "UTIL" },
      { sysId: "s4", name: "Lone" },
    ];
    const expected = [...assignRecordFolderNames("t", entries)].sort();
    for (const order of permutations(entries)) {
      expect([...assignRecordFolderNames("t", order)].sort()).toEqual(expected);
    }
  });

  it("warns once per colliding group, not once per member", () => {
    assignRecordFolderNames("t", [
      { sysId: "a1", name: "A" },
      { sysId: "a2", name: "a" },
      { sysId: "a3", name: "A" },
      { sysId: "b1", name: "B" },
      { sysId: "b2", name: "b" },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('"A_a1", "a_a2", "A_a3"');
  });

  it("collapses a sys_id listed twice to one record and one folder", () => {
    const names = assignRecordFolderNames("t", [
      { sysId: "x", name: "Same" },
      { sysId: "x", name: "Same" },
    ]);
    expect([...names]).toEqual([["x", "Same"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never lets a suffixed name land on another record's folder", () => {
    // "dup_b" is a real display name AND what the colliding "dup"/"Dup" pair's
    // member b would become; the real name keeps it, the suffix repeats.
    const names = assignRecordFolderNames("t", [
      { sysId: "a", name: "Dup" },
      { sysId: "b", name: "dup" },
      { sysId: "c", name: "dup_b" },
    ]);
    expect(names.get("c")).toBe("dup_b");
    expect(names.get("a")).toBe("Dup_a");
    expect(names.get("b")).toBe("dup_b_b");
    const folded = [...names.values()].map(canonicalFolderKey);
    expect(new Set(folded).size).toBe(folded.length);
  });
});

describe("assignManifestFolderNames", () => {
  it("re-keys a scoped manifest's colliding records and is idempotent", () => {
    const manifest: SN.AppManifest = {
      scope: "x_app",
      tables: {
        sys_script_include: {
          records: { Util: record("Util", "s1"), util: record("util", "s2"), Bar: record("Bar", "b1") },
        },
      },
    };
    assignManifestFolderNames(manifest);
    const records = manifest.tables.sys_script_include.records;
    expect(Object.keys(records).sort()).toEqual(["Bar", "Util_s1", "util_s2"]);
    expect(records.Util_s1).toMatchObject({ name: "Util_s1", sys_id: "s1" });

    const snapshot = JSON.stringify(manifest);
    const before = manifest.tables.sys_script_include.records;
    assignManifestFolderNames(manifest);
    expect(JSON.stringify(manifest)).toBe(snapshot);
    expect(manifest.tables.sys_script_include.records).toBe(before);
  });

  it("leaves a table without collisions as the same object", () => {
    const records = { A: record("A", "1"), B: record("B", "2") };
    const manifest: SN.AppManifest = { scope: "x", tables: { t: { records } } };
    assignManifestFolderNames(manifest);
    expect(manifest.tables.t.records).toBe(records);
  });

  it("keeps a record without a usable sys_id under its own key", () => {
    const manifest: SN.AppManifest = {
      scope: "x",
      tables: {
        t: {
          records: {
            A: record("A", "1"),
            a: record("a", "2"),
            "a.": { name: "a.", sys_id: "", files: [] },
          },
        },
      },
    };
    assignManifestFolderNames(manifest);
    expect(Object.keys(manifest.tables.t.records).sort()).toEqual(["A_1", "a.", "a_2"]);
  });

  it("stores a record named __proto__ as an own key", () => {
    const records: SN.TableConfigRecords = {};
    Object.defineProperty(records, "__proto__", {
      value: record("__proto__", "p1"),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(records, "__PROTO__", {
      value: record("__PROTO__", "p2"),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const manifest: SN.AppManifest = { scope: "x", tables: { t: { records } } };
    assignManifestFolderNames(manifest);
    expect(Object.keys(manifest.tables.t.records).sort()).toEqual(["__PROTO___p2", "__proto___p1"]);
  });
});

describe("applyManifestFolderNames", () => {
  it("re-keys a display-named fetch result onto the manifest's folders", () => {
    const fetched: SN.TableMap = {
      t: { records: { Util: record("Util", "s1"), Bar: record("Bar", "b1") } },
      other: { records: { X: record("X", "x1") } },
    };
    applyManifestFolderNames(fetched, { t: { s1: "Util_s1", b1: "Bar" } });
    expect(Object.keys(fetched.t.records).sort()).toEqual(["Bar", "Util_s1"]);
    expect(fetched.t.records.Util_s1.name).toBe("Util_s1");
    expect(Object.keys(fetched.other.records)).toEqual(["X"]);
  });
});

describe("isRuleDrivenRename", () => {
  it("accepts only the collision suffix, not an instance-side rename", () => {
    expect(isRuleDrivenRename("Util", "Util_s1", "s1")).toBe(true);
    expect(isRuleDrivenRename("dup", "dup_b_b", "b")).toBe(true);
    expect(isRuleDrivenRename("Util", "Utility", "s1")).toBe(false);
    expect(isRuleDrivenRename("Util", "Util_s2", "s1")).toBe(false);
  });
});

describe("migrateRenamedRecordFolders", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-folders-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, content: string) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const manifestOf = (scope: string, names: Array<[string, string]>): SN.AppManifest => ({
    scope,
    tables: { t: { records: Object.fromEntries(names.map(([n, id]) => [n, record(n, id)])) } },
  });

  it("moves a folder only one record owned (flat layout)", async () => {
    write("t/Solo~script.js", "local edit");
    write("t/Solo~.meta.json", "{}");
    write("t/Solo~Other~script.js", "not ours");
    const previous = manifestOf("x", [["Solo", "s1"], ["Solo~Other", "s9"]]);
    const next = manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"], ["Solo~Other", "s9"]]);
    const result = await migrateRenamedRecordFolders(previous, next, root, true);
    expect(result.moved).toEqual([{ table: "t", from: "Solo", to: "Solo_s1" }]);
    expect(fs.readdirSync(path.join(root, "t")).sort()).toEqual([
      "Solo_s1~.meta.json",
      "Solo_s1~script.js",
      "Solo~Other~script.js",
    ]);
    expect(fs.readFileSync(path.join(root, "t/Solo_s1~script.js"), "utf8")).toBe("local edit");
  });

  it("leaves the old folder, with a warning, when the destination exists", async () => {
    write("t/Solo/script.js", "old");
    write("t/Solo_s1/script.js", "already there");
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Solo", "s1"]]),
      manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]),
      root,
      false
    );
    expect(result.moved).toEqual([]);
    expect(result.leftBehind).toEqual([
      expect.objectContaining({ table: "t", folder: "Solo" }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Left \"t/Solo\" in place"));
  });

  it("does nothing across scopes, for instance-side renames or without a previous manifest", async () => {
    write("t/Solo/script.js", "old");
    const next = manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]);
    expect(await migrateRenamedRecordFolders(undefined, next, root, false)).toEqual({ moved: [], leftBehind: [] });
    expect(
      await migrateRenamedRecordFolders(manifestOf("y", [["Solo", "s1"]]), next, root, false)
    ).toEqual({ moved: [], leftBehind: [] });
    expect(
      await migrateRenamedRecordFolders(
        manifestOf("x", [["Solo", "s1"]]),
        manifestOf("x", [["Renamed", "s1"]]),
        root,
        false
      )
    ).toEqual({ moved: [], leftBehind: [] });
    expect(fs.existsSync(path.join(root, "t/Solo/script.js"))).toBe(true);
  });

  it("reports a failed move as left behind instead of throwing", async () => {
    write("t/Solo/script.js", "old");
    const rename = jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("EBUSY"));
    const result = await migrateRenamedRecordFolders(
      manifestOf("x", [["Solo", "s1"]]),
      manifestOf("x", [["Solo_s1", "s1"], ["solo_s2", "s2"]]),
      root,
      false
    );
    rename.mockRestore();
    expect(result.leftBehind[0].reason).toContain("EBUSY");
  });
});
