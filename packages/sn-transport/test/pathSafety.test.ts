// SPDX-License-Identifier: GPL-3.0-or-later
// Path-safety lift (WP-M0, Δ2). The first two describe blocks are the core
// golden tests, copied so the lift is provably behavior-identical: the win32
// block is verbatim from packages/core/src/tests/win32PathSemantics.test.ts
// (only the import moved), and the INJ-1 block carries the same fixtures the
// download-pipeline guard is pinned with in
// packages/core/src/tests/downloadPipelineCoverage.test.ts, aimed straight at
// the assertion instead of through the pipeline that is not in this package.
// The remaining blocks cover the D18 additions the mirror needs on top.
import {
  isSafePathComponent,
  assertSafePathComponent,
  canonicalFoldName,
  foldNameComponent,
  buildSafeRecordName,
  resolveUniqueNames,
  truncateToNameByteCap,
  nameByteLength,
  MAX_NAME_BYTES,
  SEPARATOR_REPLACEMENT,
} from "../src/pathSafety";

describe("isSafePathComponent: win32-shaped components", () => {
  it("rejects backslash-bearing components", () => {
    expect(isSafePathComponent("..\\evil")).toBe(false);
    expect(isSafePathComponent("sub\\dir")).toBe(false);
    expect(isSafePathComponent("C:\\evil")).toBe(false);
    expect(isSafePathComponent("\\\\server\\share")).toBe(false);
  });

  it("accepts the server-side separator replacement character", () => {
    expect(isSafePathComponent("sub〳dir")).toBe(true);
  });

  it("accepts a bare drive designator (documented contract)", () => {
    // "C:" carries no separator and is not dots-only, so the containment rule
    // passes it. path.win32.join/resolve do NOT reinterpret a colon component
    // embedded mid-path, so it cannot traverse; on native Windows the write
    // fails loudly with EINVAL instead. Pinned so a future tightening is a
    // deliberate decision, not drift.
    expect(isSafePathComponent("C:")).toBe(true);
  });
});

describe("assertSafePathComponent: containment guard (INJ-1)", () => {
  it("rejects a table name that walks out of the source root", () => {
    expect(() => assertSafePathComponent("../evil", "table name")).toThrow(
      /unsafe table name .* escape the workspace source root/
    );
  });

  it("rejects a record name that walks out of the source root", () => {
    expect(() => assertSafePathComponent("../../../../.zshrc", "record name")).toThrow(
      /unsafe record name .* escape the workspace source root/
    );
  });

  it("names the record directory as the boundary for field and file components", () => {
    expect(() => assertSafePathComponent("../x", "field name")).toThrow(
      /unsafe field name .* escape its record's directory/
    );
    expect(() => assertSafePathComponent("a/b", "file type")).toThrow(
      /unsafe file type .* escape its record's directory/
    );
  });

  it("rejects pure-dot and empty components", () => {
    for (const bad of ["..", ".", "...", ""]) {
      expect(() => assertSafePathComponent(bad, "table name")).toThrow(/unsafe table name/);
    }
  });

  it("lets a benign component through unharmed", () => {
    expect(() => assertSafePathComponent("sys_script_include", "table name")).not.toThrow();
  });

  it("rejects a non-string that slipped past the type system", () => {
    // The values reaching this guard come from instance JSON, not from
    // TypeScript, so the runtime typeof check is load-bearing.
    expect(isSafePathComponent(undefined as unknown as string)).toBe(false);
  });
});

describe("canonicalFoldName: what 'the same name' means on disk", () => {
  it("folds case, because APFS and NTFS do", () => {
    expect(canonicalFoldName("Widget")).toBe(canonicalFoldName("widget"));
  });

  it("folds Unicode composition, because macOS hands back the composed form", () => {
    // U+00E9 vs U+0065 U+0301 — same name to a human and to the filesystem.
    expect(canonicalFoldName("caf\u00e9")).toBe(canonicalFoldName("cafe\u0301"));
  });

  it("folds trailing dots and spaces, because Windows drops them on create", () => {
    expect(canonicalFoldName("Report. ")).toBe("report");
  });
});

describe("truncateToNameByteCap: UTF-8 byte cap (D18)", () => {
  it("returns a short name untouched", () => {
    expect(truncateToNameByteCap("Widget")).toBe("Widget");
  });

  it("measures bytes, not characters", () => {
    // 150 Cyrillic characters are 300 UTF-8 bytes, so a character-based cap
    // would happily write a name the filesystem rejects.
    const name = "\u044f".repeat(150);
    expect(name.length).toBe(150);
    expect(nameByteLength(name)).toBe(300);
    const capped = truncateToNameByteCap(name);
    expect(nameByteLength(capped)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(capped.length).toBe(MAX_NAME_BYTES / 2);
  });

  it("never splits a code point", () => {
    // Cutting an astral character in half would leave a lone surrogate that
    // round-trips to U+FFFD, so the name on disk stops matching the manifest.
    const emoji = "\u{1f600}".repeat(10);
    const capped = truncateToNameByteCap(emoji, 7);
    expect(capped).toBe("\u{1f600}");
    expect(nameByteLength(capped)).toBe(4);
  });

  it("accepts an explicit cap of zero", () => {
    expect(truncateToNameByteCap("abc", 0)).toBe("");
  });
});

describe("foldNameComponent: raw ServiceNow name to on-disk form", () => {
  it("replaces both separator directions with the server-side character", () => {
    expect(foldNameComponent("a/b\\c")).toBe(`a${SEPARATOR_REPLACEMENT}b${SEPARATOR_REPLACEMENT}c`);
  });

  it("normalizes to NFC so a decomposed name is not a second directory", () => {
    expect(foldNameComponent("cafe\u0301")).toBe("caf\u00e9");
  });

  it("applies the byte cap after normalization", () => {
    const folded = foldNameComponent("\u044f".repeat(150));
    expect(nameByteLength(folded)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it("returns an empty string for names that cannot be a directory", () => {
    expect(foldNameComponent("")).toBe("");
    expect(foldNameComponent("   ")).toBe("");
    expect(foldNameComponent("..")).toBe("");
    expect(foldNameComponent(" ... ")).toBe("");
  });
});

describe("buildSafeRecordName: display name, else sys_id, else nothing", () => {
  const SYS_ID = "0123456789abcdef0123456789abcdef";

  it("prefers the folded display name", () => {
    expect(buildSafeRecordName("My Script", SYS_ID)).toBe("My Script");
  });

  it("falls back to the sys_id when the name folds away", () => {
    expect(buildSafeRecordName("..", SYS_ID)).toBe(SYS_ID);
  });

  it("returns nothing when even the sys_id is not containable", () => {
    // The caller must report this row as a gap rather than guess a location
    // for it — silently writing it somewhere is how a tree stops being honest.
    expect(buildSafeRecordName("", "../etc")).toBe("");
  });
});

describe("resolveUniqueNames: order-independent case-insensitive uniqueness (D18)", () => {
  it("keeps both records when two rows produce the same name", () => {
    // Copied from the v1 collision golden in
    // packages/core/src/tests/manifestBuilderCoverage.test.ts: neither record
    // keeps the plain name, so the outcome does not depend on row order.
    const { names, collided } = resolveUniqueNames([
      { sysId: "rec-1", name: "Same" },
      { sysId: "rec-2", name: "Same" },
    ]);
    expect(names.get("rec-1")).toBe("Same_rec-1");
    expect(names.get("rec-2")).toBe("Same_rec-2");
    expect([...names.values()]).not.toContain("Same");
    expect(collided).toEqual(["rec-1", "rec-2"]);
  });

  it("produces the same tree whichever order the rows arrive in", () => {
    // The defect this pins: a first-writer-wins scheme makes an unchanged
    // instance serialize differently on every run, so every mirror commit
    // looks like a change and the diff stops meaning anything.
    const forward = resolveUniqueNames([
      { sysId: "rec-1", name: "Same" },
      { sysId: "rec-2", name: "Same" },
    ]);
    const reversed = resolveUniqueNames([
      { sysId: "rec-2", name: "Same" },
      { sysId: "rec-1", name: "Same" },
    ]);
    expect([...forward.names].sort()).toEqual([...reversed.names].sort());
  });

  it("treats a case-only difference as a collision", () => {
    // On APFS "Widget" and "widget" are one file; without the suffix the two
    // records overwrite each other on every sync and git sees a permanent
    // phantom modification (analyses §9.2).
    const { names } = resolveUniqueNames([
      { sysId: "a1", name: "Widget" },
      { sysId: "a2", name: "widget" },
    ]);
    expect(names.get("a1")).toBe("Widget_a1");
    expect(names.get("a2")).toBe("widget_a2");
  });

  it("leaves a unique name alone", () => {
    const { names, collided } = resolveUniqueNames([
      { sysId: "a1", name: "Widget" },
      { sysId: "a2", name: "Gadget" },
    ]);
    expect(names.get("a1")).toBe("Widget");
    expect(names.get("a2")).toBe("Gadget");
    expect(collided).toEqual([]);
  });

  it("does not treat the same record listed twice as colliding with itself", () => {
    const { names, collided } = resolveUniqueNames([
      { sysId: "a1", name: "Widget" },
      { sysId: "a1", name: "Widget" },
    ]);
    expect(names.get("a1")).toBe("Widget");
    expect(collided).toEqual([]);
  });

  it("reports unusable candidates instead of dropping them silently", () => {
    const { names, unusable } = resolveUniqueNames([
      { sysId: "a1", name: "../escape" },
      { sysId: "..", name: "Widget" },
      { sysId: "a2", name: "Gadget" },
    ]);
    expect([...names.keys()]).toEqual(["a2"]);
    expect(unusable.map((candidate) => candidate.sysId)).toEqual(["a1", ".."]);
  });

  it("keeps the suffixed name inside the byte cap", () => {
    // A name already at the cap plus a 33-byte suffix would exceed it, so the
    // base is re-truncated against the remaining budget.
    const long = "\u044f".repeat(150);
    const sysId = "0123456789abcdef0123456789abcdef";
    const other = "0123456789abcdef0123456789abcde0";
    const { names } = resolveUniqueNames([
      { sysId, name: foldNameComponent(long) },
      { sysId: other, name: foldNameComponent(long) },
    ]);
    expect(names.size).toBe(2);
    for (const name of names.values()) {
      expect(nameByteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    }
    expect(names.get(sysId)?.endsWith(`_${sysId}`)).toBe(true);
    expect(names.get(other)?.endsWith(`_${other}`)).toBe(true);
  });

  it("pins the documented precondition: candidates must be pre-folded", () => {
    // The composed pipeline is what a caller is meant to run. Folding first
    // replaces the separator, composes to NFC and caps the bytes; the collision
    // pass then only has to make the result unique.
    const sysId = "0123456789abcdef0123456789abcdef";
    const raw = "a/be\u0301"; // a separator, then a decomposed "e-acute"
    const composed = resolveUniqueNames([
      { sysId, name: buildSafeRecordName(raw, sysId) },
    ]).names.get(sysId);
    expect(composed).toBe(`a${SEPARATOR_REPLACEMENT}b\u00e9`);

    // Handing the raw instance string in directly is the misuse the docblock
    // warns about: the name is written through verbatim, separator and NFD and
    // all, so it is neither containable nor byte-stable. Asserting it here means
    // a future "helpful" fold inside resolveUniqueNames cannot land silently —
    // it would have to change this expectation and say so.
    const unfolded = resolveUniqueNames([{ sysId, name: raw }]).names.get(sysId);
    expect(unfolded).toBeUndefined();
    expect(isSafePathComponent(raw)).toBe(false);
  });
});
