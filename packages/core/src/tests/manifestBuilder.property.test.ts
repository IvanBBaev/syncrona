// SPDX-License-Identifier: GPL-3.0-or-later
// Property-based coverage for the record-name derivation that decides where a
// downloaded record lands on disk.
//
// manifestBuilder is the widest trust boundary in the CLI: every value it works
// with is a JSON field from a ServiceNow Table API response, typed here as
// `TableAPIRecord = Record<string, string>` — a claim about a remote response that
// nothing validates. The example suites (manifestBuilder, manifestBuilderCoverage,
// manifestBuilderResilience, core-manifestRev140) cover the pipeline with
// well-formed string rows. These properties cover the other half: what happens
// when the instance returns a row that is not the shape the type promises, and
// whether the name the builder derives is one the writer will accept.
//
// Why that last part matters: downloadPipeline joins the derived name onto the
// workspace source root and guards the join with `isSafePathComponent`
// (default-deny, INJ-1). So a name the builder produces but that predicate
// rejects is not a security hole — it is a hard, non-resumable failure of the
// whole pull for a record the instance served correctly. The two modules have to
// agree, and that agreement is a property, not an example.
import { jest } from "@jest/globals";
import fc from "fast-check";
import { SN } from "@syncrona/types";
import { buildBulkDownloadFromTableAPI } from "../manifestBuilder.js";
import {
  getDisplayField,
  getFileTypeForInternalType,
  TABLE_DISPLAY_FIELD,
  SN_TYPE_MAP,
} from "../fieldMap.js";
import { isSafePathComponent } from "../genericUtils.js";
import { logger } from "../Logger.js";

// fast-check 4 dropped `hexaString`; a hex-unit string is the portable spelling.
const HEX_CHAR = fc.constantFrom(..."0123456789abcdef");

// The table under test has a known display field ("name"), so the properties can
// state what the builder is expected to read.
const TABLE = "sys_script_include";
const DISPLAY_FIELD = "name";

type Row = Record<string, unknown>;

function createClient(rows: Row[]): import("../snClient").SNClient {
  return {
    tableAPIGet: async () => ({ data: { result: rows } }),
  } as unknown as import("../snClient").SNClient;
}

/**
 * The values a Table API row really carries. The interesting ones are not the
 * strings: ServiceNow only flattens a reference field to its value when
 * `sysparm_exclude_reference_link` is set, and snClient does not set it, so a
 * reference column arrives as `{ link, value }` — an object where this module's
 * row type promises a string.
 */
const referenceLinkValue = fc.record({
  link: fc.constant("https://dev.service-now.com/api/now/table/sys_user/abc"),
  value: fc.string({ unit: HEX_CHAR, minLength: 32, maxLength: 32 }),
});

const rowValue = fc.oneof(
  { arbitrary: fc.string({ maxLength: 12 }), weight: 6 },
  {
    // Names that are hostile to a path, and the ones buildRecordName explicitly
    // rewrites: separators, "." / ".." in every padded spelling, blank-but-truthy.
    arbitrary: fc.constantFrom(
      "",
      " ",
      "   ",
      ".",
      "..",
      "...",
      " .. ",
      "..\n",
      "a/b",
      "a\\b",
      "/",
      "\\",
      "../../etc/passwd",
      "\u0000",
      "CON",
      "é",
      "é"
    ),
    weight: 5,
  },
  { arbitrary: referenceLinkValue, weight: 3 },
  { arbitrary: fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean()), weight: 2 }
);

const FIELD_NAMES = ["script", "css", "html"] as const;

const requestedRecord = fc.record({
  sysId: fc.constantFrom("rec-1", "rec-2", "rec-3"),
  fields: fc.uniqueArray(fc.constantFrom(...FIELD_NAMES), { minLength: 1, maxLength: 3 }),
});

// A row as the instance returns it: any subset of the requested columns, any of
// the value shapes above, and possibly no sys_id at all.
const returnedRow: fc.Arbitrary<Row> = fc.dictionary(
  fc.constantFrom("sys_id", DISPLAY_FIELD, "script", "css", "html", "short_description"),
  rowValue,
  { maxKeys: 6 }
);

function missingMapFrom(records: Array<{ sysId: string; fields: string[] }>): SN.MissingFileTableMap {
  const recordMap: Record<string, SN.File[]> = {};
  for (const record of records) {
    recordMap[record.sysId] = record.fields.map((field) => ({
      name: field,
      type: (field === "script" ? "js" : field) as SN.FileType,
    }));
  }
  return { [TABLE]: recordMap };
}

describe("manifestBuilder record-name derivation (property)", () => {
  beforeEach(() => {
    // The builder warns about columns the instance did not return; the generators
    // hit that path constantly and the warnings would drown the run.
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("never fails the whole download because of the shape of one row", async () => {
    // Every table is fetched under one Promise.all and only an HTTP-ish
    // "skippable" error is swallowed per table, so any other throw from a single
    // row aborts the pull for EVERY table — after an arbitrary amount of work,
    // with no record or table named in the message.
    await fc.assert(
      fc.asyncProperty(
        fc.array(requestedRecord, { minLength: 1, maxLength: 3 }),
        fc.array(returnedRow, { maxLength: 3 }),
        async (records, rows) => {
          const result = await buildBulkDownloadFromTableAPI(
            missingMapFrom(records),
            createClient(rows),
            {}
          );
          expect(typeof result).toBe("object");
        }
      ),
      { numRuns: 600 }
    );
  });

  it("only ever derives a name the download writer will accept", async () => {
    // downloadPipeline gates every path component on isSafePathComponent and
    // throws "Refusing to download" otherwise, so this is the parity statement
    // between the module that invents the name and the module that writes it.
    await fc.assert(
      fc.asyncProperty(
        fc.array(requestedRecord, { minLength: 1, maxLength: 3 }),
        fc.array(returnedRow, { maxLength: 3 }),
        async (records, rows) => {
          const result = await buildBulkDownloadFromTableAPI(
            missingMapFrom(records),
            createClient(rows),
            {}
          );
          for (const table of Object.values(result)) {
            for (const [key, record] of Object.entries(table.records)) {
              expect(isSafePathComponent(key)).toBe(true);
              expect(record.name).toBe(key);
              // The record has to be keyable by sys_id: buildManifestRecordNames
              // indexes the manifest by it, and a record whose sys_id is missing
              // would occupy the literal key "undefined" there.
              expect(typeof record.sys_id).toBe("string");
              expect(record.sys_id.length).toBeGreaterThan(0);
            }
          }
        }
      ),
      { numRuns: 600 }
    );
  });

  it("never invents a file for a column the instance did not return", async () => {
    // The download writes with forceWrite, so a fabricated empty file silently
    // overwrites real local content. A column that is absent from the response is
    // "not fetched", never "empty".
    await fc.assert(
      fc.asyncProperty(
        fc.array(requestedRecord, { minLength: 1, maxLength: 3 }),
        fc.array(returnedRow, { maxLength: 3 }),
        async (records, rows) => {
          const requested = new Set(records.flatMap((record) => record.fields));
          const result = await buildBulkDownloadFromTableAPI(
            missingMapFrom(records),
            createClient(rows),
            {}
          );
          const table = result[TABLE];
          if (!table) {
            return;
          }
          for (const record of Object.values(table.records)) {
            for (const file of record.files) {
              expect(requested.has(file.name)).toBe(true);
              // Some row in the response must actually carry this column.
              expect(rows.some((row) => file.name in row)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 600 }
    );
  });

  it("prefers the manifest's own name for a record, so download and manifest stay in parity", async () => {
    // Deriving the name twice is what broke disambiguated records (the download
    // wrote at a path the manifest did not know and `repair --prune` deleted it),
    // so the supplied name must win whenever it is usable.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("rec-1", "rec-2"),
        fc.string({ maxLength: 12 }),
        rowValue,
        async (sysId, manifestName, displayValue) => {
          fc.pre(isSafePathComponent(manifestName));
          const rows: Row[] = [{ sys_id: sysId, [DISPLAY_FIELD]: displayValue, script: "x" }];
          const result = await buildBulkDownloadFromTableAPI(
            missingMapFrom([{ sysId, fields: ["script"] }]),
            createClient(rows),
            {},
            { [TABLE]: { [sysId]: manifestName } }
          );
          expect(Object.keys(result[TABLE].records)) .toEqual([manifestName]);
        }
      ),
      { numRuns: 800 }
    );
  });
});

// ---------------------------------------------------------------------------
// The lookup tables the derivation depends on.
//
// Both are plain object literals indexed by a name that comes from the instance
// (a sys_db_object row, a sys_dictionary internal_type) or from the project
// config, and both are declared as returning a string. A bare index also resolves
// inherited Object.prototype members, which is the same hole that was fixed in
// normalizeAuthMethod and in the MCP tool-schema lookup.
// ---------------------------------------------------------------------------

const tableNameArbitrary = fc.oneof(
  { arbitrary: fc.constantFrom(...Object.keys(TABLE_DISPLAY_FIELD)), weight: 4 },
  {
    arbitrary: fc.constantFrom(
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString"
    ),
    weight: 4,
  },
  { arbitrary: fc.constantFrom("x_custom_table", "incident", "", " ", "sys_metadata"), weight: 2 },
  { arbitrary: fc.string({ maxLength: 16 }), weight: 2 }
);

describe("fieldMap lookups (property)", () => {
  it("resolves a display field name to a string for every table name", () => {
    fc.assert(
      fc.property(tableNameArbitrary, (tableName) => {
        const field = getDisplayField(tableName);
        expect(typeof field).toBe("string");
        expect(field.length).toBeGreaterThan(0);
      }),
      { numRuns: 3000 }
    );
  });

  it("resolves an internal type to a file extension string for every internal type", () => {
    fc.assert(
      fc.property(tableNameArbitrary, (internalType) => {
        const type = getFileTypeForInternalType(internalType);
        expect(typeof type).toBe("string");
        // The extension is joined onto a filename as `<name>.<type>`, so it must
        // not be able to introduce a path separator of its own.
        expect(isSafePathComponent(type)).toBe(true);
      }),
      { numRuns: 3000 }
    );
  });

  it("keeps every mapping it does know", () => {
    // Guards against "fix the lookup by always returning the default": the
    // properties above would still pass if both functions ignored their tables.
    for (const [tableName, field] of Object.entries(TABLE_DISPLAY_FIELD)) {
      expect(getDisplayField(tableName)).toBe(field);
    }
    for (const [internalType, extension] of Object.entries(SN_TYPE_MAP)) {
      expect(getFileTypeForInternalType(internalType)).toBe(extension);
    }
  });
});
