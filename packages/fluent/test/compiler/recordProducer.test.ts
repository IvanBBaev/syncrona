// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

/** A record producer with `options` (the inside of the object literal), after `before`. */
const producer = (options: string, before = "") =>
  `${before}CatalogItemRecordProducer({ $id: Now.ID['rp'], name: 'P', ${options} })\n`;

const TABLE =
  "export const x_snc_bprobe_t = Table({ name: 'x_snc_bprobe_t', schema: { a: StringColumn({ label: 'A' }), b: StringColumn({ label: 'B' }) } })\n";

describe("CatalogItemRecordProducer()", () => {
  it("writes the defaults of a producer on a named table", () => {
    const result = compile(producer("table: 'incident', redirectUrl: 'x'"));
    expect(messages(result)).toEqual([]);
    const [fields] = only(result, "sc_cat_item_producer");
    expect(fields).toMatchObject({
      access_type: "restricted",
      allow_edit: "false",
      can_cancel: "false",
      redirect_url: "generated_record",
      save_options: "",
      table_name: "incident",
    });
  });

  it("names the target table on its variables", () => {
    const result = compile(
      producer(
        "table: 'incident', variables: { a: SingleLineTextVariable({}), b: SingleLineTextVariable() }",
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(
      only(result, "item_option_new").map((r) => r.record_producer_table),
    ).toEqual(["incident"]);
  });

  it.each([
    ["", "CatalogItemRecordProducer(): 'table' is required."],
    [
      "table: 1",
      "CatalogItemRecordProducer(): 'table' must be a table name or a Table().",
    ],
    [
      "table: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })",
      "CatalogItemRecordProducer(): 'table' must be a table name or a Table().",
    ],
    [
      "table: 'incident', script: 1",
      "CatalogItemRecordProducer(): 'script' must be a string.",
    ],
    [
      "table: 'incident', accessType: 'restricted'",
      "CatalogItemRecordProducer() has no property 'accessType'.",
    ],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(producer(options)))).toEqual([message]);
  });

  it("uses the RecordProducer context in variable conflicts", () => {
    const result = compile(
      producer(
        "table: 'incident', variables: { a: RequestedForVariable({}), b: RequestedForVariable({}) }",
      ),
    );
    expect(messages(result)).toEqual([
      "Only one RequestedForVariable is allowed in a RecordProducer",
    ]);
  });

  describe("mapped fields", () => {
    const mapped = (table: string, variables: string) =>
      messages(
        compile(
          producer(`table: ${table}, variables: { ${variables} }`, TABLE),
        ),
      );
    const map = (field: string) =>
      `SingleLineTextVariable({ mapToField: true, field: '${field}' })`;

    it("accepts the columns of the Table() once each", () => {
      expect(
        mapped(
          "x_snc_bprobe_t",
          `x: ${map("a")}, y: ${map("b")}, z: SingleLineTextVariable({ mapToField: false, field: 'a' })`,
        ),
      ).toEqual([]);
    });

    it("rejects a field outside the Table()", () => {
      expect(
        mapped("x_snc_bprobe_t", `x: ${map("c")}, y: ${map("d")}`),
      ).toEqual([
        "RecordProducer variable 'x': field 'c' does not belong to the target table. Valid fields are: a, b.",
      ]);
    });

    it("rejects a field mapped twice, also on a named table", () => {
      expect(
        mapped("'incident'", `x: ${map("c")}, y: ${map("c")}, z: ${map("c")}`),
      ).toEqual([
        "RecordProducer variable 'y': field 'c' is already mapped by variable 'x'. Each table field can only be mapped by one variable.",
      ]);
    });

    it("skips the column check on a Table() without columns", () => {
      const before =
        "export const x_snc_bprobe_t = Table({ name: 'x_snc_bprobe_t', schema: {} })\n";
      expect(
        messages(
          compile(
            producer(
              `table: x_snc_bprobe_t, variables: { x: ${map("c")} }`,
              before,
            ),
          ),
        ),
      ).toEqual([]);
    });
  });
});
