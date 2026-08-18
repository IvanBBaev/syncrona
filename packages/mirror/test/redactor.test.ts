// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Redactor behaviour — architecture §5.7, §8; D19; F7.
 *
 * The corpus half of this file imports `@syncrona/redaction`'s OWN fixture file by
 * path rather than restating a few interesting secrets locally. A hand-copied
 * corpus is green the day it is written and then rots: the detector package adds a
 * rule, its own tests cover it, and the redactor's copy never learns that the rule
 * exists. Driving the real file means every entry the detector package ever adds is
 * automatically asserted to survive the trip through a record.
 */
import {
  BENIGN_KEYS,
  BENIGN_VALUES,
  SECRET_VALUES,
  SENSITIVE_KEYS,
  type CorpusEntry,
} from "../../redaction/test/corpus";
import {
  REDACTION_MARKER_HASH_CHARS,
  REDACTION_MARKER_PREFIX,
  SCAN_BUDGET,
  looksLikeSecretValue,
  redactValue,
} from "@syncrona/redaction";

import type {
  FieldDescriptor,
  SerializedRecord,
  TableCatalogEntry,
} from "../src/contracts";
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

/**
 * A serialized record, built directly rather than through `serializeRow`.
 *
 * Deliberate: the redactor's contract is "given a SerializedRecord", and several
 * rules here exist precisely for inputs the serializer would never produce — a
 * denied column that reached this stage anyway is the case D19's re-check is for.
 * Composing the two stages is tested separately, in `pipeline.test.ts`.
 */
const serialized = (partial: Partial<SerializedRecord>): SerializedRecord => ({
  sysId: partial.sysId ?? "aa00000000000000000000000000bb00",
  table: partial.table ?? "incident",
  recordJsonValue: partial.recordJsonValue ?? {},
  extractedFiles: partial.extractedFiles ?? [],
  parseFailures: partial.parseFailures ?? [],
});

const decode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("utf8");

const envelopeOf = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(decode(bytes)) as Record<string, unknown>;

/**
 * The stand-in for a `password2` ciphertext, used wherever a D19 test needs one.
 *
 * Named rather than repeated, and prefixed rather than opaque. `password2:
 * "<sixteen mixed-case alphanumerics>"` is the exact shape gitleaks' generic
 * key rule is built to catch, and it caught this — correctly, since a scanner
 * cannot tell a fixture from the real thing. `.gitleaks.toml` refuses to exempt
 * test directories on purpose, so the value announces itself instead, which is
 * also what a human reading a diff needs to see. The opacity that the test
 * actually depends on ("a value no value-shape rule would recognise") is
 * unaffected: `FAKE-` says the string is synthetic, not that it is a secret.
 */
const FIXTURE_CIPHERTEXT = "FAKE-AbCdEf0123456789";

describe("the value scan, driven by the redaction package's own corpus", () => {
  // Under a benign key, so the ONLY thing that can redact these is rule 3.
  it.each(SECRET_VALUES.map((entry): [string, CorpusEntry] => [entry.label, entry]))(
    "redacts a secret smuggled under a benign key: %s",
    (_label, entry) => {
      const record = redactRecord(
        serialized({ recordJsonValue: { description: entry.value } }),
        { table: table("incident", [{ element: "description" }]) }
      );

      expect(record.redactions).toEqual([
        { field: "description", reason: "value-scan" },
      ]);
      expect(envelopeOf(record.recordJsonBytes).description).toBe(
        redactValue(entry.value)
      );
    }
  );

  it.each(BENIGN_VALUES.map((entry): [string, CorpusEntry] => [entry.label, entry]))(
    "leaves a near-miss value byte-for-byte alone: %s",
    (_label, entry) => {
      // The expensive failure mode is not a missed secret, it is this: a widened
      // pattern eats the audit record an operator needed, and git keeps the
      // marker forever. Every entry here is a value some rule ALMOST matches.
      const record = redactRecord(
        serialized({ recordJsonValue: { description: entry.value } }),
        { table: table("incident", [{ element: "description" }]) }
      );

      expect(record.redactions).toEqual([]);
      expect(envelopeOf(record.recordJsonBytes).description).toBe(entry.value);
    }
  );

  it("exercised every corpus entry rather than an empty list", () => {
    // Non-vacuity for the two `it.each` blocks above: if the import ever resolved
    // to an empty array — a moved file, a renamed export — `it.each([])` registers
    // no tests at all and the suite stays green while nothing is checked.
    expect(SECRET_VALUES.length).toBeGreaterThan(15);
    expect(BENIGN_VALUES.length).toBeGreaterThan(15);
    expect(SENSITIVE_KEYS.length).toBeGreaterThan(25);
    expect(BENIGN_KEYS.length).toBeGreaterThan(10);
  });
});

describe("the key-pattern rule, driven by the same corpus", () => {
  // A benign value, so the ONLY thing that can redact these is rule 2.
  const BENIGN_VALUE = "all systems ok";

  it.each(SENSITIVE_KEYS)("redacts an ordinary value under key %s", (key) => {
    const record = redactRecord(
      serialized({ recordJsonValue: { [key]: BENIGN_VALUE } }),
      { table: table("incident", [{ element: key }]) }
    );

    expect(record.redactions).toEqual([{ field: key, reason: "key-pattern" }]);
    expect(envelopeOf(record.recordJsonBytes)[key]).toBe(
      redactValue(BENIGN_VALUE)
    );
  });

  it.each(BENIGN_KEYS)("passes an ordinary value under key %s through", (key) => {
    const record = redactRecord(
      serialized({ recordJsonValue: { [key]: BENIGN_VALUE } }),
      { table: table("incident", [{ element: key }]) }
    );

    expect(record.redactions).toEqual([]);
    expect(envelopeOf(record.recordJsonBytes)[key]).toBe(BENIGN_VALUE);
  });

  it("redacts a non-string value under a sensitive key, whole", () => {
    // A structure under `auth` is credential material regardless of its shape, and
    // walking into it would leave the member names in git.
    const nested = { user: "admin", ttl: 3600 };
    const record = redactRecord(
      serialized({ recordJsonValue: { auth: nested } }),
      { table: table("incident", [{ element: "auth" }]) }
    );

    expect(record.redactions).toEqual([{ field: "auth", reason: "key-pattern" }]);
    expect(envelopeOf(record.recordJsonBytes).auth).toBe(
      redactValue('{\n  "ttl": 3600,\n  "user": "admin"\n}\n')
    );
  });
});

describe("field-type deny (D19)", () => {
  it("drops a denied column that reached this stage anyway", () => {
    // Not hygiene: `password2` returns a 106-character ciphertext over the Table
    // API, so the wire really does carry encrypted secret material under a column
    // no value-shape rule would recognise. The serializer omits it; this stage
    // re-checks, because the two stages must fail independently.
    const record = redactRecord(
      serialized({
        recordJsonValue: { name: "acme", password2: FIXTURE_CIPHERTEXT },
      }),
      {
        table: table("sys_user", [
          { element: "name" },
          { element: "password2", internalType: "password2", isDenied: true },
        ]),
      }
    );

    expect(record.redactions).toEqual([
      { field: "password2", reason: "field-type" },
    ]);
    expect(Object.keys(envelopeOf(record.recordJsonBytes))).toEqual(["name"]);
    // And the ciphertext is nowhere in the bytes — not even behind a marker.
    expect(decode(record.recordJsonBytes)).not.toContain(FIXTURE_CIPHERTEXT);
  });

  it("drops the extracted file of a denied column instead of emptying it", () => {
    const record = redactRecord(
      serialized({
        extractedFiles: [{ fileName: "secret_script.js", contents: "gs.log(1);" }],
      }),
      {
        table: table("sys_script", [
          { element: "secret_script", extractAs: "js", isDenied: true },
        ]),
      }
    );

    expect(record.extractedFiles).toEqual([]);
    expect(record.redactions).toEqual([
      { field: "secret_script.js", reason: "field-type" },
    ]);
  });

  it("resolves a redeclared column the same way the serializer does (D21)", () => {
    // A child table may redeclare a parent's column along `super_class`, and the
    // two stages index those duplicates independently. If they disagreed — first
    // entry here, last entry there — the serializer would keep a column the
    // redactor believed it had denied. This pins them together in both directions.
    const denyFirst = table("sys_user", [
      { element: "password2", isDenied: true },
      { element: "password2", isDenied: false },
    ]);
    const allowFirst = table("sys_user", [
      { element: "password2", isDenied: false },
      { element: "password2", isDenied: true },
    ]);
    const row = { password2: FIXTURE_CIPHERTEXT };

    expect(serializeRow(row, denyFirst).recordJsonValue.password2).toBeUndefined();
    expect(
      redactRecord(serialized({ recordJsonValue: row }), { table: denyFirst })
        .redactions
    ).toEqual([{ field: "password2", reason: "field-type" }]);

    expect(serializeRow(row, allowFirst).recordJsonValue.password2).toBe(
      FIXTURE_CIPHERTEXT
    );
    // Kept as a column by both stages — and then redacted by the key rule, which
    // is a different decision reached for a different reason.
    expect(
      redactRecord(serialized({ recordJsonValue: row }), { table: allowFirst })
        .redactions
    ).toEqual([{ field: "password2", reason: "key-pattern" }]);
  });
});

describe("scan-budget overflow (F7)", () => {
  const filler = (length: number): string => "x".repeat(length);

  it("redacts an over-budget value whole, and says why", () => {
    const long = filler(SCAN_BUDGET + 1);
    const record = redactRecord(
      serialized({ recordJsonValue: { description: long } }),
      { table: table("incident", [{ element: "description" }]) }
    );

    // Whole, not truncated and not partially scanned: the point of F7 is that the
    // mirror could not read all of the value, so it cannot claim any part of it is
    // safe. The reason must be `scan-overflow` and not `value-scan` — the run
    // report maps only the former to exit code 2, and an operator is entitled to
    // know that content was destroyed defensively rather than identified.
    expect(record.redactions).toEqual([
      { field: "description", reason: "scan-overflow" },
    ]);
    expect(envelopeOf(record.recordJsonBytes).description).toBe(
      redactValue(long)
    );
  });

  it("leaves a value at exactly the budget alone", () => {
    // The boundary, and the non-vacuity guard for the test above: if the filler
    // tripped a pattern on its own, the overflow assertion would pass for the
    // wrong reason.
    const atBudget = filler(SCAN_BUDGET);
    expect(looksLikeSecretValue(atBudget)).toBe(false);

    const record = redactRecord(
      serialized({ recordJsonValue: { description: atBudget } }),
      { table: table("incident", [{ element: "description" }]) }
    );

    expect(record.redactions).toEqual([]);
  });

  it("reports overflow for an over-budget extracted script body", () => {
    // The cost this rule accepts, stated plainly: a business rule longer than the
    // budget is committed as a marker. That is F7 working as specified, and it is
    // the direction the taxonomy chose over letting a padded secret through.
    const body = filler(SCAN_BUDGET + 1);
    const record = redactRecord(
      serialized({ extractedFiles: [{ fileName: "script.js", contents: body }] }),
      { table: table("sys_script", [{ element: "script", extractAs: "js" }]) }
    );

    expect(record.redactions).toEqual([
      { field: "script.js", reason: "scan-overflow" },
    ]);
    expect(decode(record.extractedFiles[0].contents)).toBe(
      `${redactValue(body)}\n`
    );
  });
});

describe("sys_properties (§5.7)", () => {
  const propertyTable = table("sys_properties", [
    { element: "name" },
    { element: "value" },
  ]);

  const property = (
    name: string | null,
    value: string
  ): SerializedRecord =>
    serialized({
      table: "sys_properties",
      recordJsonValue: name === null ? { value } : { name, value },
    });

  it("passes an allowlisted property through verbatim", () => {
    // The rule the allowlist exists for. `isSensitiveKey` matches a bare `key`, so
    // this UI preference is redacted by default — and narrowing the pattern for
    // every table to spare it would be the wrong repair.
    const name = "glide.ui.polaris.keyboard_shortcuts";
    const record = redactRecord(property(name, "true"), {
      table: propertyTable,
      redaction: { propertyAllowlist: [name] },
    });

    expect(record.redactions).toEqual([]);
    const envelope = envelopeOf(record.recordJsonBytes);
    expect(envelope.value).toBe("true");
    expect(envelope.name).toBe(name);
  });

  it("redacts the same property when it is not allowlisted", () => {
    // Non-vacuity for the test above: without it, an allowlist that did nothing at
    // all would look identical.
    const name = "glide.ui.polaris.keyboard_shortcuts";
    const record = redactRecord(property(name, "true"), { table: propertyTable });

    expect(record.redactions).toEqual([{ field: "value", reason: "key-pattern" }]);
    expect(envelopeOf(record.recordJsonBytes).value).toBe(redactValue("true"));
  });

  it("tests the property NAME, not the literal column name", () => {
    // `isSensitiveKey("value")` is false, so a redactor that tested the column
    // name would commit every property on the instance, this one included.
    const record = redactRecord(
      property("glide.rest.outbound.password", "hunter2"),
      { table: propertyTable, redaction: { propertyAllowlist: [] } }
    );

    expect(record.redactions).toEqual([{ field: "value", reason: "key-pattern" }]);
    expect(decode(record.recordJsonBytes)).not.toContain("hunter2");
  });

  it("still scans the value of an allowlisted property", () => {
    // The allowlist exempts a property from the KEY rule only. An operator who
    // allowlisted a property before someone stored a private key in it does not
    // thereby consent to committing the private key.
    const name = "glide.ui.polaris.keyboard_shortcuts";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    const record = redactRecord(property(name, pem), {
      table: propertyTable,
      redaction: { propertyAllowlist: [name] },
    });

    expect(record.redactions).toEqual([{ field: "value", reason: "value-scan" }]);
  });

  it("fails closed when the row carries no readable name", () => {
    // The name is what the decision rests on. Without it there is no decision to
    // make, so the value is treated as sensitive.
    const record = redactRecord(property(null, "true"), {
      table: propertyTable,
      redaction: { propertyAllowlist: ["glide.ui.polaris.keyboard_shortcuts"] },
    });

    expect(record.redactions).toEqual([{ field: "value", reason: "key-pattern" }]);
  });

  it("fails closed when the name column is not a string", () => {
    const record = redactRecord(
      serialized({
        table: "sys_properties",
        recordJsonValue: { name: 42, value: "true" },
      }),
      { table: propertyTable }
    );

    expect(record.redactions).toEqual([{ field: "value", reason: "key-pattern" }]);
  });

  it("passes a benign, non-allowlisted property through", () => {
    // The allowlist is an exemption from an over-eager pattern, not the only way
    // to keep a property. Most of the table is ordinary configuration.
    const record = redactRecord(property("glide.servlet.uri", "/nav_to.do"), {
      table: propertyTable,
    });

    expect(record.redactions).toEqual([]);
    expect(envelopeOf(record.recordJsonBytes).value).toBe("/nav_to.do");
  });

  it("applies the allowlist to no other table", () => {
    // `value` on `sys_choice` is not a property value, and an allowlist entry must
    // not become a global exemption for a column that happens to share its name.
    const record = redactRecord(
      serialized({
        table: "sys_choice",
        recordJsonValue: { name: "incident", value: "1" },
      }),
      { table: table("sys_choice", [{ element: "name" }, { element: "value" }]),
        redaction: { propertyAllowlist: ["incident"] } }
    );

    expect(record.redactions).toEqual([]);
  });
});

describe("nested JSON blobs", () => {
  it("names the leaf it redacted with a dotted path", () => {
    const record = redactRecord(
      serialized({
        recordJsonValue: {
          variables: { note: "fine", password: "hunter2" },
        },
      }),
      { table: table("sc_req_item", [{ element: "variables", isJsonBlob: true }]) }
    );

    expect(record.redactions).toEqual([
      { field: "variables.password", reason: "key-pattern" },
    ]);
    const envelope = envelopeOf(record.recordJsonBytes);
    const variables = envelope.variables as Record<string, unknown>;
    expect(variables.note).toBe("fine");
    expect(variables.password).toBe(redactValue("hunter2"));
  });

  it("indexes an array element in the path", () => {
    const secret = SECRET_VALUES[0].value;
    const record = redactRecord(
      serialized({ recordJsonValue: { steps: ["ok", secret] } }),
      { table: table("sys_flow", [{ element: "steps", isJsonBlob: true }]) }
    );

    expect(record.redactions).toEqual([
      { field: "steps[1]", reason: "value-scan" },
    ]);
    expect(envelopeOf(record.recordJsonBytes).steps).toEqual([
      "ok",
      redactValue(secret),
    ]);
  });

  it("scans a leaf however deeply it is buried", () => {
    const record = redactRecord(
      serialized({
        recordJsonValue: {
          spec: { steps: [{ inputs: { token: "abc" } }] },
        },
      }),
      { table: table("sys_hub_flow", [{ element: "spec", isJsonBlob: true }]) }
    );

    expect(record.redactions).toEqual([
      { field: "spec.steps[0].inputs.token", reason: "key-pattern" },
    ]);
  });

  it("leaves non-string leaves alone", () => {
    const record = redactRecord(
      serialized({
        recordJsonValue: {
          note: null,
          spec: { count: 3, active: true, missing: null },
        },
      }),
      { table: table("incident", []) }
    );

    expect(record.redactions).toEqual([]);
    expect(envelopeOf(record.recordJsonBytes)).toEqual({
      spec: { active: true, count: 3, missing: null },
      note: null,
    });
  });

  it("does not let a blob key named __proto__ repoint a prototype", () => {
    // `JSON.parse` hands `__proto__` over as an ordinary own property; assigning
    // it on a normal object would either lose it or repoint the prototype of
    // content the mirror does not control.
    const record = redactRecord(
      serialized({
        recordJsonValue: {
          spec: JSON.parse('{"__proto__": {"polluted": true}, "ok": "yes"}') as unknown,
        },
      }),
      { table: table("incident", [{ element: "spec", isJsonBlob: true }]) }
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(decode(record.recordJsonBytes)).toContain("polluted");
  });
});

describe("extracted files", () => {
  const scriptTable = table("sys_script", [
    { element: "script", extractAs: "js" },
    { element: "private_key", extractAs: "txt" },
  ]);

  it("writes a benign body verbatim with exactly one trailing newline (§8)", () => {
    const record = redactRecord(
      serialized({
        extractedFiles: [{ fileName: "script.js", contents: "gs.log('ok');" }],
      }),
      { table: scriptTable }
    );

    expect(record.redactions).toEqual([]);
    expect(decode(record.extractedFiles[0].contents)).toBe("gs.log('ok');\n");
    expect(record.extractedFiles[0].contents).toBeInstanceOf(Uint8Array);
  });

  it("does not double a newline the body already ends with", () => {
    const record = redactRecord(
      serialized({
        extractedFiles: [{ fileName: "script.js", contents: "gs.log('ok');\n" }],
      }),
      { table: scriptTable }
    );

    expect(decode(record.extractedFiles[0].contents)).toBe("gs.log('ok');\n");
  });

  it("scans a script body like any other string", () => {
    // A secret pasted into a business rule is the most common way one reaches a
    // mirror, and extraction to a sibling file is a layout decision that must not
    // double as a security exemption.
    const secret = SECRET_VALUES[9].value;
    const record = redactRecord(
      serialized({
        extractedFiles: [
          { fileName: "script.js", contents: `var k = '${secret}';` },
        ],
      }),
      { table: scriptTable }
    );

    expect(record.redactions).toEqual([
      { field: "script.js", reason: "value-scan" },
    ]);
    expect(decode(record.extractedFiles[0].contents)).not.toContain(secret);
  });

  it("redacts a body whose column name is itself sensitive", () => {
    const record = redactRecord(
      serialized({
        extractedFiles: [
          { fileName: "private_key.txt", contents: "not actually a key" },
        ],
      }),
      { table: scriptTable }
    );

    expect(record.redactions).toEqual([
      { field: "private_key.txt", reason: "key-pattern" },
    ]);
  });

  it("maps a dotless file name to a column of the same name", () => {
    // Nothing the serializer emits looks like this, so the branch exists only so
    // that an unexpected name still gets a rule applied instead of skipping one.
    const record = redactRecord(
      serialized({ extractedFiles: [{ fileName: "token", contents: "abc" }] }),
      { table: table("sys_script", []) }
    );

    expect(record.redactions).toEqual([{ field: "token", reason: "key-pattern" }]);
  });

  it("keeps a UTF-8 body's bytes rather than its code units", () => {
    const record = redactRecord(
      serialized({
        extractedFiles: [{ fileName: "script.js", contents: "// ключ\n" }],
      }),
      { table: scriptTable }
    );

    expect(record.extractedFiles[0].contents).toEqual(
      new Uint8Array(Buffer.from("// ключ\n", "utf8"))
    );
  });
});

describe("the marker (§11, INV-1)", () => {
  const markerOf = (value: string): unknown => {
    const record = redactRecord(
      serialized({ recordJsonValue: { password: value } }),
      { table: table("incident", [{ element: "password" }]) }
    );
    return envelopeOf(record.recordJsonBytes).password;
  };

  it("is the same for the same secret and different for a changed one", () => {
    // Both halves matter and pull in opposite directions. Stability is INV-1: an
    // unchanged instance must re-run to a byte-identical tree, so an unchanged
    // credential must not produce a diff. Sensitivity is the other half — a
    // CONSTANT marker would satisfy INV-1 perfectly and hide a rotation, which is
    // exactly the event an operator reads a mirror to notice.
    expect(markerOf("hunter2")).toBe(markerOf("hunter2"));
    expect(markerOf("hunter2")).not.toBe(markerOf("hunter3"));
  });

  it("is the redaction package's marker, not a locally-shaped lookalike", () => {
    // §11: the prefix and the digest length have ONE home. Asserting against the
    // borrowed constants means a change there fails here instead of drifting.
    const marker = markerOf("hunter2") as string;
    expect(marker).toBe(redactValue("hunter2"));
    expect(marker.startsWith(REDACTION_MARKER_PREFIX)).toBe(true);
    expect(marker.slice(REDACTION_MARKER_PREFIX.length)).toHaveLength(
      REDACTION_MARKER_HASH_CHARS
    );
  });

  it("does not leak the plaintext it stands for", () => {
    expect(markerOf("hunter2")).not.toContain("hunter2");
  });
});

describe("determinism (INV-1, INV-7)", () => {
  it("produces identical bytes for identical input", () => {
    const input = (): SerializedRecord =>
      serialized({
        recordJsonValue: {
          description: SECRET_VALUES[3].value,
          variables: { password: "hunter2" },
          name: "acme",
        },
        extractedFiles: [{ fileName: "script.js", contents: "gs.log(1);" }],
      });
    const options = {
      table: table("sys_script", [{ element: "script", extractAs: "js" }]),
      redaction: { propertyAllowlist: [] },
    };

    const first = redactRecord(input(), options);
    const second = redactRecord(input(), options);

    expect(second.recordJsonBytes).toEqual(first.recordJsonBytes);
    expect(second.extractedFiles).toEqual(first.extractedFiles);
    expect(second.redactions).toEqual(first.redactions);
  });

  it("orders the envelope and the redaction list by key, not by arrival", () => {
    // §8 sorts the bytes; the redaction LIST has to be stable too, or two runs of
    // an unchanged instance would produce two different run reports.
    const forward = redactRecord(
      serialized({ recordJsonValue: { alpha: "hunter2", zulu: "hunter2" } }),
      { table: table("incident", [{ element: "alpha" }, { element: "zulu" }]) }
    );
    const reversed = redactRecord(
      serialized({
        recordJsonValue: JSON.parse('{"zulu":"hunter2","alpha":"hunter2"}') as Record<
          string,
          unknown
        >,
      }),
      { table: table("incident", [{ element: "alpha" }, { element: "zulu" }]) }
    );

    expect(reversed.recordJsonBytes).toEqual(forward.recordJsonBytes);
    expect(reversed.redactions).toEqual(forward.redactions);
  });
});

describe("the envelope's bytes (§8)", () => {
  it("carries the record's identity through unchanged", () => {
    const record = redactRecord(
      serialized({ sysId: "cc11000000000000000000000000dd22", table: "sys_script" }),
      { table: table("sys_script", []) }
    );

    expect(record.sysId).toBe("cc11000000000000000000000000dd22");
    expect(record.table).toBe("sys_script");
  });

  it("renders sorted keys, two-space indent and one trailing newline", () => {
    const record = redactRecord(
      serialized({ recordJsonValue: { zulu: "z", alpha: "a" } }),
      { table: table("incident", []) }
    );

    expect(decode(record.recordJsonBytes)).toBe(
      '{\n  "alpha": "a",\n  "zulu": "z"\n}\n'
    );
  });
});
