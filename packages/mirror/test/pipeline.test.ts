// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The row pipeline — INV-3.
 *
 * These tests are about a structural property, not an algorithm: after this call
 * returns, is there any way for the caller to reach the plaintext the wire carried?
 * The serializer and the redactor are each tested on their own; what is checked
 * here is that composing them leaves no intermediate in the caller's hands.
 */
import { SECRET_VALUES } from "../../redaction/test/corpus";
import { redactValue } from "@syncrona/redaction";

import type { FieldDescriptor, TableCatalogEntry } from "../src/contracts";
import { serializeAndRedact } from "../src/pipeline";
import { redactRecord } from "../src/serialize/redactor";
import { serializeRow } from "../src/serialize/serializer";

const field = (partial: Partial<FieldDescriptor>): FieldDescriptor => ({
  element: partial.element ?? "",
  internalType: partial.internalType ?? "string",
  extractAs: partial.extractAs ?? null,
  isJsonBlob: partial.isJsonBlob ?? false,
  isNoise: partial.isNoise ?? false,
  isDenied: partial.isDenied ?? false,
  reference: partial.reference ?? null,
  maxLength: partial.maxLength ?? null,
});

const table = (
  name: string,
  fields: Array<Partial<FieldDescriptor>>
): TableCatalogEntry => ({
  name,
  sysId: "00000000000000000000000000000000",
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: null,
  maxUpdatedOn: null,
  fields: fields.map(field),
  status: "included",
});

const decode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("utf8");

const scriptTable = table("sys_script", [
  { element: "script", extractAs: "js" },
  { element: "password", internalType: "password" },
]);

describe("serializeAndRedact", () => {
  it("produces exactly what running the two stages by hand produces", () => {
    const row = {
      sys_id: "aa00000000000000000000000000bb00",
      name: "notify",
      script: "gs.log('ok');",
      password: "hunter2",
    };
    const options = { table: scriptTable };

    const composed = serializeAndRedact(row, options);
    const byHand = redactRecord(serializeRow(row, scriptTable), options);

    expect(composed.record.recordJsonBytes).toEqual(byHand.recordJsonBytes);
    expect(composed.record.extractedFiles).toEqual(byHand.extractedFiles);
    expect(composed.record.redactions).toEqual(byHand.redactions);
    expect(composed.record.sysId).toBe(byHand.sysId);
    expect(composed.record.table).toBe(byHand.table);
  });

  it("hands back no pre-redaction value at all (INV-3)", () => {
    // The intermediate `SerializedRecord` holds `recordJsonValue` — every
    // plaintext the wire carried, in a shape anything could write. The point of
    // this module is that a caller never gets to hold one, so the result's own
    // keys are the assertion: two, and neither is the intermediate.
    const result = serializeAndRedact(
      { sys_id: "aa00000000000000000000000000bb00", password: "hunter2" },
      { table: scriptTable }
    );

    expect(Object.keys(result).sort()).toEqual(["parseFailures", "record"]);
    expect(Object.keys(result.record).sort()).toEqual([
      "extractedFiles",
      "recordJsonBytes",
      "redactions",
      "sysId",
      "table",
    ]);
    expect("recordJsonValue" in result.record).toBe(false);
  });

  it("keeps the plaintext out of every byte it produced", () => {
    const secret = SECRET_VALUES[9].value;
    const result = serializeAndRedact(
      {
        sys_id: "aa00000000000000000000000000bb00",
        password: "hunter2",
        script: `var k = '${secret}';`,
      },
      { table: scriptTable }
    );

    const everything = [
      decode(result.record.recordJsonBytes),
      ...result.record.extractedFiles.map((file) => decode(file.contents)),
    ].join("\n");

    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain(secret);
    expect(everything).toContain(redactValue("hunter2"));
  });

  it("carries the F6 parse failures out for the run report (R3)", () => {
    // Names, not values: the unparseable text stays inside the record, where it
    // was scanned like any other string. R3 forbids losing this silently — the
    // report has to be able to count it.
    const result = serializeAndRedact(
      { sys_id: "aa00000000000000000000000000bb00", spec: '{"note": "unclosed' },
      { table: table("sys_hub_flow", [{ element: "spec", isJsonBlob: true }]) }
    );

    expect(result.parseFailures).toEqual(["spec"]);
    expect(decode(result.record.recordJsonBytes)).toContain("raw:");
  });

  it("scans the raw text of a blob that failed to parse", () => {
    // F6 must not become a redaction bypass: `raw:` marks text the serializer
    // could not interpret, and text it could not interpret is exactly where a
    // secret would sit unnoticed.
    const secret = SECRET_VALUES[9].value;
    const result = serializeAndRedact(
      {
        sys_id: "aa00000000000000000000000000bb00",
        spec: `{"note": "${secret}"`,
      },
      { table: table("sys_hub_flow", [{ element: "spec", isJsonBlob: true }]) }
    );

    expect(result.parseFailures).toEqual(["spec"]);
    expect(result.record.redactions).toEqual([
      { field: "spec", reason: "value-scan" },
    ]);
    expect(decode(result.record.recordJsonBytes)).not.toContain(secret);
  });

  it("reports an empty list when nothing failed to parse", () => {
    const result = serializeAndRedact(
      {
        sys_id: "aa00000000000000000000000000bb00",
        spec: '{"note": "fine"}',
      },
      { table: table("sys_hub_flow", [{ element: "spec", isJsonBlob: true }]) }
    );

    expect(result.parseFailures).toEqual([]);
  });

  it("renders extracted files as bytes, ready to write unchanged", () => {
    const result = serializeAndRedact(
      { sys_id: "aa00000000000000000000000000bb00", script: "gs.log('ok');" },
      { table: scriptTable }
    );

    expect(result.record.extractedFiles).toHaveLength(1);
    expect(result.record.extractedFiles[0].fileName).toBe("script.js");
    expect(result.record.extractedFiles[0].contents).toBeInstanceOf(Uint8Array);
    expect(decode(result.record.extractedFiles[0].contents)).toBe(
      "gs.log('ok');\n"
    );
  });

  it("is deterministic end to end (INV-1)", () => {
    const row = (): Record<string, unknown> => ({
      sys_id: "aa00000000000000000000000000bb00",
      name: "notify",
      password: "hunter2",
      script: "gs.log('ok');",
    });

    const first = serializeAndRedact(row(), { table: scriptTable });
    const second = serializeAndRedact(row(), { table: scriptTable });

    expect(second.record.recordJsonBytes).toEqual(first.record.recordJsonBytes);
    expect(second.record.extractedFiles).toEqual(first.record.extractedFiles);
    expect(second.parseFailures).toEqual(first.parseFailures);
  });

  it("threads the sys_properties allowlist through to the redactor", () => {
    // The one option that changes what is committed, checked at the seam it has
    // to cross rather than only where it is consumed.
    const row = {
      sys_id: "aa00000000000000000000000000bb00",
      name: "glide.ui.polaris.keyboard_shortcuts",
      value: "true",
    };
    const propertyTable = table("sys_properties", [
      { element: "name" },
      { element: "value" },
    ]);

    const allowed = serializeAndRedact(row, {
      table: propertyTable,
      redaction: { propertyAllowlist: ["glide.ui.polaris.keyboard_shortcuts"] },
    });
    const denied = serializeAndRedact(row, { table: propertyTable });

    expect(allowed.record.redactions).toEqual([]);
    expect(denied.record.redactions).toEqual([
      { field: "value", reason: "key-pattern" },
    ]);
  });
});
