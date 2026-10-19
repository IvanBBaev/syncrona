// SPDX-License-Identifier: GPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { counter, IMPORT, makeProject, messages, only } from "./helpers";

const FIXTURE = path.join(__dirname, "../fixtures/batch1/project");

describe("compileFluentProject", () => {
  it.each([
    ["{", /^Cannot read now.config.json: /],
    ["null", /^now.config.json needs a string 'scope'.$/],
    [JSON.stringify({ scope: "x_a" }), /^now.config.json needs a string 'scopeId'.$/],
    [JSON.stringify({ scope: "x_a", scopeId: "1", fluentDir: "" }), /^now.config.json needs a string 'fluentDir'.$/],
  ])("reports a bad now.config.json %s", (config, message) => {
    const projectDir = makeProject({}, config);
    const result = compileFluentProject({ projectDir });
    expect(result).toMatchObject({ ok: false, records: [], keysPath: path.join(projectDir, "src/fluent/generated/keys.ts") });
    expect(result.keysText).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: path.join(projectDir, "now.config.json"), line: 1 })]);
    expect(result.diagnostics[0].message).toMatch(message);
  });

  it("reports a malformed keys file at its path", () => {
    const projectDir = makeProject({ "src/fluent/generated/keys.ts": "export {}\n" });
    const result = compileFluentProject({ projectDir });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ message: "Keys registry is malformed: no `global` namespace", file: result.keysPath, line: 1 }),
    ]);
  });

  it("compiles a project without Fluent sources to nothing", () => {
    const result = compileFluentProject({ projectDir: makeProject({}) });
    expect(result).toMatchObject({ ok: true, records: [], diagnostics: [] });
    expect(result.keysText).toContain("interface Keys extends KeysRegistry {}");
  });

  it("honours fluentDir and generatedDir and skips generated and node_modules sources", () => {
    const role = (name: string) => `${IMPORT}Role({ name: 'x_snc_bprobe.${name}' })\n`;
    const projectDir = makeProject(
      {
        "fluent/a.now.ts": role("a"),
        "fluent/nested/b.now.ts": role("b"),
        "fluent/out/c.now.ts": role("c"),
        "fluent/node_modules/d.now.ts": role("d"),
        "fluent/e.ts": role("e"),
      },
      { fluentDir: "fluent", generatedDir: "out" },
    );
    const result = compileFluentProject({ projectDir, generateGuid: counter() });
    expect(result.keysPath).toBe(path.join(projectDir, "fluent/out/keys.ts"));
    expect(only(result, "sys_user_role").map((r) => r.name)).toEqual(["x_snc_bprobe.a", "x_snc_bprobe.b"]);
  });

  describe("keys registry round trip", () => {
    // The probe source, built from an empty registry: run 1 assigns sys_ids,
    // run 2 with run 1's keys.ts reproduces them, and dropping a record marks
    // its key deleted while foreign-table keys stay untouched.
    const files = (keys?: string): Record<string, string> => ({
      "src/fluent/app.now.ts": fs.readFileSync(path.join(FIXTURE, "src/fluent/batch1.now.ts"), "utf8"),
      "src/server/si/Included.server.js": fs.readFileSync(path.join(FIXTURE, "src/server/si/Included.server.js"), "utf8"),
      ...(keys ? { "src/fluent/generated/keys.ts": keys } : {}),
    });
    const config = JSON.parse(fs.readFileSync(path.join(FIXTURE, "now.config.json"), "utf8")) as Record<string, unknown>;
    const run = (keys?: string, edit: (source: string) => string = (s) => s) => {
      const f = files(keys);
      f["src/fluent/app.now.ts"] = edit(f["src/fluent/app.now.ts"]);
      return compileFluentProject({ projectDir: makeProject(f, config), generateGuid: counter() });
    };

    const first = run();
    const second = run(first.keysText);

    it("assigns fresh sys_ids on the first build", () => {
      expect(messages(first)).toEqual([]);
      expect(first.records).toHaveLength(30);
      expect(first.keysText).not.toContain("deleted");
    });

    // The external role 'itil' is referenced by name only; nothing in the
    // registry holds its sys_id, so its reference gets a fresh GUID on every
    // build, as in the SDK (the platform coalesces it by the name attribute).
    const masked = (records: typeof first.records) =>
      records.map((r) => ({
        ...r,
        fields: r.fields.map((f) => (f.name === "contains" && f.attributes?.name === "itil" ? { ...f, value: "<fresh>" } : f)),
      }));

    it("keeps every sys_id on the next build", () => {
      expect(masked(second.records)).toEqual(masked(first.records));
      expect(masked(second.records)).not.toEqual(second.records);
      expect(second.keysText).toBe(first.keysText);
    });

    it("marks the key of a removed record deleted and keeps foreign keys", () => {
      const withForeign = `${second.keysText}`.replace(
        "explicit: {",
        "explicit: {\n                    bom_json: {\n                        table: 'sys_module'\n                        id: 'c17be2dde3604b6cb7597d7e626ef325'\n                    }",
      );
      const third = run(withForeign, (s) => s.replace(/^ScriptInclude\(\{ \$id: Now\.ID\['si_min'\].*\n/m, ""));
      expect(third.records).toHaveLength(29);
      expect(third.keysText).toMatch(/si_min: \{\n\s+table: 'sys_script_include'\n\s+id: '[0-9a-f]{32}'\n\s+deleted: true\n/);
      expect(third.keysText).toMatch(/bom_json: \{\n\s+table: 'sys_module'\n\s+id: 'c17be2dde3604b6cb7597d7e626ef325'\n\s+\}/);
    });
  });
});
