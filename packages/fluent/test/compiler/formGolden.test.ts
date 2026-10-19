// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden test for Form(): the fixture project is an SDK 4.13.6 build probe
// (default_view on incident; a Record() view with roles, a user, a two-column
// block, annotations by AnnotationType, key and default, formatters by key,
// constant and sys_id, and 12M, M2M and custom lists; a view named by string).
// Built with the probe's keys.ts, the native compiler must produce the SDK's
// record updates and composite form and section files byte for byte and keep
// keys.ts unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/form");
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

// A view named by string is a fresh reference: the SDK draws a random sys_id
// for it on every build (keys.ts keeps the first one only nested inside the
// form's key), so the byname form and section compare with that id masked.
const BYNAME_VIEW = /(view="|display_value="x_snc_bprobe_byname">)[0-9a-f]{32}/g;

function maskView(content: string): string {
  return content.replace(BYNAME_VIEW, "$1<random>");
}

function expectSame(actual: Map<string, string>, expected: Map<string, string>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [file, content] of expected) {
    expect(`${file}\n${maskView(actual.get(file) ?? "")}`).toBe(`${file}\n${maskView(content)}`);
  }
}

describe("native compiler golden output for Form() (SDK 4.13.6 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates, form and section files byte for byte", () => {
    expectSame(
      new Map([
        ...result.records.map((r): [string, string] => [r.path, renderRecordUpdate(r)]),
        ...result.files.map((f): [string, string] => [f.path, f.content]),
      ]),
      expectedFiles(["update"]),
    );
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
