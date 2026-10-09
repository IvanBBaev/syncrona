// SPDX-License-Identifier: GPL-3.0-or-later
//
// Edge shapes of a hand-edited missing-file map for withoutDotWalkedFieldFiles:
// null record maps and null file lists (the manifest is hand-editable JSON),
// and which records and tables survive once the refusal empties them.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

const warn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
  },
}));

const { withoutDotWalkedFieldFiles, resetDotWalkedFieldFileWarnings } = await import(
  "../dotWalkedFieldFiles.js"
);

const WALKED = "sys_created_by.user_password";
const file = (name: unknown, type = "txt") => ({ name, type }) as unknown as SN.File;
const asMap = (raw: unknown) => raw as SN.MissingFileTableMap;

beforeEach(() => {
  warn.mockClear();
  resetDotWalkedFieldFileWarnings();
});

describe("withoutDotWalkedFieldFiles: null record maps and file lists", () => {
  it("returns the same map when a null table or null file list holds no refused name", () => {
    const missing = asMap({
      t_null: null,
      t_files: { r1: null, r2: [file("script", "js")] },
    });

    expect(withoutDotWalkedFieldFiles(missing)).toBe(missing);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a null table as an empty one and a null file list as an empty list once something is refused", () => {
    const missing = asMap({
      t_null: null,
      t_mixed: {
        r_null: null,
        r_empty: [],
        r_walked: [file(WALKED)],
        r_kept: [file(WALKED), file("script", "js")],
      },
    });

    const kept = withoutDotWalkedFieldFiles(missing);

    expect(kept).not.toBe(missing);
    expect({ ...kept.t_null }).toEqual({});
    expect({ ...kept.t_mixed }).toEqual({
      r_null: [],
      r_empty: [],
      r_kept: [file("script", "js")],
    });
    // The record the refusal emptied is dropped, not kept as an empty list.
    expect(Object.keys(kept.t_mixed)).not.toContain("r_walked");
  });

  it("drops a table the refusal empties but keeps one that was already empty", () => {
    const missing = asMap({
      t_walked: { r1: [file(WALKED)], r2: [file(WALKED)] },
      t_empty: {},
    });

    const kept = withoutDotWalkedFieldFiles(missing);

    expect(Object.keys(kept)).toEqual(["t_empty"]);
    expect({ ...kept.t_empty }).toEqual({});
    // Once per table and column, even across two records.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`"${WALKED}"`);
  });

  it("refuses a non-string name with the not-a-string warning and keeps the meta sidecar", () => {
    const missing = asMap({
      t: { r1: [file(undefined), file(".meta", "json"), file(["a.b"])] },
    });

    const kept = withoutDotWalkedFieldFiles(missing);

    expect(kept.t.r1).toEqual([file(".meta", "json")]);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => /name is not a string/.test(m))).toBe(true);
    expect(messages.some((m) => m.includes("(undefined)"))).toBe(true);
    expect(messages.some((m) => m.includes('(["a.b"])'))).toBe(true);
  });
});
