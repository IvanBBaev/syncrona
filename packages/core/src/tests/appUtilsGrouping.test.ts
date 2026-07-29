// SPDX-License-Identifier: GPL-3.0-or-later
import { groupAppFiles } from "../appUtils.js";
import { Sync } from "@syncrona/types";

const ctx = (
  filePath: string,
  tableName: string,
  sysId: string,
  targetField: string
): Sync.FileContext => ({
  filePath,
  name: filePath,
  tableName,
  targetField,
  ext: ".js",
  sys_id: sysId,
  scope: "x_nuvo_test",
});

describe("groupAppFiles", () => {
  it("groups multiple file contexts for the same record into one buildable", () => {
    const grouped = groupAppFiles([
      ctx("/tmp/a.script.js", "sys_script", "rec_1", "script"),
      ctx("/tmp/a.condition.js", "sys_script", "rec_1", "condition"),
      ctx("/tmp/b.script.js", "sys_script", "rec_2", "script"),
    ]);

    expect(grouped).toHaveLength(2);

    const rec1 = grouped.find((entry) => entry.sysId === "rec_1");
    const rec2 = grouped.find((entry) => entry.sysId === "rec_2");

    expect(rec1).toBeDefined();
    expect(rec1?.table).toBe("sys_script");
    expect(Object.keys(rec1?.fields || {}).sort()).toEqual(["condition", "script"]);

    expect(rec2).toBeDefined();
    expect(rec2?.table).toBe("sys_script");
    expect(Object.keys(rec2?.fields || {})).toEqual(["script"]);
  });

  // A workspace can legitimately end up holding both layouts of one field (a
  // DX17 flat `<record>~<field>.js` next to a leftover folder-mode
  // `<record>/<field>.js`). The plain assignment kept whichever came last, so
  // the loser's edits were silently dropped and the winner depended on
  // directory iteration order — the same push uploaded different bytes on
  // different machines. Fail loudly instead of guessing.
  it("throws when two local files claim the same record field", () => {
    expect(() =>
      groupAppFiles([
        ctx("/tmp/src/sys_script/rec_1/script.js", "sys_script", "rec_1", "script"),
        ctx("/tmp/src/sys_script/rec_1~script.js", "sys_script", "rec_1", "script"),
      ])
    ).toThrow(/Ambiguous push/);
  });

  it("does not treat the same file listed twice as ambiguous", () => {
    const duplicate = ctx("/tmp/src/sys_script/rec_1/script.js", "sys_script", "rec_1", "script");
    const grouped = groupAppFiles([duplicate, { ...duplicate }]);
    expect(grouped).toHaveLength(1);
    expect(Object.keys(grouped[0].fields)).toEqual(["script"]);
  });
});
