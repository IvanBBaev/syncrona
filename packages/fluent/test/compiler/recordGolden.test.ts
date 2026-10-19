// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for Record(): the fixture project is an SDK 4.13.6 build probe
// writing records of a custom table (scalars, arrays, Now.include, record and
// Now.ref references, a demo record, a GUID `$id`) and of platform tables the
// native compiler knows the coalesce strategy of, with the name references the
// SDK fixes up. Built with the probe's keys.ts, the native compiler must
// produce the SDK's record updates byte for byte and write keys.ts back
// unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/record");
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

describe("native compiler golden output for Record() (SDK 4.13.6 probe)", () => {
  // `Now.ref('sys_user_group', { name })` references a record outside the app,
  // which the SDK gives a fresh GUID on every build; the probe's is pinned here.
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => "ee2f0da627974868a148262d1aabff99",
  });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("hints at the dedicated API of tables an SDK API owns", () => {
    expect(result.diagnostics.map((d) => `${path.basename(d.file)}:${d.line} ${d.message}`)).toEqual([
      "record.now.ts:47 For a better experience, consider using the Property API",
      "record.now.ts:53 For a better experience, consider using the UiAction API",
      "record2.now.ts:4 For a better experience, consider using the UiAction API",
      "record2.now.ts:10 For a better experience, consider using the UiAction API",
      "record2.now.ts:16 For a better experience, consider using the UiAction API",
      "record2.now.ts:22 For a better experience, consider using the UiAction API",
      "record2.now.ts:28 For a better experience, consider using the UiAction API",
      "record2.now.ts:34 For a better experience, consider using the Role API",
      "record2.now.ts:40 For a better experience, consider using the Role API",
    ]);
  });

  it("produces the SDK's record updates byte for byte", () => {
    const actual = new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)]));
    const expected = expectedFiles(["update", "unload.demo"]);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${content}`);
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
