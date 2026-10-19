// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for Test(): the fixture project is an SDK 4.13.6 build probe
// (a test without steps; a test with a protection policy whose steps cover
// record references, step outputs used directly and in templates, object and
// list inputs, a Duration() timeout and the default ones; a second test with a
// numeric step id, a plain-object timeout and invalid steps the SDK drops).
// Built with the probe's keys.ts, the native compiler must produce the SDK's
// record updates and composite step files byte for byte and keep keys.ts
// unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/test");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected/update");

describe("native compiler golden output for Test() (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });

  it("compiles without errors and reports the invalid steps", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining(["Unknown step: nope", "Unknown category: bogus"]));
  });

  it("produces the SDK's record updates and step files byte for byte", () => {
    const actual = new Map([
      ...result.records.map((r): [string, string] => [r.path, renderRecordUpdate(r)]),
      ...result.files.map((f): [string, string] => [f.path, f.content]),
    ]);
    const expected = new Map(fs.readdirSync(EXPECTED).map((file): [string, string] => [`update/${file}`, fs.readFileSync(path.join(EXPECTED, file), "utf8")]));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) {
      expect(`${file}\n${actual.get(file) ?? ""}`).toBe(`${file}\n${content}`);
    }
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
