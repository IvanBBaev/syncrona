// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

/** `Table()` x_snc_bprobe_t with a `kind` column, which ChoiceSet() may target in a scoped app. */
const TABLE = "export const x_snc_bprobe_t = Table({ name: 'x_snc_bprobe_t', schema: { kind: StringColumn({ label: 'Kind' }) } })\n";
const set = (options: string) => `ChoiceSet({ table: 'x_snc_bprobe_t', field: 'state', ${options} })\n`;

describe("ChoiceSet()", () => {
  it("writes the set and its choices to the choice set file only", () => {
    const result = compile(TABLE + set("choices: { a: 'A', b: { label: 'B', dependentValue: 7, synonyms: ['x', 'y'] } }"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_choice")).toEqual([]);
    expect(only(result, "sys_choice_set")).toEqual([]);
    const file = result.files.find((f) => f.path === "author_elective_update/sys_choice_x_snc_bprobe_t_state.xml")!;
    expect(file.content).toContain("<sequence>1</sequence>");
    expect(file.content).toContain("<dependent_value>7</dependent_value>");
    expect(file.content).toContain("<synonyms>x,y</synonyms>");
    expect(file.content).toContain("<language>en</language>");
  });

  it("writes only the set without choices", () => {
    for (const options of ["", "choices: {}"]) {
      const result = compile(TABLE + set(options));
      expect(messages(result)).toEqual([]);
      const file = result.files.find((f) => f.path === "author_elective_update/sys_choice_x_snc_bprobe_t_state.xml")!;
      expect(file.content).toContain("<sys_choice_set ");
      expect(file.content).not.toContain("<sys_choice ");
    }
  });

  it("uses defaultLanguage for choices that name no language", () => {
    const result = compile(TABLE + set("choices: { a: 'A', b: { label: 'B' }, c: { label: 'C', language: 'fr' } }"), {}, { defaultLanguage: "de" });
    const file = result.files.find((f) => f.path.endsWith("_state.xml"))!.content;
    expect(file.match(/<language>(\w+)<\/language>/g)).toEqual(["<language>de</language>", "<language>de</language>", "<language>fr</language>"]);
  });

  it.each([
    [set("$id: Now.ID['c']"), "ChoiceSet() has no property '$id'."],
    [set("protectionPolicy: 'read'"), "ChoiceSet() has no property 'protectionPolicy'."],
    ["ChoiceSet({ table: '', field: 'state' })\n", "ChoiceSet(): 'table' must not be empty."],
    ["ChoiceSet({ table: 'x_snc_bprobe_t', field: '' })\n", "ChoiceSet(): 'field' must not be empty."],
    [set("choices: ['A']"), "ChoiceSet(): 'choices' must be an object."],
    [set("choices: { a: 1 }"), "ChoiceSet(): 'choices.a' must be a string, a choice object or an array of them."],
    [set("choices: { a: [{ label: 'A' }, 'B'] }"), "ChoiceSet(): 'choices.a[1]' must be a string, a choice object or an array of them."],
    [set("choices: { a: { label: 'A', dependentValue: true } }"), "ChoiceSet(): 'choices.a.dependentValue' must be a string or a number."],
    [set("choices: { a: { label: 'A', color: 'red' } }"), "ChoiceSet() has no property 'choices.a.color'."],
  ])("rejects %s", (source, message) => {
    const result = compile(TABLE + source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });

  it("reports a choice without a label and keeps compiling", () => {
    const result = compile(TABLE + set("choices: { a: { sequence: 1 }, b: [{ label: 'B' }, { hint: 'h', language: 'de' }] }"));
    expect(messages(result)).toEqual(["Choice 'a' is missing the required 'label' property.", "Choice 'b' is missing the required 'label' property."]);
    expect(result.files.find((f) => f.path.endsWith("_state.xml"))!.content.match(/<sys_choice /g)).toHaveLength(3);
  });

  it("refuses a legacyChoices other than true", () => {
    expect(messages(compile(TABLE + set(""), {}, { legacyChoices: false }))).toContain(
      "ChoiceSet(): now.config.json 'legacyChoices' other than true is not supported by the native compiler yet.",
    );
    expect(messages(compile(TABLE + set(""), {}, { legacyChoices: true }))).toEqual([]);
  });

  it("refuses a field the project defines", () => {
    const result = compile(TABLE + "ChoiceSet({ table: 'x_snc_bprobe_t', field: 'kind' })\n");
    expect(messages(result)).toEqual([
      "Field 'kind' is defined on 'x_snc_bprobe_t' which is owned by this project. Use inline choices in the Table API instead of ChoiceSet.",
    ]);
  });

  it("refuses a table outside a scoped app, but not in a global one", () => {
    const source = "ChoiceSet({ table: 'incident', field: 'state', choices: { 9: 'Nine' } })\n";
    expect(messages(compile(source))).toEqual([
      "ChoiceSet on table 'incident' is not allowed from scoped app 'x_snc_bprobe'. Only tables defined in your scope are allowed. Create a table in your scope that extends 'incident' and add choices to it.",
    ]);
    const global = compile(source, {}, { scope: "global" });
    expect(messages(global)).toEqual([]);
    expect(global.files.map((f) => f.path)).toEqual(["author_elective_update/sys_choice_incident_state.xml"]);
  });
});
