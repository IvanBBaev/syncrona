// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden tests for UiPage() (sys_ui_page): a minimal page, a full Jelly page
// with raw script/style/textarea content, the <sdk:now-ux-globals> expansions
// and empty html, plus global-scope pages (identified by name, with an empty
// endpoint). The fixture projects are SDK 4.13 build probes. Built with
// each probe's keys.ts, the native compiler must produce the SDK's record
// updates byte for byte and write keys.ts back unchanged.

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

function expectedFiles(expected: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of fs.readdirSync(expected)) {
    for (const file of fs.readdirSync(path.join(expected, dir))) {
      out.set(
        `${dir}/${file}`,
        fs.readFileSync(path.join(expected, dir, file), "utf8"),
      );
    }
  }
  return out;
}

describe.each([
  ["scoped", "uipage"],
  ["global", "uipage-global"],
])("native compiler golden output: UiPage, %s (SDK 4.13 probe)", (_, name) => {
  const fixture = path.join(__dirname, "../fixtures", name);
  const project = path.join(fixture, "project");
  const result = compileFluentProject({ projectDir: project });

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates byte for byte", () => {
    const actual = new Map(
      result.records.map((r) => [r.path, renderRecordUpdate(r)]),
    );
    const expected = expectedFiles(path.join(fixture, "expected"));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, xml] of expected)
      expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${xml}`);
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysPath).toBe(
      path.join(project, "src/fluent/generated/keys.ts"),
    );
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
