// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for AiAgent(): the fixture project is an SDK 4.13.6 build probe
// with a minimal agent, an agent using most options (versions, role ACL,
// roleMap data access, an out-of-the-box and a script tool, triggers and memory
// categories) and a public agent with roleList data access and an $override.
// The native compiler must produce the SDK's record updates byte for byte
// (role references by name get a random sys_id, which is masked) and write
// keys.ts back unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/aiagent");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected");
const BYNAME_ROLE = /(<role name="[^"]*">)[0-9a-f]{32}/g;

function expectedFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of fs.readdirSync(path.join(EXPECTED, dir))) {
    out.set(`${dir}/${file}`, fs.readFileSync(path.join(EXPECTED, dir, file), "utf8"));
  }
  return out;
}

function maskRole(content: string): string {
  return content.replace(BYNAME_ROLE, "$1<random>");
}

describe("native compiler golden output for AiAgent() (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });

  it("reports no errors or warnings, as the SDK build does", () => {
    expect(fs.readFileSync(path.join(EXPECTED, "sdk-build.txt"), "utf8")).not.toMatch(/warning|error/i);
    expect(result.diagnostics.filter((d) => d.severity !== "hint")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates byte for byte", () => {
    const actual = new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)]));
    const expected = expectedFiles("update");
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) {
      expect(`${file}\n${maskRole(actual.get(file) ?? "")}`).toBe(`${file}\n${maskRole(content)}`);
    }
  });

  it("writes no other files", () => {
    expect(result.files).toEqual([]);
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
