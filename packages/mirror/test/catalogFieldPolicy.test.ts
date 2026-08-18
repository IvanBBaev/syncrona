// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Column policy and tier banding, at the level the fixture cannot reach.
 *
 * `catalogService.test.ts` proves the policy against real dictionary rows, which
 * is the important proof. It cannot prove all of it: the committed corpus spells
 * every `sys_dictionary.reference` as a table NAME, has one `internal_type` per
 * column and never omits a selected column, so the sys_id form of a reference
 * (which is what a live instance returns under
 * `sysparm_exclude_reference_link=true`), an `internal_type` that collides with
 * `Object.prototype`, and a row arriving without a field at all are all shapes a
 * correct fixture will never produce. Those live here, one assertion per hazard,
 * each naming the wrong output it prevents.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import {
  describeField,
  isActiveColumnRow,
  DENIED_FIELD_TYPES,
  EXTRACTED_TYPE_EXTENSIONS,
  JSON_BLOB_TYPES,
  NOISE_ELEMENTS,
  type FieldPolicyContext,
} from "../src/catalog/fieldPolicy";
import {
  assignTier,
  BINARY_TABLES,
  CONFIG_TABLES,
  REFERENCE_DATA_TABLES,
} from "../src/catalog/tiers";
import { compareBytewise } from "../src/order";
import { SYS_ID_RE } from "../src/constants";

/** A syntactically valid sys_id (INV-6) that the table index below knows. */
const KNOWN_TABLE_SYS_ID = "3cb6b7a4c0a8016400e4dd0f0d5b5e2b";
/** Same shape, deliberately absent from the index — an uninstalled plugin's leftover. */
const UNKNOWN_TABLE_SYS_ID = "0f9b1d2e3c4a5b6c7d8e9f0a1b2c3d4e";

const contextOf = (overrides: Partial<FieldPolicyContext> = {}): FieldPolicyContext => ({
  ignoreFields: new Set<string>(),
  tableNameOfSysId: (sysId) => (sysId === KNOWN_TABLE_SYS_ID ? "incident" : null),
  ...overrides,
});

/** A dictionary row with every selected column present, as the wire delivers it. */
const rowOf = (overrides: Partial<Record<string, string>> = {}): Record<string, string> => ({
  name: "x_demo_table",
  element: "short_description",
  internal_type: "string",
  reference: "",
  max_length: "160",
  active: "true",
  ...overrides,
});

/**
 * Read `SN_TYPE_MAP` out of the v1 CLI's source without importing it.
 *
 * The import is what we cannot do: `@syncrona/mirror` is a leaf library the CLI
 * consumes, so an edge pointing back at `packages/core` would invert the graph
 * the workspace boundary rule protects (see `fieldPolicy.ts`). Restating the
 * eight rows as a literal here is what we MUST not do either, and it is the
 * subtler mistake — a test that asserts a copy against a second copy is green by
 * construction and reports drift never. So the file is parsed as text, through
 * the compiler that owns its syntax.
 *
 * Failure modes are separated on purpose: an unreadable or restructured
 * `fieldMap.ts` throws with the reason, and only an actually-parsed map reaches
 * the comparison. A silent `{}` cannot masquerade as agreement.
 */
const readCliTypeMap = (): Record<string, string> => {
  const file = join(__dirname, "..", "..", "core", "src", "fieldMap.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);

  let literal: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SN_TYPE_MAP"
    ) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
        literal = initializer;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (literal === undefined) {
    throw new Error(`SN_TYPE_MAP is no longer a plain object literal in ${file}`);
  }

  const map: Record<string, string> = {};
  for (const property of literal.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      !ts.isStringLiteral(property.initializer)
    ) {
      throw new Error(`SN_TYPE_MAP holds an entry this reader cannot evaluate: ${property.getText()}`);
    }
    map[property.name.text] = property.initializer.text;
  }
  return map;
};

describe("field policy tables", () => {
  it("keeps the extension map aligned with the v1 CLI's SN_TYPE_MAP", () => {
    // The duplication is deliberate (see the module docblock); this is the test
    // that makes a divergence visible instead of silent. A file written as
    // `script.txt` on one side and `script.js` on the other is a format change
    // under INV-8, not a cosmetic difference.
    //
    // Read from `packages/core` rather than restated, because the restatement is
    // the failure mode this test exists to prevent: it would agree with itself
    // forever while the CLI's map moved underneath it.
    const cliMap = readCliTypeMap();

    // Anti-vacuity: an empty or truncated parse must fail loudly here, not pass
    // quietly by comparing nothing against nothing.
    expect(Object.keys(cliMap).length).toBeGreaterThanOrEqual(8);
    expect(cliMap).toMatchObject({ script: "js" });

    expect(EXTRACTED_TYPE_EXTENSIONS).toEqual(cliMap);
    expect([...JSON_BLOB_TYPES]).toEqual(["json", "json_translations"]);
    expect([...DENIED_FIELD_TYPES]).toEqual(["password", "password2"]);
    expect([...NOISE_ELEMENTS]).toEqual(["sys_updated_on", "sys_updated_by", "sys_mod_count"]);
  });

  it("reads a real map, and reports a restructured source instead of ignoring it", () => {
    // The reader is the load-bearing part of the assertion above, so it is
    // proven before it is trusted — the same discipline `getOnlyBuild.test.ts`
    // applies to its verb detector.
    expect(readCliTypeMap()).toEqual(EXTRACTED_TYPE_EXTENSIONS);

    const parseOf = (text: string): ts.ObjectLiteralExpression | undefined => {
      const source = ts.createSourceFile("probe.ts", text, ts.ScriptTarget.ES2022, true);
      let found: ts.ObjectLiteralExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "SN_TYPE_MAP" &&
          node.initializer !== undefined &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          found = node.initializer;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };

    // A computed map, a renamed export and a spread are each a shape this reader
    // must refuse rather than silently read as `{}`.
    expect(parseOf('export const SN_TYPE_MAP = Object.freeze({ script: "js" });')).toBeUndefined();
    expect(parseOf('export const TYPE_MAP = { script: "js" };')).toBeUndefined();
    expect(parseOf('export const SN_TYPE_MAP = { ...base, script: "js" };')).toBeDefined();
  });
});

describe("isActiveColumnRow", () => {
  it("rejects the dictionary's row for the table itself", () => {
    // `element: ""` with `internal_type: "collection"` is how sys_dictionary
    // describes a TABLE. Read as a column it produces a descriptor named "",
    // and the serializer then looks for a wire value under the empty key on
    // every record of every table.
    expect(isActiveColumnRow(rowOf({ element: "", internal_type: "collection" }))).toBe(false);
    expect(isActiveColumnRow({ internal_type: "collection" })).toBe(false);
  });

  it("rejects an inactive column even though the sweep asked the server to (M12/D20)", () => {
    expect(isActiveColumnRow(rowOf({ active: "false" }))).toBe(false);
    expect(isActiveColumnRow(rowOf({ active: "true" }))).toBe(true);
    // An absent `active` is not an absent column: a row that arrived without the
    // field is kept, because dropping it would lose a real column on any
    // instance that stops selecting it.
    expect(isActiveColumnRow({ element: "short_description" })).toBe(true);
  });
});

describe("describeField", () => {
  it("extracts only the types the map names, by own property (§7.1)", () => {
    expect(describeField(rowOf({ internal_type: "script" }), contextOf()).extractAs).toBe("js");
    expect(describeField(rowOf({ internal_type: "glide_date_time" }), contextOf()).extractAs).toBeNull();
    // `internal_type` is instance data. A plain index would answer
    // `EXTRACTED_TYPE_EXTENSIONS["constructor"]` with a FUNCTION, and that
    // function would then be used as a file extension.
    const polluted = describeField(rowOf({ internal_type: "constructor" }), contextOf());
    expect(polluted.extractAs).toBeNull();
    expect(polluted.internalType).toBe("constructor");
  });

  it("flags JSON blobs and denied types by type, never by name", () => {
    expect(describeField(rowOf({ internal_type: "json" }), contextOf()).isJsonBlob).toBe(true);
    expect(describeField(rowOf({ internal_type: "string" }), contextOf()).isJsonBlob).toBe(false);
    // D19/M10: the column is called `password` on one table and something else
    // on the next, so the deny follows the type.
    expect(describeField(rowOf({ element: "token", internal_type: "password2" }), contextOf()).isDenied).toBe(
      true
    );
    expect(describeField(rowOf({ element: "password", internal_type: "string" }), contextOf()).isDenied).toBe(
      false
    );
  });

  it("merges engine churn and operator ignores into one boolean (D7)", () => {
    const withIgnores = contextOf({ ignoreFields: new Set(["short_description"]) });
    expect(describeField(rowOf({ element: "sys_mod_count" }), contextOf()).isNoise).toBe(true);
    expect(describeField(rowOf(), withIgnores).isNoise).toBe(true);
    expect(describeField(rowOf(), contextOf()).isNoise).toBe(false);
  });

  it("resolves a reference in whichever of its two wire forms arrived", () => {
    // With `sysparm_exclude_reference_link=true` the stored value comes back
    // raw, and for sys_dictionary.reference that is a sys_db_object sys_id.
    expect(SYS_ID_RE.test(KNOWN_TABLE_SYS_ID)).toBe(true);
    expect(describeField(rowOf({ reference: KNOWN_TABLE_SYS_ID }), contextOf()).reference).toBe("incident");
    // An unresolvable sys_id becomes null rather than 32 hex characters
    // masquerading as a table name — `TableCatalogEntry` promises a NAME, and a
    // consumer handed the sys_id would look for a table called that and fail.
    expect(describeField(rowOf({ reference: UNKNOWN_TABLE_SYS_ID }), contextOf()).reference).toBeNull();
    // A fixture, an export or a future release may hand over the name directly.
    expect(describeField(rowOf({ reference: "sys_user" }), contextOf()).reference).toBe("sys_user");
    expect(describeField(rowOf({ reference: "" }), contextOf()).reference).toBeNull();
  });

  it("keeps an absent max_length distinct from a declared zero (M8)", () => {
    expect(describeField(rowOf({ max_length: "40" }), contextOf()).maxLength).toBe(40);
    // `Number("")` is 0, and a declared maximum length of zero is a claim a
    // truncation check downstream would act on.
    expect(describeField(rowOf({ max_length: "" }), contextOf()).maxLength).toBeNull();
    expect(describeField(rowOf({ max_length: "   " }), contextOf()).maxLength).toBeNull();
    expect(describeField(rowOf({ max_length: "0" }), contextOf()).maxLength).toBe(0);
    // A non-numeric value is a broken dictionary, not a NaN in a descriptor that
    // would serialize as `null` anyway and compare unequal to itself.
    expect(describeField(rowOf({ max_length: "unlimited" }), contextOf()).maxLength).toBeNull();
  });

  it("survives a row that arrived with nothing on it", () => {
    // Not a hypothetical: `sysparm_fields` is a request, and a column the table
    // does not have is simply absent from the response (M11). Every field of the
    // descriptor must still be the documented type.
    expect(describeField({}, contextOf())).toEqual({
      element: "",
      internalType: "",
      extractAs: null,
      isJsonBlob: false,
      isNoise: false,
      isDenied: false,
      reference: null,
      maxLength: null,
    });
  });
});

describe("assignTier", () => {
  it("lets the discovered closure beat every curated list (design §4.2)", () => {
    // sys_properties is in CONFIG_TABLES and extends sys_metadata on ven01800.
    // The instance in front of us wins; that is the whole point of discovering
    // T1 instead of listing it.
    expect(CONFIG_TABLES.has("sys_properties")).toBe(true);
    expect(assignTier("sys_properties", true)).toEqual({ tier: 1, kind: "metadata" });
    expect(assignTier("sys_properties", false)).toEqual({ tier: 2, kind: "config-table" });
  });

  it("bands each curated set with the reason that produced it", () => {
    expect(assignTier("sys_choice", false)).toEqual({ tier: 2, kind: "config-table" });
    expect(assignTier("sys_user", false)).toEqual({ tier: 3, kind: "reference-data" });
    expect(assignTier("sys_attachment", false)).toEqual({ tier: 3, kind: "binary" });
    // T4 and anything a future release invents: banded out, but named — R3 makes
    // "deliberately not mirrored" and "never seen" different answers.
    expect(assignTier("syslog", false)).toEqual({ tier: 3, kind: "unclassified" });
  });

  it("leaves sys_trigger out of the config set on purpose", () => {
    // Design §4.1 lists it under T2, and it is excluded anyway: its rows carry
    // the next execution time of every scheduled job, so it rewrites itself
    // continuously and would produce a diff on every single sync.
    expect(CONFIG_TABLES.has("sys_trigger")).toBe(false);
    expect(assignTier("sys_trigger", false).kind).toBe("unclassified");
  });

  it("keeps the curated sets disjoint", () => {
    // Overlap would make the banding depend on the order of the branches rather
    // than on the design, and the branch order is not where that decision belongs.
    const all = [...CONFIG_TABLES, ...REFERENCE_DATA_TABLES, ...BINARY_TABLES];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("compareBytewise", () => {
  it("orders by code unit and reports equality (INV-1)", () => {
    expect(compareBytewise("a", "b")).toBe(-1);
    expect(compareBytewise("b", "a")).toBe(1);
    expect(compareBytewise("a", "a")).toBe(0);
    // The case the default sort and `localeCompare` disagree on: `_` (0x5F)
    // sorts after uppercase and before lowercase, and some ICU locales ignore it
    // entirely — which would reorder `sys_ui_action` against `sys_uiaction`
    // depending on the machine the mirror ran on.
    expect(compareBytewise("sys_ui_action", "sys_uiaction")).toBe(-1);
    expect(["sys_uiaction", "sys_ui_action"].sort(compareBytewise)).toEqual([
      "sys_ui_action",
      "sys_uiaction",
    ]);
  });
});
