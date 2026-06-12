import { groupAppFiles } from "../appUtils";
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
});
