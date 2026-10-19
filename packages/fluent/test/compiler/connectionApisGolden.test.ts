// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for RetryPolicy(), Alias() and DataLookup(): the fixture project
// is an SDK 4.13.6 build probe that calls each API with its minimal and its
// full set of options. The native compiler must produce the SDK's record
// updates byte for byte, report the SDK's warnings and write keys.ts back
// unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/connectionApis");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected");

function expectedFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of fs.readdirSync(path.join(EXPECTED, dir))) {
    out.set(`${dir}/${file}`, fs.readFileSync(path.join(EXPECTED, dir, file), "utf8"));
  }
  return out;
}

describe("native compiler golden output for the connection APIs (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => {
      throw new Error("unexpected GUID request");
    },
  });

  it("reports the SDK build's warnings and no errors", () => {
    const sdkWarnings = [
      ...fs.readFileSync(path.join(EXPECTED, "sdk-build.txt"), "utf8").matchAll(/warning TS\d+: (.*)/g),
    ].map((m) => m[1]);
    expect(sdkWarnings).toHaveLength(4);
    const reported = result.diagnostics.filter((d) => d.severity !== "hint");
    expect(reported.map((d) => [d.severity, d.message])).toEqual(sdkWarnings.map((m) => ["warning", m]));
    expect(result.ok).toBe(true);
  });

  it("hints where the SDK reports info", () => {
    expect(result.diagnostics.filter((d) => d.severity === "hint").map((d) => d.message)).toEqual([
      "For a better experience, consider using the Alias API",
    ]);
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
