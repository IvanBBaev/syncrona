// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4: the data model as editable local records — the configuration half.
//
// These tests pin the opt-in (`dataModelTables`, empty by default), the stable
// naming rules attached to opted-in tables, the re-include of default-excluded
// tables, and the create/prune policy helpers.
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
import {
  DATA_MODEL_DEFAULT_TABLES,
  DATA_MODEL_NAME_FIELDS,
  DATA_MODEL_TABLES_WITHOUT_SCOPE,
  applyDataModelIncludes,
  applyDataModelTableOptions,
  getDataModelNameFields,
  getDataModelTables,
  isDataModelTable,
  isPruneDeniedTable,
  isScopelessDataModelTable,
  isValidDataModelTableName,
  nameFieldColumn,
} from "../dataModel.js";
import { getDefaultConfig, validateConfigShape } from "../config.js";

describe("dataModel configuration (R4)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("documents exactly the thirteen data-model tables", () => {
    expect([...DATA_MODEL_DEFAULT_TABLES]).toEqual([
      "sys_db_object",
      "sys_dictionary",
      "sys_dictionary_override",
      "sys_documentation",
      "sys_choice",
      "sys_properties",
      "sys_user_role",
      "sys_user_role_contains",
      "sys_security_acl",
      "sys_security_acl_role",
      "sys_scope_privilege",
      "sys_ui_policy",
      "sys_ui_policy_action",
    ]);
    expect(Object.isFrozen(DATA_MODEL_DEFAULT_TABLES)).toBe(true);
    // Every naming rule belongs to a documented table.
    for (const table of Object.keys(DATA_MODEL_NAME_FIELDS)) {
      expect(DATA_MODEL_DEFAULT_TABLES).toContain(table);
    }
  });

  it("names sys_choice as the one documented table without a scope column", () => {
    // sys_choice does not extend sys_metadata. Every other documented table
    // does, and is filtered by sys_scope.
    expect([...DATA_MODEL_TABLES_WITHOUT_SCOPE]).toEqual(["sys_choice"]);
    expect(Object.isFrozen(DATA_MODEL_TABLES_WITHOUT_SCOPE)).toBe(true);
    for (const table of DATA_MODEL_TABLES_WITHOUT_SCOPE) {
      expect(DATA_MODEL_DEFAULT_TABLES).toContain(table);
    }
    expect(isScopelessDataModelTable("sys_choice")).toBe(true);
    expect(isScopelessDataModelTable("sys_dictionary")).toBe(false);
    expect(isScopelessDataModelTable("sys_choice_set")).toBe(false);
    expect(isScopelessDataModelTable("x_demo_lookup")).toBe(false);
  });

  it("is opt-in: the default config tracks no data-model table", () => {
    expect(getDefaultConfig().dataModelTables).toEqual([]);
    expect(getDataModelTables(getDefaultConfig())).toEqual([]);
    expect(getDataModelTables(undefined)).toEqual([]);
    expect(getDataModelTables({ dataModelTables: "sys_choice" as unknown as string[] })).toEqual(
      []
    );
  });

  it("deduplicates the list and ignores entries that are not table names", () => {
    expect(
      getDataModelTables({
        dataModelTables: ["sys_choice", "sys_choice", "bad name", 42 as unknown as string, "x_a_b"],
      })
    ).toEqual(["sys_choice", "x_a_b"]);
    expect(isValidDataModelTableName("sys_dictionary")).toBe(true);
    expect(isValidDataModelTableName("sys_dictionary^ORname=x")).toBe(false);
    expect(isValidDataModelTableName("")).toBe(false);
    expect(isValidDataModelTableName(undefined)).toBe(false);
  });

  it("gives each ambiguous table its documented stable-name columns", () => {
    expect(getDataModelNameFields("sys_dictionary")).toEqual(["name", "element"]);
    expect(getDataModelNameFields("sys_choice")).toEqual(["name", "element", "value"]);
    expect(getDataModelNameFields("sys_documentation")).toEqual(["name", "element", "language"]);
    expect(getDataModelNameFields("sys_security_acl")).toEqual(["name", "operation.name"]);
    // A table whose display value is already unique has no rule.
    expect(getDataModelNameFields("sys_properties")).toBeUndefined();
    expect(getDataModelNameFields("__proto__")).toBeUndefined();
    expect(nameFieldColumn("operation.name")).toBe("operation");
    expect(nameFieldColumn("element")).toBe("element");
  });

  describe("applyDataModelTableOptions", () => {
    it("returns the options unchanged when nothing is opted in", () => {
      const tableOptions = { sys_script: { query: "active=true" } };
      expect(applyDataModelTableOptions({ tableOptions })).toBe(tableOptions);
      expect(applyDataModelTableOptions({})).toEqual({});
    });

    it("attaches the naming rule to opted-in tables only", () => {
      const out = applyDataModelTableOptions({
        dataModelTables: ["sys_dictionary", "sys_properties"],
        tableOptions: { sys_script: { query: "active=true" } },
      });
      expect(out.sys_dictionary).toEqual({ query: "", nameFields: ["name", "element"] });
      expect(out.sys_properties).toBeUndefined();
      expect(out.sys_script).toEqual({ query: "active=true" });
      expect(out.sys_choice).toBeUndefined();
    });

    it("keeps the table's own query and never overrides an operator's naming", () => {
      const out = applyDataModelTableOptions({
        dataModelTables: ["sys_dictionary", "sys_choice", "sys_security_acl"],
        tableOptions: {
          sys_dictionary: { query: "active=true" },
          sys_choice: { query: "", displayField: "label" },
          sys_security_acl: { query: "", nameFields: ["name"] },
        },
      });
      expect(out.sys_dictionary).toEqual({
        query: "active=true",
        nameFields: ["name", "element"],
      });
      expect(out.sys_choice).toEqual({ query: "", displayField: "label" });
      expect(out.sys_security_acl).toEqual({ query: "", nameFields: ["name"] });
    });
  });

  describe("applyDataModelIncludes", () => {
    it("re-includes opted-in tables, leaving an explicit choice alone", () => {
      const includes = { sys_choice: false, sys_dictionary: { calculation: { type: "js" } } };
      const out = applyDataModelIncludes({
        dataModelTables: ["sys_choice", "sys_dictionary", "sys_db_object"],
        includes: includes as unknown as Sync.TablePropMap,
      });
      expect(out.sys_db_object).toBe(true);
      expect(out.sys_choice).toBe(false);
      expect(out.sys_dictionary).toEqual({ calculation: { type: "js" } });
    });

    it("returns the includes unchanged when nothing is opted in", () => {
      const includes = { sys_choice: true };
      expect(applyDataModelIncludes({ includes })).toBe(includes);
      expect(applyDataModelIncludes({})).toEqual({});
    });
  });

  it("treats the documented tables and any opted-in table as data model", () => {
    expect(isDataModelTable("sys_dictionary", undefined)).toBe(true);
    expect(isDataModelTable("x_demo_table", { dataModelTables: ["x_demo_table"] })).toBe(true);
    expect(isDataModelTable("sys_script_include", { dataModelTables: [] })).toBe(false);
  });

  it("denies pruning every documented data-model table", () => {
    for (const table of DATA_MODEL_DEFAULT_TABLES) {
      expect(isPruneDeniedTable(table)).toBe(true);
    }
    expect(isPruneDeniedTable("sys_script_include")).toBe(false);
  });

  describe("config validation", () => {
    it("accepts a list of table names", () => {
      expect(() =>
        validateConfigShape({ dataModelTables: ["sys_dictionary", "sys_choice"] }, "sync.config.js")
      ).not.toThrow();
    });

    it("rejects a non-array value", () => {
      expect(() =>
        validateConfigShape({ dataModelTables: "sys_dictionary" }, "sync.config.js")
      ).toThrow(/dataModelTables/);
    });

    it("rejects entries that are not table names, naming them", () => {
      expect(() =>
        validateConfigShape(
          { dataModelTables: ["sys_dictionary", "sys choice", 7] },
          "sync.config.js"
        )
      ).toThrow(/"dataModelTables" must list table names.*"sys choice", 7/);
    });

    // SDK-F2
    it("accepts both data-model layouts", () => {
      for (const dataModelLayout of ["records", "composite"]) {
        expect(() => validateConfigShape({ dataModelLayout }, "sync.config.js")).not.toThrow();
      }
    });

    it("rejects an unknown data-model layout, naming the valid ones", () => {
      expect(() =>
        validateConfigShape({ dataModelLayout: "documents" }, "sync.config.js")
      ).toThrow(/"dataModelLayout" must be one of "records", "composite"; got "documents"/);
      expect(() => validateConfigShape({ dataModelLayout: 1 }, "sync.config.js")).toThrow(
        /dataModelLayout/
      );
    });
  });
});
