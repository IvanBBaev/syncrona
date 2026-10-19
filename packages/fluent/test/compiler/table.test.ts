// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";
import { generateLabel, generatePlural, startCase, stripPrefix } from "../../src/compiler/artefacts/labels";
import type { CompileFluentResult } from "../../src/compiler/compile";

const T = "x_snc_bprobe_t";

/** `export const x_snc_bprobe_t = Table({ name, schema, ...options })`. */
function table(options = "", schema = "", name = T): string {
  return `export const ${name} = Table({ name: '${name}', schema: { ${schema} }, ${options} })\n`;
}

function file(result: CompileFluentResult, path: string): string {
  const found = result.files.find((f) => f.path === path);
  if (!found) throw new Error(`no ${path} in ${result.files.map((f) => f.path).join(", ")}`);
  return found.content;
}

describe("Table()", () => {
  describe("labels", () => {
    it.each([
      ["x_snc_bprobe_cost_center", "Bprobe Cost Center"],
      ["u_cmdb_ci_url", "CMDB CI URL"],
      ["sn_hr_case", "HR Case"],
      ["x_bare", "Bare"],
      ["plain", "Plain"],
      ["x_acme_v2Item", "V 2 Item"],
    ])("labels %s as %s", (name, label) => {
      expect(generateLabel(name)).toBe(label);
    });

    it("strips prefixes", () => {
      expect(stripPrefix("x_acme")).toBe("acme");
    });

    it("splits words the way lodash startCase does", () => {
      expect(startCase("fooBar_BAZQux 1st it's")).toBe("Foo Bar BAZ Qux 1st Its");
      expect(startCase("__")).toBe("");
    });

    it.each([
      ["Status", "Status"],
      ["Category", "Categories"],
      ["Box", "Boxes"],
      ["Task", "Tasks"],
    ])("pluralizes %s as %s", (label, plural) => {
      expect(generatePlural(label)).toBe(plural);
    });
  });

  describe("validation", () => {
    it.each([
      [table("", "", "x_snc_bprobe_T_"), "Table name must only contain lowercase letters, numbers, and underscores and end with a letter or number"],
      [table("", "", "x_other_t"), "'name' property should start with scope prefix 'x_snc_bprobe_'"],
      [`const ${T} = Table({ name: '${T}', schema: {} })\n`, `Table definition should be exported as a named export with the name '${T}'`],
      [`export const other = Table({ name: '${T}', schema: {} })\n`, `Table definition should be exported as a named export with the name '${T}'`],
      [`Table({ name: '${T}', schema: {} })\n`, `Table definition should be exported as a named export with the name '${T}'`],
      [table("", "'Bad': StringColumn({})"), "Column name must only contain lowercase letters, numbers, and underscores"],
      [table("", "a: 1"), "Invalid column in table schema"],
      [table("", "a: Role({ name: 'x_snc_bprobe.r' })"), "Invalid column in table schema"],
      [table("", "a: OverrideColumn({})"), "Table(): OverrideColumn() is not supported by the native compiler yet."],
      [table("", "a: StringColumn()"), "StringColumn() takes one options object."],
      [`export const ${T} = Table({ name: '${T}' })\n`, "Table(): 'schema' is required."],
      [`export const ${T} = Table({ name: '${T}', schema: 1 })\n`, "Table(): 'schema' must be an object."],
      [table("augments: {}"), "Table(): 'augments' is not supported by the native compiler yet."],
      [table("index: []"), "Table(): 'index' is not supported by the native compiler yet."],
      [table("autoNumber: {}"), "Table(): 'autoNumber' is not supported by the native compiler yet."],
      [table("licensingConfig: {}"), "Table(): 'licensingConfig' is not supported by the native compiler yet."],
      [table("dbObjectId: true"), "Table(): 'dbObjectId' is not supported by the native compiler yet."],
      [table("extends: 1"), "Table(): 'extends' must be a table name or a Table()."],
      [table("extends: Role({ name: 'x_snc_bprobe.r' })"), "Table(): 'extends' must be a table name or a Table()."],
      [table("userRole: 1"), "Table(): 'userRole' must be a role name or a Role()."],
      [table("", "a: StringColumn({ dynamicValueDefinitions: {} })"), "StringColumn(): 'dynamicValueDefinitions' is not supported by the native compiler yet."],
      [table("", "a: GenericColumn({})"), "GenericColumn(): 'schema.a.columnType' is required."],
      [table("", "a: ChoiceColumn({ dropdown: 'big' })"), "ChoiceColumn(): 'dropdown' must be one of 'none', 'dropdown_with_none', 'suggestion', 'dropdown_without_none'."],
      [table("", "a: StringColumn({ maxLength: true })"), "StringColumn(): 'maxLength' must be a string or a number."],
      [table("", "a: StringColumn({ default: [1] })"), "StringColumn(): an array 'default' is not supported by the native compiler yet."],
      [table("", "a: StringColumn({ default: {} })"), "StringColumn(): 'default' must be a string, number or boolean."],
      [table("", "a: StringColumn({ readOnlyOption: 'read_only', readOnly: false })"), "readOnly cannot be false with readOnlyOption read_only."],
      [table("", "a: StringColumn({ attributes: 1 })"), "StringColumn(): 'attributes' must be an object."],
      [table("", "a: StringColumn({ attributes: { x: [] } })"), "StringColumn(): 'attributes.x' must be a string, number or boolean."],
      [table("", "a: StringColumn({ label: 1 })"), "StringColumn(): 'schema.a.label' must be a string or an array of label entries."],
      [table("", "a: StringColumn({ label: ['A'] })"), "StringColumn(): 'schema.a.label[0]' must be an object."],
      [table("", "a: StringColumn({ label: [{ label: 'A', language: 'not a tag!' }] })"), expect.stringContaining("BCP 47")],
      [table("", "a: ChoiceColumn({ choices: 1 })"), "ChoiceColumn(): 'choices' must be an object."],
      [table("", "a: ChoiceColumn({ choices: { x: 1 } })"), "ChoiceColumn(): 'choices.x' must be a string or a choice object."],
      [table("", "a: ChoiceColumn({ choices: { x: { label: 'X', language: 'bad tag!' } } })"), expect.stringContaining("BCP 47")],
    ])("rejects %s", (source, message) => {
      const result = compile(source);
      expect(messages(result)).toEqual([message]);
      expect(result.ok).toBe(false);
    });

    // The duplicates also share a sys_id, which the conflict check reports too.
    it.each([
      [table("", "a: StringColumn({ label: [{ label: 'A' }, { label: 'B', language: 'en' }] })"), "Duplicate language 'en' found. Each language must be unique per label entry."],
      [
        table("", "a: ChoiceColumn({ choices: { x: [{ label: 'X' }, { label: 'Y', language: 'en' }] } })"),
        "Duplicate entry for choice value 'x': language 'en' is already used. Each (language, dependentValue) combination must be unique per choice value.",
      ],
      [
        table("", "a: ChoiceColumn({ choices: { x: [{ label: 'X', dependentValue: 'd' }, { label: 'Y', dependentValue: 'd' }] } })"),
        "Duplicate entry for choice value 'x' with dependentValue 'd': language 'en' is already used. Each (language, dependentValue) combination must be unique per choice value.",
      ],
    ])("rejects duplicate languages in %s", (source, message) => {
      expect(messages(compile(source))).toContain(message);
    });

    it("requires unprefixed columns of an unprefixed table to carry the scope prefix", () => {
      const result = compile(table("", "a: StringColumn({}), x_snc_bprobe_b: StringColumn({})", "sys_x"));
      expect(messages(result)).toEqual(
        expect.arrayContaining(["Column name should be prefixed with scope 'x_snc_bprobe_' if table name does not contain prefix"]),
      );
    });

    it("skips the column prefix check when the name is cast", () => {
      const result = compile(`export const sys_x = Table({ name: 'sys_x' as any, schema: { a: StringColumn({}) } })\n`);
      expect(messages(result)).toEqual([]);
    });

    it("applies the custom prefix rules in the global scope", () => {
      const global = { scope: "global", scopeId: "global" };
      expect(messages(compile(table("", "a: StringColumn({})", "incident"), {}, global))).toEqual([
        "Global table 'name' property should start with custom prefix 'u_'",
        "Column name should be prefixed with 'u_' custom prefix if table name does not contain this prefix, such as when adding columns to an existing global table",
      ]);
      expect(messages(compile(table("", "u_a: StringColumn({})", "incident"), {}, global))).toEqual([]);
      expect(messages(compile(table("", "a: StringColumn({})", "u_t"), {}, global))).toEqual([]);
    });

    it("leaves ServiceNow scopes unprefixed", () => {
      const result = compile(table("", "a: StringColumn({ mtom: 'x' })", "cmdb_x"), {}, { scope: "sn_x", scopeId: "0".repeat(32) });
      expect(messages(result)).toEqual([]);
      expect(file(result, "dictionary/cmdb_x.xml")).toContain('mtom="x"');
    });
  });

  describe("records", () => {
    it("writes the table, its collection and its documentation", () => {
      const result = compile(
        table(
          `label: 'Thing', extensible: true, accessibleFrom: 'package_private', callerAccess: 'restricted',
           allowWebServiceAccess: true, allowNewFields: false, attributes: { a: 1, b: 'x' }, audit: true,
           readOnly: true, sizeClass: 4, textIndex: true, liveFeed: true, scriptableTable: true,
           createAccessControls: true, userRole: 'x_snc_bprobe.user', actions: { read: true, delete: false }`,
          "title: StringColumn({})",
        ),
      );
      expect(messages(result)).toEqual([]);
      const [db] = only(result, "sys_db_object");
      expect(db).toMatchObject({
        name: T,
        label: "Thing",
        is_extendable: "true",
        access: "package_private",
        caller_access: "2",
        ws_access: "true",
        alter_access: "false",
        read_access: "true",
        delete_access: "false",
        live_feed_enabled: "true",
        scriptable_table: "true",
        create_access_controls: "true",
        "user_role@name": "x_snc_bprobe.user",
      });
      expect(db).not.toHaveProperty("update_access");
      const collection = only(result, "sys_dictionary").find((d) => d.internal_type === "collection")!;
      expect(collection).toMatchObject({ attributes: "a=1,b=x", audit: "true", read_only: "true", sizeclass: "4", text_index: "true" });
      expect(only(result, "sys_documentation").map((d) => d.label)).toEqual(expect.arrayContaining(["Thing", "Title"]));
      expect(result.records.some((r) => r.table === "ua_table_licensing_config")).toBe(false);
    });

    it("derives the label and leaves callerAccess 'none' and an empty userRole out", () => {
      const result = compile(table("callerAccess: 'none', userRole: '', attributes: 'x'"));
      const [db] = only(result, "sys_db_object");
      expect(db.label).toBe("Bprobe T");
      expect(db.caller_access).toBeUndefined();
      expect(db.user_role).toBeUndefined();
      expect(only(result, "sys_dictionary")[0].attributes).toBeUndefined();
    });

    it("writes a restricting callerAccess to the record and the dictionary file", () => {
      const result = compile(table("callerAccess: 'tracking', extensible: true as boolean"));
      expect(only(result, "sys_db_object")[0]).toMatchObject({ caller_access: "1", is_extendable: "true" });
      expect(file(result, `dictionary/${T}.xml`)).toContain('caller_access="1"');
    });

    it("derives the label when no entry is in the default language", () => {
      const result = compile(table("label: [{ label: 'B', language: 'de' }]"));
      expect(only(result, "sys_db_object")[0].label).toBe("Bprobe T");
    });

    it("leaves the documentation attributes out of the dictionary file for a label in several languages", () => {
      const result = compile(table("label: [{ label: 'A', plural: 'As', hint: 'h' }, { label: 'B', language: 'de' }]"));
      const xml = file(result, `dictionary/${T}.xml`);
      expect(xml).toContain('label="A"');
      expect(xml).not.toContain("plural=");
      expect(xml).not.toContain("hint=");
    });

    it("takes the user role from a Role()", () => {
      const result = compile(`const r = Role({ name: 'x_snc_bprobe.r' })\n` + table("userRole: r"));
      expect(only(result, "sys_db_object")[0]).toHaveProperty("user_role");
      expect(messages(result)).toEqual([]);
    });

    it("writes the deprecated array actions as flags with a hint", () => {
      const result = compile(table("actions: ['read', 'create', 1]"));
      expect(messages(result, "hint")).toEqual([expect.stringContaining("Passing 'actions' as an array is deprecated")]);
      expect(only(result, "sys_db_object")[0]).toMatchObject({
        read_access: "true",
        create_access: "true",
        update_access: "false",
        delete_access: "false",
      });
    });

    it("extends a Table() and writes the parent's name to the dictionary file", () => {
      const result = compile(
        table("extensible: true", "", "x_snc_bprobe_base") + table("extends: x_snc_bprobe_base, display: 'a'", "a: StringColumn({})"),
      );
      expect(messages(result)).toEqual([]);
      expect(file(result, `dictionary/${T}.xml`)).toContain('extends="x_snc_bprobe_base"');
      expect(file(result, `dictionary/${T}.xml`)).toContain('display="a"');
    });

    it("accepts the snake_case aliases", () => {
      const result = compile(table("read_only: true, text_index: true, live_feed: true, accessible_from: 'public'"));
      expect(messages(result)).toEqual([]);
      expect(only(result, "sys_db_object")[0].live_feed_enabled).toBe("true");
    });

    it("refuses table settings of now.config.json it cannot honour", () => {
      const result = compile(table(), {}, { emitDictionary: false, tableOutputFormat: "component", legacyChoices: true });
      expect(messages(result)).toEqual([
        "Table(): now.config.json 'emitDictionary' other than true, 'tableOutputFormat' other than \"bootstrap\" is not supported by the native compiler yet.",
      ]);
    });

    it("labels in the configured default language", () => {
      const result = compile(table("", "a: StringColumn({ label: 'A' })"), {}, { tableDefaultLanguage: "de" });
      expect(only(result, "sys_documentation").map((d) => d.language)).toEqual(["de", "de"]);
      const fr = compile(table("", "a: StringColumn({})"), {}, { defaultLanguage: "fr", tableDefaultLanguage: "de" });
      expect(only(fr, "sys_documentation").map((d) => d.language)).toEqual(["fr", "fr"]);
    });
  });

  describe("columns", () => {
    function column(source: string, config?: Record<string, unknown>) {
      const result = compile(table("", `a: ${source}`), {}, config);
      const dictionary = only(result, "sys_dictionary").find((d) => d.element === "a")!;
      return { result, dictionary, xml: file(result, `dictionary/${T}.xml`) };
    }

    it("writes the column options", () => {
      const { result, dictionary, xml } = column(
        `StringColumn({ label: 'A', maxLength: 40, mandatory: true, default: 'x', active: false, audit: true,
           array: true, primary: true, unique: true, spellCheck: true, xmlView: true, textIndex: true,
           tableReference: true, elementReference: true, widget: 'w', hint: 'h', help: 'hp', plural: 'As',
           isFullUTF8: true, attributes: { z: true }, min: 1, max: 2, signature: 's' })`,
      );
      expect(messages(result)).toEqual([]);
      expect(dictionary).toMatchObject({
        internal_type: "string_full_utf8",
        column_label: "A",
        max_length: "40",
        mandatory: "true",
        default_value: "x",
        active: "false",
        attributes: "z=true",
        widget: "w",
      });
      expect(xml).toContain('plural="As" hint="h" help="hp"');
    });

    it("writes numbers, scripts and GenericColumn types", () => {
      const decimal = column("DecimalColumn({ scale: 2, default: 1.5 })");
      expect(decimal.dictionary).toMatchObject({ internal_type: "decimal", attributes: "scale=2", default_value: "1.5" });
      expect(column("ScriptColumn({ script: 'x' })").dictionary.attributes).toBe("script=x");
      expect(column("GenericColumn({ columnType: 'currency' })").dictionary.internal_type).toBe("currency");
      expect(column("BooleanColumn({ default: true })").dictionary.default_value).toBe("true");
    });

    it("writes references and their qualifiers", () => {
      const { result, dictionary, xml } = column(
        `ReferenceColumn({ referenceTable: 'sys_user', cascadeRule: 'cascade', referenceKey: 'k', referenceFloats: true,
           dynamicCreation: true, dynamicCreationScript: 's', dynamicRefQual: 'abc', useReferenceQualifier: 'dynamic' })`,
      );
      expect(messages(result, "hint")).toEqual([]);
      expect(dictionary).toMatchObject({
        reference: "sys_user",
        reference_cascade_rule: "cascade",
        reference_key: "k",
        reference_floats: "true",
        dynamic_creation: "true",
        dynamic_ref_qual: "abc",
        use_reference_qualifier: "dynamic",
      });
      expect(xml).toContain('reference_floats="true"');
      expect(xml).toContain('use_reference_qualifier="dynamic" dynamic_ref_qual="abc"');
      expect(column("ReferenceColumn({ referenceTable: 't', referenceQual: 'active=true' })").dictionary.use_reference_qualifier).toBe("advanced");
    });

    it.each([
      ["dynamicRefQual: 'a', referenceQual: 'q', useReferenceQualifier: 'simple'", "both dynamicRefQual and referenceQual are set"],
      ["dynamicRefQual: 'a', useReferenceQualifier: 'simple'", "dynamicRefQual is set, implying 'dynamic'"],
      ["referenceQual: 'q', useReferenceQualifier: 'simple'", "referenceQual is set, implying 'advanced'"],
      ["useReferenceQualifier: 'advanced'", "neither dynamicRefQual nor referenceQual is set, implying 'simple'"],
    ])("hints at a qualifier that contradicts %s", (options, reason) => {
      const { result } = column(`ReferenceColumn({ referenceTable: 't', ${options} })`);
      expect(messages(result, "hint")).toEqual([expect.stringContaining(reason)]);
    });

    it("writes formulas and warns about a contradicting virtualType", () => {
      const formula = column("StringColumn({ formula: 'a < b', virtualType: 'script' })");
      expect(messages(formula.result, "warning")).toEqual([
        "virtualType is set to 'script' but formula is set, implying 'formula'. The explicit value 'script' will be used.",
      ]);
      expect(formula.dictionary).toMatchObject({ formula: "a < b", virtual: "true", virtual_type: "script" });
      expect(formula.xml).toContain('formula="a &lt; b"');
      const plain = column("StringColumn({ virtualType: 'formula' })");
      expect(messages(plain.result, "warning")).toEqual([
        "virtualType is set to 'formula' but formula is not set, implying 'script'. The explicit value 'formula' will be used.",
      ]);
      expect(plain.xml).toContain('virtual_type="formula"');
    });

    it("writes dependent fields and warns about a dependent object", () => {
      const dependent = column("DocumentIdColumn({ dependent: 'table' })");
      expect(dependent.dictionary).toMatchObject({ dependent: "table", dependent_on_field: "table", use_dependent_field: "true" });
      expect(dependent.xml).toContain('dependent_on_field="table" use_dependent_field="true"');
      const object = column("StringColumn({ dependent: StringColumn({}) })");
      expect(messages(object.result, "warning")).toEqual([expect.stringContaining("Passing a TableNameColumn object to 'dependent' is deprecated")]);
    });

    it("writes function fields and read-only options", () => {
      const fn = column("StringColumn({ functionDefinition: 'glidefunction:concat(a,b)' })");
      expect(fn.dictionary).toMatchObject({ function_field: "true", function_definition: "glidefunction:concat(a,b)" });
      const option = column("StringColumn({ readOnlyOption: 'read_only', readOnly: true })");
      expect(messages(option.result, "hint")).toEqual(["readOnly is unnecessary when readOnlyOption 'read_only' is declared."]);
      expect(option.dictionary).toMatchObject({ read_only: "true", read_only_option: "read_only" });
      expect(column("StringColumn({ readOnly: true })").dictionary.read_only_option).toBe("instance_configured");
      expect(column("StringColumn({ readOnlyOption: 'x' })").dictionary.read_only).toBe("true");
    });

    it("ignores mtom outside ServiceNow scopes with a warning", () => {
      const { result, xml } = column("StringColumn({ mtom: 'x' })");
      expect(messages(result, "warning")).toEqual([expect.stringContaining("'mtom' is reserved")]);
      expect(xml).not.toContain("mtom=");
    });

    it("writes labels in several languages", () => {
      const { result, xml } = column(
        "StringColumn({ label: [{ label: 'A', plural: 'Az', hint: 'h', help: 'p', url: 'u', urlTarget: 't' }, { label: 'B', language: 'de' }, { language: 'fr' }] })",
      );
      expect(messages(result)).toEqual([]);
      const labels = only(result, "sys_documentation").filter((d) => d.element === "a");
      expect(labels.map((d) => `${d.language}:${d.label}`).sort()).toEqual(["de:B", "en:A", "fr:A"]);
      expect(xml).toContain('plural="Az" hint="h" help="p" url="u" url_target="t"');
    });

    it("names an empty label language's documentation after 'en'", () => {
      const result = compile(table("", "a: StringColumn({ label: [{ label: 'A', language: '' }] })"));
      expect(result.records.some((r) => r.path.endsWith(`sys_documentation_${T}_a_en.xml`))).toBe(true);
    });

    it("takes the column label from the default language", () => {
      expect(column("StringColumn({ label: [{ label: 'B', language: 'de' }] })").dictionary.column_label).toBe("A");
    });
  });

  describe("choices", () => {
    it("writes choices to the dictionary and choice set files, not as records", () => {
      const result = compile(
        table(
          "",
          `a: ChoiceColumn({ dropdown: 'dropdown_without_none', choices: {
             x: 'X',
             y: { label: 'Y', sequence: 5, hint: 'h', inactive: true, inactiveOnUpdate: true, synonyms: ['a', 'b'], dependentValue: 1 },
             z: [{ label: 'Z' }, { label: 'Zed', language: 'de' }],
           } }), b: ChoiceColumn({ choices: {} })`,
        ),
      );
      expect(messages(result)).toEqual([]);
      expect(result.records.some((r) => r.table === "sys_choice" || r.table === "sys_choice_set")).toBe(false);
      expect(result.files.map((f) => f.path)).toEqual([`author_elective_update/sys_choice_${T}_a.xml`, `dictionary/${T}.xml`]);
      const dictionary = file(result, `dictionary/${T}.xml`);
      expect(dictionary).toContain('choice="3"');
      expect(dictionary).toContain('<element value="x" label="X" sequence="1" language="en"/>');
      expect(dictionary).toContain('dependent_value="1"');
      const set = file(result, `author_elective_update/sys_choice_${T}_a.xml`);
      expect(set).toContain("<synonyms>a,b</synonyms>");
      expect(set).toContain("<language>de</language>");
      expect(set).toContain("<hint>h</hint>");
      const blank = compile(table("", "a: ChoiceColumn({ choices: { x: { label: 'X', hint: '' } } })"));
      expect(file(blank, `author_elective_update/sys_choice_${T}_a.xml`)).toContain("<hint/>");
    });
  });

  describe("escaping", () => {
    it("escapes attribute values in the dictionary file", () => {
      const result = compile(table("label: 'A & \"B\"'", "a: StringColumn({ default: 'x\\ny\\r' })"));
      const xml = file(result, `dictionary/${T}.xml`);
      expect(xml).toContain('label="A &amp; &quot;B&quot;"');
      expect(xml).toContain('default_value="x&#10;y&#13;"');
    });
  });
});
