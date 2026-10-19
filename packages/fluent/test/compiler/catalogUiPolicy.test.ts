// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const SOURCES = `export const vs = VariableSet({ $id: Now.ID['vs'], title: 'S', variables: { s: SingleLineTextVariable({ question: 'S' }) } })
export const other = VariableSet({ $id: Now.ID['vs2'], title: 'O', variables: { o: SingleLineTextVariable({ question: 'O' }) } })
export const ci = CatalogItem({ $id: Now.ID['ci'], name: 'I', variables: { a: SingleLineTextVariable({ question: 'A' }) } })
export const attached = CatalogItem({ $id: Now.ID['ci2'], name: 'J', variableSets: [{ variableSet: vs, order: 1 }] })
`;

/** A catalog UI policy with `options` (the inside of the object literal), after the sources above. */
const policy = (options: string) =>
  `${SOURCES}CatalogUiPolicy({ $id: Now.ID['p'], shortDescription: 'P', ${options} })\n`;

const fieldsOf = (options: string) => {
  const result = compile(policy(options));
  expect(messages(result)).toEqual([]);
  return result;
};

const idOf = (result: ReturnType<typeof compile>, table: string, name: string) =>
  only(result, table).find((r) => r.name === name)!.sys_id;

describe("CatalogUiPolicy()", () => {
  it("writes the SDK's defaults", () => {
    const [fields] = only(fieldsOf(""), "catalog_ui_policy");
    expect(fields).toMatchObject({
      catalog_item: "",
      variable_set: "",
      applies_to: "item",
      catalog_conditions: "",
      script_true: "function onCondition() {\n\n}",
      ui_type: "10",
      order: "100",
      va_supported: "true",
    });
  });

  it.each([
    ["runScriptsInUiType: 'desktop'", "0"],
    ["runScriptsInUiType: 'mobileOrServicePortal'", "1"],
    ["runScriptsInUiType: 'other'", "10"],
    ["runScriptsInUiType: ''", "10"],
  ])("maps %s to its ui_type", (options, uiType) => {
    expect(only(fieldsOf(options), "catalog_ui_policy")[0].ui_type).toBe(uiType);
  });

  it.each([
    ["catalogCondition: ''", ""],
    ["catalogCondition: 'a=1^ORb=2^NQc=3'", "IO:a=1^ORIO:b=2^NQIO:c=3^EQ"],
    // The SDK's regex prefixes every later term again, even one that has its IO: already.
    ["catalogCondition: 'IO:a=1^IO:b=2^EQ'", "IO:a=1^IO:IO:b=2^EQ"],
    ["catalogCondition: `x${'s'}=${1}^${true}`", "xs=1^true"],
    ["catalogCondition: `${ci.variables.missing}=1`", "IO:missing=1"],
  ])("writes %s as catalog_conditions", (options, conditions) => {
    expect(only(fieldsOf(`catalogItem: ci, ${options}`), "catalog_ui_policy")[0].catalog_conditions).toBe(conditions);
  });

  it("writes an interpolated variable as its IO: reference", () => {
    const result = fieldsOf("catalogItem: ci, catalogCondition: `${ci.variables.a}=x^EQ`");
    const id = idOf(result, "item_option_new", "a");
    expect(only(result, "catalog_ui_policy")[0].catalog_conditions).toBe(`IO:${id}=x^EQ`);
  });

  it("writes the actions with the SDK's defaults and mappings", () => {
    const result = fieldsOf(
      "catalogItem: ci, actions: [{ variableName: ci.variables.a, valueAction: 'clearValue' }, { variableName: 'b', variable: 'v', valueAction: 'unknown' }, { visible: false }]",
    );
    const id = idOf(result, "item_option_new", "a");
    expect(only(result, "catalog_ui_policy_action")).toEqual([
      expect.objectContaining({
        catalog_variable: `IO:${id}`,
        variable: "a",
        visible: "ignore",
        disabled: "ignore",
        mandatory: "ignore",
        value_action: "clear_value",
        field_message_type: "none",
      }),
      expect.objectContaining({ catalog_variable: "IO:b", variable: "v", value_action: "ignore" }),
      expect.objectContaining({ catalog_variable: "", variable: "", visible: "false", value_action: "ignore" }),
    ]);
  });

  it.each([
    [
      "catalogItem: ci, variableSet: vs",
      "CatalogUiPolicy: 'catalogItem' and 'variableSet' are mutually exclusive. Specify only one. When appliesTo is 'set', use variableSet; when 'item', use catalogItem.",
    ],
    [
      "appliesTo: 'set', catalogItem: ci",
      "CatalogUiPolicy: 'catalogItem' should not be specified when appliesTo is 'set'. Use 'variableSet' instead.",
    ],
    [
      "appliesTo: 'item', variableSet: vs",
      "CatalogUiPolicy: 'variableSet' should not be specified when appliesTo is 'item'. Use 'catalogItem' instead.",
    ],
    ["catalogItem: 1", "CatalogUiPolicy(): 'catalogItem' must hold sys_ids or records."],
    [
      "catalogItem: ci, catalogCondition: `${[1]}`",
      "CatalogUiPolicy(): 'catalogCondition' can only interpolate variables, strings, numbers and booleans.",
    ],
    ["catalogCondition: 1", "CatalogUiPolicy(): 'catalogCondition' must be a string."],
    ["appliesTo: 'set', variableSet: vs, catalogCondition: `${ci.variables.a}=1`", "Variable is not in the variable set"],
    ["catalogItem: attached, catalogCondition: `${other.variables.o}=1`", ""],
    ["catalogItem: ci, catalogCondition: `${vs.variables.s}=1`", "Variable is not in the catalog item"],
    [
      "actions: [{ variableName: 'a', variableMessageType: 'info' }]",
      "'variableMessage' is required when 'variableMessageType' is specified. Provide a message to display on the field.",
    ],
    [
      "actions: [{ variableName: 'a', variableMessage: 'm', variableMessageType: '' }]",
      "'variableMessageType' is required when 'variableMessage' is specified. Provide a message type (info, warning, or error).",
    ],
    [
      "actions: [{ variableName: 1 }]",
      "CatalogUiPolicy(): 'actions[0].variableName' must be a variable name or a variable reference.",
    ],
    ["actions: [{ name: 'a' }]", "CatalogUiPolicy() has no property 'actions[0].name'."],
  ])("checks %s", (options, message) => {
    expect(messages(compile(policy(options)))).toEqual(message ? [message] : []);
  });

  it("reports a duplicate variable, whose coalesced action then collides", () => {
    expect(messages(compile(policy("actions: [{ variableName: 'a' }, { variableName: 'b' }, { variableName: 'a' }]")))).toEqual([
      "Duplicate variableName 'a' found in actions. Each action must have a unique variableName.",
      expect.stringContaining("is defined 2 times in the project"),
    ]);
  });

  it("checks variables only against a target bound to a const", () => {
    expect(
      messages(
        compile(
          policy("catalogItem: '0123456789abcdef0123456789abcdef', actions: [{ variableName: vs.variables.s, variableMessage: 'm', variableMessageType: 'info' }]"),
        ),
      ),
    ).toEqual([]);
  });
});
