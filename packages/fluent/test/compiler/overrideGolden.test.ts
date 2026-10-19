// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for `$override` and `Now.del()`: the fixture project is an SDK
// 4.13.6 build probe that overrides empty, defaulted and build-managed fields
// of every supported API and of a column, and deletes records by sys_id and
// by coalesce keys. The native compiler must produce the SDK's record updates
// and dictionary file byte for byte, warn where the SDK warned, and write
// keys.ts back unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/override");
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

/** The SDK build's warnings, as `line:column message`. */
function sdkWarnings(): string[] {
  return fs
    .readFileSync(path.join(EXPECTED, "sdk-build.txt"), "utf8")
    .split("\n")
    .flatMap((line) => {
      const m = /override\.now\.ts:(\d+):(\d+) - warning TS\d+: (.*)$/.exec(line);
      return m ? [`${m[1]}:${m[2]} ${m[3]}`] : [];
    });
}

describe("native compiler golden output for $override and Now.del() (SDK 4.13.6 probe)", () => {
  // A record deleted by its coalesce keys gets a fresh GUID on every SDK
  // build; the probe's are pinned here, in statement order.
  const guids = [
    "3875235f393b480187248dc5ffb2d5ca",
    "880dbb52cb8c4afea13ebbb529eb420b",
    "d33bcf1d72de425bb13c313be100f1f6",
  ];
  const result = compileFluentProject({
    projectDir: PROJECT,
    generateGuid: () => {
      const next = guids.shift();
      if (next === undefined) throw new Error("unexpected GUID request");
      return next;
    },
  });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(guids).toEqual([]);
  });

  it("warns about the overrides the SDK ignores", () => {
    const warnings = result.diagnostics
      .filter((d) => d.severity === "warning")
      .map((d) => `${d.line}:${d.column} ${d.message}`);
    expect(warnings).toEqual(sdkWarnings());
  });

  it("produces the SDK's record updates byte for byte", () => {
    expectSame(
      new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)])),
      expectedFiles(["author_elective_update", "update"]),
    );
  });

  it("produces the SDK's dictionary file byte for byte", () => {
    expectSame(new Map(result.files.map((f) => [f.path, f.content])), expectedFiles(["dictionary"]));
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
