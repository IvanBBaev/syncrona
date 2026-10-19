// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for CrossScopePrivilege(), UserPreference(), ApplicationMenu()
// and UiPolicy(): the fixture project is an SDK 4.13.6 build probe that calls
// each API with its minimal and its full set of options. The native compiler
// must produce the SDK's record updates byte for byte and write keys.ts back
// unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/simpleApis");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected");

function expectedFiles(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of fs.readdirSync(path.join(EXPECTED, dir))) {
      out.set(`${dir}/${file}`, fs.readFileSync(path.join(EXPECTED, dir, file), "utf8"));
    }
  }
  return out;
}

function expectSame(actual: Map<string, string>, expected: Map<string, string>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [file, content] of expected) expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${content}`);
}

describe("native compiler golden output for the simple APIs (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => {
      throw new Error("unexpected GUID request");
    },
  });

  it("compiles without errors or warnings, like the SDK build", () => {
    expect(fs.readFileSync(path.join(EXPECTED, "sdk-build.txt"), "utf8")).not.toMatch(/warning|error/);
    expect(result.diagnostics.filter((d) => d.severity !== "hint")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("hints where the SDK reports info", () => {
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "Action at index 2 has no effect — consider specifying at least one of: visible, readOnly, mandatory, or cleared",
    ]);
  });

  it("produces the SDK's record updates byte for byte", () => {
    expectSame(
      new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)])),
      expectedFiles(["unload.demo", "update"]),
    );
  });

  it("produces the SDK's dictionary file byte for byte", () => {
    expectSame(new Map(result.files.map((f) => [f.path, f.content])), expectedFiles(["dictionary"]));
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
