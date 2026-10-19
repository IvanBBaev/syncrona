// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const map = (options: string) => `ImportSet({ $id: Now.ID['map'], ${options} })\n`;

describe("ImportSet()", () => {
  it("writes a map without tables, fields or scripts, and an unknown enforce option as No", () => {
    const result = compile(map("mapCoalesce: true, enforceMandatoryFields: 'sometimes' as any"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_transform_map")[0]).toMatchObject({ target_table: "", coalesce: "true", enforce_mandatory_fields: "No" });
    expect(result.records.map((r) => r.table)).toEqual(["sys_transform_map"]);
  });

  it("runs a transform script after each row by default", () => {
    const result = compile(map("scripts: [{ $id: Now.ID['s'] }]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_transform_script")[0]).toMatchObject({ when: "onAfter", active: "true", order: "100" });
  });

  it("hints at a source script that will not run and at a missing one", () => {
    const result = compile(
      map(`targetTable: 't', fields: { a: { sourceField: 'x', sourceScript: 's' }, b: { useSourceScript: true } }`),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([
      "Field 'a': 'sourceScript' has no effect when 'useSourceScript' is false. The script will be saved but will not run until 'useSourceScript' is set to true.",
      "Field 'b': No 'sourceScript' provided — the default transform entry script will be used. Add a 'sourceScript' to define the transformation logic.",
    ]);
    expect(only(result, "sys_transform_entry").map((r) => [r.target_field, r.use_source_script, r.source_field])).toEqual([
      ["a", "false", "x"],
      ["b", "true", ""],
    ]);
  });

  it.each([
    [map("script: 's'"), "Property 'script' cannot be used when 'runScript' is false or undefined. Remove the 'script' property or set 'runScript: true'."],
    [map("fields: 'a' as any"), "ImportSet(): 'fields' must be an object."],
    [map("fields: { a: 1 as any }"), "ImportSet(): 'fields.a' must be a source field name or a field mapping object."],
    [
      map("fields: { a: { coalesceCaseSensitive: true } }"),
      "Field 'a': Property 'coalesceCaseSensitive' cannot be used when 'coalesce' is false or undefined. Remove the 'coalesceCaseSensitive' property or set 'coalesce: true'.",
    ],
    [
      map("fields: { a: { coalesce: false, coalesceEmptyFields: true } }"),
      "Field 'a': Property 'coalesceEmptyFields' cannot be used when 'coalesce' is false or undefined. Remove the 'coalesceEmptyFields' property or set 'coalesce: true'.",
    ],
    [map("fields: { a: { source: 'x' } as any }"), "ImportSet() has no property 'fields.a.source'."],
    [map("scripts: [{ type: 'x' } as any]"), "ImportSet() has no property 'scripts[0].type'."],
  ])("rejects %s", (source, error) => {
    expect(messages(compile(source))).toEqual([error]);
  });
});
