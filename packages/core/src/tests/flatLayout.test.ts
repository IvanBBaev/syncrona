import path from "path";
import {
  folderRelToFlat,
  flatRelToFolder,
  isFlatEncoded,
} from "../flatLayout";

const p = (...segs: string[]) => segs.join(path.sep);

describe("folderRelToFlat", () => {
  it("collapses the record folder into a single flat file", () => {
    expect(folderRelToFlat(p("sys_script_include", "MyUtil", "script.js"))).toBe(
      p("sys_script_include", "MyUtil~script.js")
    );
  });

  it("leaves non-record-folder paths unchanged", () => {
    expect(folderRelToFlat(p("README.md"))).toBe(p("README.md"));
    expect(folderRelToFlat(p("table", "loose.js"))).toBe(p("table", "loose.js"));
  });
});

describe("flatRelToFolder", () => {
  it("expands a flat file back into the record folder", () => {
    expect(flatRelToFolder(p("sys_script_include", "MyUtil~script.js"))).toBe(
      p("sys_script_include", "MyUtil", "script.js")
    );
  });

  it("leaves paths without a separator unchanged", () => {
    expect(flatRelToFolder(p("table", "plain.js"))).toBe(p("table", "plain.js"));
  });

  it("ignores a leading/trailing separator (not a valid encoding)", () => {
    expect(flatRelToFolder(p("table", "~field.js"))).toBe(p("table", "~field.js"));
    expect(flatRelToFolder(p("table", "record~.js"))).toBe(p("table", "record~.js"));
  });
});

describe("round-trip is lossless", () => {
  const cases = [
    p("sys_script", "Rule A", "script.js"),
    p("sys_script_include", "MyUtil", "script.js"),
    // record name containing dots
    p("sys_ui_script", "x.module.helper", "script.js"),
    // record name containing the separator: split on the LAST '~' keeps it lossless
    p("sys_script", "weird~name", "description.html"),
    // multiple field files of the same record
    p("sys_ws_operation", "GET op", "operation_script.js"),
  ];

  it.each(cases)("folder -> flat -> folder restores %s", (folderRel) => {
    const flat = folderRelToFlat(folderRel);
    expect(flatRelToFolder(flat)).toBe(folderRel);
  });

  it("two fields of one record map to distinct flat files and back", () => {
    const f1 = p("sys_script", "MyRule", "script.js");
    const f2 = p("sys_script", "MyRule", "description.html");
    const flat1 = folderRelToFlat(f1);
    const flat2 = folderRelToFlat(f2);
    expect(flat1).not.toBe(flat2);
    expect(flatRelToFolder(flat1)).toBe(f1);
    expect(flatRelToFolder(flat2)).toBe(f2);
  });
});

describe("isFlatEncoded", () => {
  it("recognizes a flat-encoded file", () => {
    expect(isFlatEncoded(p("t", "record~field.js"))).toBe(true);
  });
  it("rejects plain and edge-separator files", () => {
    expect(isFlatEncoded(p("t", "plain.js"))).toBe(false);
    expect(isFlatEncoded(p("t", "~field.js"))).toBe(false);
    expect(isFlatEncoded(p("t", "record~.js"))).toBe(false);
  });
});
