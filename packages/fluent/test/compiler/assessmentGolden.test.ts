// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for Assessment() and RiskAssessment(): the fixture project is an
// SDK 4.13.6 build probe with a scheduled, published assessment using most
// options (roles mixing a Role() record and names, a Duration(), a numeric
// scale with generated definitions, explicit definitions, a dependent metric),
// a survey, a bare assessment and a risk assessment with thresholds. The native compiler must produce the SDK's record updates
// byte for byte and write keys.ts back unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/assessment");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected");

function expectedFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of fs.readdirSync(path.join(EXPECTED, dir))) {
    out.set(`${dir}/${file}`, fs.readFileSync(path.join(EXPECTED, dir, file), "utf8"));
  }
  return out;
}

describe("native compiler golden output for Assessment() and RiskAssessment() (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => {
      throw new Error("unexpected GUID request");
    },
  });

  it("reports no errors or warnings, as the SDK build does", () => {
    expect(fs.readFileSync(path.join(EXPECTED, "sdk-build.txt"), "utf8")).not.toMatch(/warning|error/i);
    expect(result.diagnostics.filter((d) => d.severity !== "hint")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates byte for byte", () => {
    const actual = new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)]));
    const expected = expectedFiles("update");
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${content}`);
  });

  it("writes no other files", () => {
    expect(result.files).toEqual([]);
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
