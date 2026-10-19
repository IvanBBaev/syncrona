// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden tests for the instance scan checks (ColumnTypeCheck(), LinterCheck(),
// ScriptOnlyCheck() and TableCheck()): the fixture project is
// an SDK 4.13 build probe. Built with the probe's keys.ts, the native compiler
// must produce the SDK's record updates byte for byte and write keys.ts back
// unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/scan");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected");

function expectedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of fs.readdirSync(EXPECTED)) {
    for (const file of fs.readdirSync(path.join(EXPECTED, dir))) {
      out.set(`${dir}/${file}`, fs.readFileSync(path.join(EXPECTED, dir, file), "utf8"));
    }
  }
  return out;
}

describe("native compiler golden output: instance scan checks (SDK 4.13 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates byte for byte", () => {
    const actual = new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)]));
    const expected = expectedFiles();
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, xml] of expected) expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${xml}`);
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysPath).toBe(path.join(PROJECT, "src/fluent/generated/keys.ts"));
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
