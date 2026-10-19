// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

/** A catalog item with `options` (the inside of the object literal), after `before`. */
const item = (options: string, before = "") => `${before}CatalogItem({ $id: Now.ID['ci'], name: 'I', ${options} })\n`;

const SET = (variables: string, id = "vs") => `const ${id} = VariableSet({ $id: Now.ID['${id}'], title: '${id}', variables: { ${variables} } })\n`;

describe("CatalogItem()", () => {
  it("writes the defaults of a minimal item", () => {
    const result = compile(item(""));
    expect(messages(result)).toEqual([]);
    const [fields] = only(result, "sc_cat_item");
    expect(fields).toMatchObject({
      active: "true",
      access_type: "restricted",
      availability: "on_desktop",
      delivery_time: "1970-01-01 00:00:00",
      display_price_property: "non_zero",
      fulfillment_automation_level: "unspecified",
      mobile_picture_type: "use_desktop_picture",
      request_method: "",
      type: "item",
    });
  });

  it("maps unknown enum values to the defaults", () => {
    const result = compile(item("availability: 'x', mobilePictureType: 'x', fulfillmentAutomationLevel: 'x'"));
    expect(only(result, "sc_cat_item")[0]).toMatchObject({
      availability: "on_desktop",
      mobile_picture_type: "use_desktop_picture",
      fulfillment_automation_level: "unspecified",
    });
  });

  it("references records of other calls", () => {
    const result = compile(
      item(
        "catalogs: [cat], categories: [cat], roles: [role], variableSets: [{ variableSet: vs }, { variableSet: '66666666666666666666666666666666', order: '' }]",
        "const cat = Record({ $id: Now.ID['cat'], table: 'sc_catalog', data: { title: 'C' } })\n" +
          "const role = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })\n" +
          SET("a: SingleLineTextVariable({})"),
      ),
    );
    expect(messages(result)).toEqual([]);
    const [fields] = only(result, "sc_cat_item");
    expect(fields.roles).toBe("x_snc_bprobe.r");
    expect(fields.sc_catalogs).toBe(fields.category);
    expect(only(result, "io_set_item").map((r) => r.order)).toEqual(["100", "100"]);
  });

  it.each([
    ["owner: 1", "CatalogItem(): 'owner' must hold sys_ids or records."],
    ["executionPlan: 1", "CatalogItem(): 'executionPlan' must hold sys_ids or records."],
    ["catalogs: [1]", "CatalogItem(): 'catalogs' must hold sys_ids or records."],
    ["deliveryPlanScript: 1", "CatalogItem(): 'deliveryPlanScript' must be a string."],
    ["variableSets: [1]", "CatalogItem(): 'variableSets[0]' must be an object."],
    ["variableSets: [{}]", "CatalogItem(): 'variableSets[0].variableSet' is required."],
    ["variableSets: [{ variableSet: 'x', order: 'y' }]", "CatalogItem(): 'variableSets[0].order' must be a number."],
    [
      "variableSets: [{ variableSet: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' }) }]",
      "CatalogItem(): 'variableSets[0].variableSet' must be a sys_id or a VariableSet().",
    ],
    ["deliveryTime: { weeks: 1 }", "CatalogItem() has no property 'deliveryTime.weeks'."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(item(options)))).toEqual([message]);
  });

  it("allows only one fulfillment method", () => {
    const result = compile(item("executionPlan: '', flow: 'a', workflow: Record({ $id: Now.ID['w'], table: 'wf_workflow', data: {} })"));
    expect(messages(result)).toEqual([
      "Only one of executionPlan, flow, or workflow can be specified. Found: flow, workflow. Remove the extra fields so that only one fulfillment method is configured.",
    ]);
  });

  it("requires catalogs for categories", () => {
    expect(messages(compile(item("categories: ['a']")))).toEqual([
      "'categories' requires 'catalogs' to also be specified. Categories can only be selected after the Catalogs field is populated.",
    ]);
    expect(messages(compile(item("categories: []")))).toEqual([]);
  });

  it.each([
    ["variables: { a: RequestedForVariable({}), b: RequestedForVariable({}) }", "", "Only one RequestedForVariable is allowed in a CatalogItem"],
    [
      "variableSets: [{ variableSet: vs }], variables: { a: RequestedForVariable({}) }",
      SET("b: RequestedForVariable({})"),
      "RequestedForVariable cannot be used in both CatalogItem variables and attached VariableSets. Remove RequestedForVariable from either the CatalogItem variables or the attached VariableSet.",
    ],
    [
      "variableSets: [{ variableSet: vs }, { variableSet: vs2 }]",
      SET("a: RequestedForVariable({})") + SET("b: RequestedForVariable({})", "vs2"),
      "RequestedForVariable cannot be used in multiple VariableSets attached to the same CatalogItem. Only one RequestedForVariable is allowed across all VariableSets.",
    ],
    [
      "variableSets: [{ variableSet: vs }], variables: { a: SingleLineTextVariable({}) }",
      SET("a: SingleLineTextVariable({})"),
      "Variable name conflict: 'a' is defined in both CatalogItem variables and an attached VariableSet. Each variable must have a unique name across the CatalogItem and all attached VariableSets.",
    ],
  ])("rejects variables %s", (options, before, message) => {
    expect(messages(compile(item(options, before)))).toEqual([message]);
  });

  describe("dependentQuestion", () => {
    const dependent = (target: string) => `d: SingleLineTextVariable({ dependentQuestion: '${target}' })`;

    it("resolves a variable of an opaque set by its name", () => {
      const result = compile(item(`variableSets: [{ variableSet: '66666666666666666666666666666666' }], variables: { ${dependent("x")} }`));
      expect(messages(result)).toEqual([]);
    });

    it("skips sets without the variable", () => {
      const result = compile(
        item(
          `variableSets: [{ variableSet: vs }, { variableSet: vs2 }], variables: { ${dependent("b")} }`,
          SET("a: SingleLineTextVariable({})") + SET("b: ReferenceVariable({ referenceTable: 'sys_user' })", "vs2"),
        ),
      );
      expect(messages(result)).toEqual([]);
    });

    it("rejects a set variable of the wrong type", () => {
      const result = compile(item(`variableSets: [{ variableSet: vs }], variables: { ${dependent("a")} }`, SET("a: LabelVariable({})")));
      expect(messages(result)).toHaveLength(1);
    });

    it("reports a variable found nowhere", () => {
      expect(messages(compile(item(`variables: { ${dependent("x")} }`)))).toEqual([
        "'dependentQuestion' references 'x' which does not exist in this catalog item's variables or any attached variableSets. If it belongs to a variable set, add that variable set to the variableSets array.",
      ]);
    });
  });
});
