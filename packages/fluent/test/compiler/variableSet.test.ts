// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

/** A variable set holding `variables` (the inside of the object literal). */
const set = (variables: string, options = "", before = "") =>
  `${before}VariableSet({ $id: Now.ID['vs'], title: 'S', ${options} variables: { ${variables} } })\n`;

describe("VariableSet()", () => {
  it("writes a set without variables as a single record", () => {
    const result = compile("VariableSet({ $id: Now.ID['vs'], title: '  My  Set! ' })\n");
    expect(messages(result)).toEqual([]);
    expect(result.records.map((r) => r.table)).toEqual(["item_option_new_set"]);
    expect(only(result, "item_option_new_set")[0].internal_name).toBe("my_set");
  });

  it.each([
    [
      "internalName: 'Bad-Name'",
      "VariableSet internalName must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (snake_case format). No spaces, hyphens, or uppercase letters allowed.",
    ],
    [`internalName: '${"a".repeat(81)}'`, "VariableSet internalName must be 80 characters or less. Current length: 81"],
    ["variables: 1", "VariableSet(): 'variables' must be an object."],
    ["variables: { a: 1 }", "VariableSet(): 'variables.a' must be a variable such as SingleLineTextVariable()."],
    ["variables: { a: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' }) }", "VariableSet(): 'variables.a' must be a variable such as SingleLineTextVariable()."],
    [
      "variables: { a: RequestedForVariable({}), b: RequestedForVariable({}) }",
      "Only one RequestedForVariable is allowed in a VariableSet",
    ],
    [
      "type: 'multiRow', variables: { a: LabelVariable({}) }",
      "Variable type 'LabelVariable' is not supported in multiRow variable sets. Variable 'a' cannot be used.",
    ],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`VariableSet({ $id: Now.ID['vs'], title: 'S', ${options} })\n`))).toEqual([message]);
  });

  it("allows a multi-row set's supported variables", () => {
    const result = compile(set("a: SingleLineTextVariable({}), b: RequestedForVariable({})", "type: 'multiRow',"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "item_option_new_set")[0].type).toBe("one_to_many");
  });
});

describe("catalog variables", () => {
  it("skips a variable without an options object", () => {
    const result = compile(set("a: SingleLineTextVariable(), b: SingleLineTextVariable(1)"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "item_option_new")).toEqual([]);
  });

  it("rejects a variable declared as a const", () => {
    const result = compile(set("a: v", "", "const v = SingleLineTextVariable({})\n"));
    expect(messages(result)).toEqual([
      "Variable 'a' must be declared inline inside 'variables: {...}'. A direct reference to a variable const (e.g. a: someVariableConst) is not supported.",
    ]);
  });

  it.each([
    ["SingleLineTextVariable({ mapToField: true })", "'field' is required when 'mapToField' is true. Specify the field to map to."],
    ["SingleLineTextVariable({ mapToField: true, field: '' })", "'field' is required when 'mapToField' is true. Specify the field to map to."],
    [
      "CheckboxVariable({ selectionRequired: true, readOnly: true })",
      "'selectionRequired' cannot be true when 'readOnly' is true. A checkbox cannot be both required and read-only.",
    ],
    [
      "CheckboxVariable({ selectionRequired: true, hidden: true })",
      "'selectionRequired' cannot be true when 'hidden' is true. A checkbox cannot be both required and hidden.",
    ],
    [
      "SingleLineTextVariable({ mandatory: true, readOnly: true })",
      "'mandatory' cannot be true when 'readOnly' is true. A field cannot be both required and read-only.",
    ],
    [
      "SingleLineTextVariable({ mandatory: true, hidden: true })",
      "'mandatory' cannot be true when 'hidden' is true. A field cannot be both required and hidden.",
    ],
    [
      "LookupSelectBoxVariable({ lookupSource: 'choices', lookupFromTable: 't' })",
      "'lookupFromTable' should not be specified when 'lookupSource' is 'choices'.",
    ],
    [
      "LookupSelectBoxVariable({ lookupSource: 'choices', lookupValueField: 'f' })",
      "'lookupValueField' should not be specified when 'lookupSource' is 'choices'.",
    ],
    ["LookupMultipleChoiceVariable({})", "'lookupFromTable' is required when 'lookupSource' is not 'choices'."],
    [
      "LookupSelectBoxVariable({ lookupSource: 'table', lookupFromTable: 't' })",
      "'lookupValueField' is required when 'lookupSource' is not 'choices'.",
    ],
    [
      "ReferenceVariable({ useReferenceQualifier: 'simple' })",
      "ReferenceVariable: 'referenceQualCondition' is required when 'useReferenceQualifier' is 'simple'.",
    ],
    [
      "RequestedForVariable({ useReferenceQualifier: '' })",
      "RequestedForVariable: 'referenceQualCondition' is required when 'useReferenceQualifier' is 'simple'.",
    ],
    [
      "ReferenceVariable({ useReferenceQualifier: 'dynamic' })",
      "ReferenceVariable: 'dynamicRefQual' is required when 'useReferenceQualifier' is 'dynamic'.",
    ],
    [
      "ReferenceVariable({ useReferenceQualifier: 'advanced' })",
      "ReferenceVariable: 'referenceQual' is required when 'useReferenceQualifier' is 'advanced'.",
    ],
    ["SelectBoxVariable({ choices: 1 })", "SelectBoxVariable(): 'choices' must be an object."],
    ["SingleLineTextVariable({ bogus: 1 })", "SingleLineTextVariable() has no property 'bogus'."],
  ])("checks %s", (variable, message) => {
    expect(messages(compile(set(`a: ${variable}`)))).toEqual([message]);
  });

  it.each([
    "LabelVariable({ mapToField: false, mandatory: true, readOnly: true })",
    "BreakVariable({ mapToField: true })",
    "CheckboxVariable({ selectionRequired: false, readOnly: true })",
    "LookupSelectBoxVariable({ lookupSource: 'choices' })",
    "LookupSelectBoxVariable({ lookupFromTable: 't', lookupValueField: 'f' })",
    "ReferenceVariable({})",
    "ReferenceVariable({ useReferenceQualifier: 'simple', referenceQualCondition: 'active=true' })",
    "ReferenceVariable({ useReferenceQualifier: 'dynamic', dynamicRefQual: 'abc' })",
    "ReferenceVariable({ useReferenceQualifier: 'advanced', referenceQual: 'javascript:x()' })",
    "ReferenceVariable({ useReferenceQualifier: 'other' })",
  ])("accepts %s", (variable) => {
    expect(messages(compile(set(`a: ${variable}`)))).toEqual([]);
  });

  it("writes the per-type defaults", () => {
    const result = compile(
      set(
        "a: MaskedVariable({}), b: MaskedVariable({ useEncryption: false }), c: SingleLineTextVariable({ visibility: 'Nowhere' }), " +
          "d: SingleLineTextVariable({ visibility: 3 as any, defaultValue: 5 }), e: CheckboxVariable({ selectionRequired: true })",
      ),
    );
    expect(messages(result)).toEqual([]);
    const rows = Object.fromEntries(only(result, "item_option_new").map((r) => [r.name, r]));
    expect([rows.a.mask_use_encryption, rows.b.mask_use_encryption, rows.c.mask_use_encryption]).toEqual(["true", "false", "false"]);
    expect([rows.c.visibility, rows.d.visibility, rows.d.default_value]).toEqual(["1", "1", "5"]);
    expect(rows.e.mandatory).toBe("true");
  });

  it("labels a choice with its value when it has no label", () => {
    const result = compile(set("a: SelectBoxVariable({ choices: { x: {}, y: { label: 'Why' } } })"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "question_choice").map((r) => r.text)).toEqual(["x", "Why"]);
  });

  it("takes a Record() as the dynamic reference qualifier", () => {
    const result = compile(
      set(
        "a: ReferenceVariable({ useReferenceQualifier: 'dynamic', dynamicRefQual: Record({ $id: Now.ID['q'], table: 'sys_filter_option_dynamic', data: { name: 'Q' } }) })",
      ),
    );
    expect(messages(result)).toEqual([]);
    const [qual] = only(result, "sys_filter_option_dynamic");
    expect(only(result, "item_option_new")[0].dynamic_ref_qual).toBe(qual.sys_id);
  });

  describe("dependentQuestion", () => {
    const field = (result: ReturnType<typeof compile>, name: string) =>
      only(result, "item_option_new").find((r) => r.name === name)!.dynamic_value_field;

    it("points at an earlier or a later reference variable, or keeps a sys_id", () => {
      const result = compile(
        set(
          "early: SingleLineTextVariable({ dependentQuestion: 'who' }), who: RequestedForVariable({}), " +
            "late: SingleLineTextVariable({ dependentQuestion: 'who' }), raw: SingleLineTextVariable({ dependentQuestion: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), " +
            "none: SingleLineTextVariable({ dependentQuestion: '' })",
        ),
      );
      expect(messages(result)).toEqual([]);
      const who = only(result, "item_option_new").find((r) => r.name === "who")!.sys_id;
      expect([field(result, "early"), field(result, "late")]).toEqual([who, who]);
      expect(field(result, "raw")).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(field(result, "none")).toBe("");
    });

    it.each([
      [
        "dependentQuestion: SingleLineTextVariable({})",
        "'dependentQuestion' must be a string variable name (e.g. 'requestedFor') or a dot-walk into a variable set's variables (e.g. employeeSet.variables.requestedFor) referencing 'a'. A direct reference to a variable const is not supported.",
      ],
      [
        "dependentQuestion: 1",
        "'dependentQuestion' for 'a' must be a string variable name (e.g. 'requestedFor') or a dot-walk into a variable set's variables (e.g. employeeSet.variables.requestedFor).",
      ],
      [
        "dependentQuestion: 'b'",
        "'dependentQuestion' references 'b' which is not a valid parent type. Only ReferenceVariable and RequestedForVariable are supported.",
      ],
      ["dependentQuestion: 'nope'", "'dependentQuestion' references 'nope' which does not exist in this variable set's variables."],
    ])("rejects %s", (options, message) => {
      expect(messages(compile(set(`a: SingleLineTextVariable({ ${options} }), b: SingleLineTextVariable({})`)))).toEqual([message]);
    });
  });
});
