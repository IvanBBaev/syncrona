// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const SOURCES =
  "export const ci = CatalogItem({ $id: Now.ID['ci'], name: 'I', variables: { a: SingleLineTextVariable({ question: 'A' }) } })\n";

/** A catalog client script with `options` (the inside of the object literal). */
const script = (options: string) =>
  `${SOURCES}CatalogClientScript({ $id: Now.ID['cs'], name: 'C', script: 'function f() {}', ${options} })\n`;

describe("CatalogClientScript()", () => {
  it("writes the SDK's defaults, without an order", () => {
    const result = compile(script(""));
    expect(messages(result)).toEqual([]);
    const [fields] = only(result, "catalog_script_client");
    expect(fields).toMatchObject({ type: "", applies_to: "item", cat_item: "", cat_variable: "", ui_type: "10", va_supported: "false" });
    expect(fields.order).toBeUndefined();
  });

  it("names the variable of an onChange script", () => {
    const result = compile(script("catalogItem: ci, type: 'onChange', variableName: ci.variables.a, order: 3"));
    expect(messages(result)).toEqual([]);
    const id = only(result, "item_option_new")[0].sys_id;
    expect(only(result, "catalog_script_client")[0]).toMatchObject({ cat_variable: `IO:${id}`, order: "3" });
  });

  it("ignores the variable of any other script", () => {
    const result = compile(script("type: 'onLoad', variableName: 1"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "catalog_script_client")[0].cat_variable).toBe("");
  });

  it.each([
    [
      "catalogItem: ci, variableSet: '0123456789abcdef0123456789abcdef'",
      "CatalogClientScript: 'catalogItem' and 'variableSet' are mutually exclusive. Specify only one. When appliesTo is 'set', use variableSet; when 'item', use catalogItem.",
    ],
    [
      "type: 'onChange', variableName: true",
      "CatalogClientScript(): 'variableName' must be a variable name or a variable reference.",
    ],
    ["script: 1", "CatalogClientScript(): 'script' must be a string."],
  ])("checks %s", (options, message) => {
    expect(messages(compile(script(options)))).toEqual([message]);
  });
});
