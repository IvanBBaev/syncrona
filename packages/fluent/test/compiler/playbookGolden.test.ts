// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for PlaybookDefinition(): the fixture project is an SDK 4.13.6
// build probe (a record-driven playbook on incident with a RecordUpdate
// trigger; a lane with an Instruction and a Two Step Instruction that starts
// after it, with custom inputs and experience properties; a second lane that
// starts after the first). Built with the probe's keys.ts, the native compiler
// must produce the SDK's composite playbook file byte for byte and keep
// keys.ts unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/playbook");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected/update");

describe("native compiler golden output for PlaybookDefinition() (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's playbook file byte for byte", () => {
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
