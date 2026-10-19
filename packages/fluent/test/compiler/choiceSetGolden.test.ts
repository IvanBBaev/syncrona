// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for ChoiceSet(): the fixture project is an SDK 4.13.6 build
// probe (a table extending `task` and two choice sets on its inherited fields:
// shorthand labels, choice objects and per-language arrays). Built with the
// probe's keys.ts, the native compiler must produce the SDK's record updates,
// dictionary and choice set files byte for byte and keep keys.ts unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/choiceset");
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

describe("native compiler golden output for ChoiceSet() (SDK 4.13.6 probe)", () => {
  // `extends: 'task'` references a record outside the app, which the SDK gives
  // a fresh GUID on every build; the probe's is pinned here.
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => "26ab1ca953e644c995ff754d0618fd5e",
  });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates byte for byte", () => {
    expectSame(new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)])), expectedFiles(["update"]));
  });

  it("produces the SDK's dictionary and choice set files byte for byte", () => {
    expectSame(
      new Map(result.files.map((f) => [f.path, f.content])),
      expectedFiles(["author_elective_update", "dictionary"]),
    );
    expect(result.files.map((f) => f.path)).toEqual([...result.files.map((f) => f.path)].sort());
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
