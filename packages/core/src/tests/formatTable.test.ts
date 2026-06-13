import { formatTable } from "../genericUtils";

export {};

// DX22: column-aligned dry-run preview table.
describe("formatTable", () => {
  it("aligns columns to the widest cell and adds a separator", () => {
    const out = formatTable(
      ["Table", "Record", "Fields"],
      [
        ["sys_script", "Beta", "1"],
        ["sys_script_include", "A", "2"],
      ]
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    // Header padded to the widest cell in each column (sys_script_include = 18).
    expect(lines[0]).toBe("Table               Record  Fields");
    expect(lines[1]).toBe("------------------  ------  ------");
    expect(lines[2]).toBe("sys_script          Beta    1");
    expect(lines[3]).toBe("sys_script_include  A       2");
  });

  it("handles no rows (header + separator only)", () => {
    const out = formatTable(["A", "B"], []);
    expect(out.split("\n")).toEqual(["A  B", "-  -"]);
  });

  it("treats missing cells as empty", () => {
    const out = formatTable(["A", "B"], [["x"]]);
    expect(out.split("\n")[2]).toBe("x");
  });
});
