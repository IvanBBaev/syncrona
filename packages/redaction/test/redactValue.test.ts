// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";

import { SECRET_VALUES } from "./corpus";
import {
  REDACTION_MARKER_HASH_CHARS,
  REDACTION_MARKER_PREFIX,
  redactValue,
} from "../src/index";

const MARKER = new RegExp(`^${REDACTION_MARKER_PREFIX}[0-9a-f]{${REDACTION_MARKER_HASH_CHARS}}$`);

describe("redactValue", () => {
  it("produces the documented marker shape", () => {
    expect(redactValue("hunter2")).toMatch(MARKER);
    expect(REDACTION_MARKER_PREFIX).toBe("__SYNCRONA_REDACTED__");
    expect(REDACTION_MARKER_HASH_CHARS).toBe(12);
  });

  it("is deterministic for the same plaintext", () => {
    // The mirror writes redacted fields into a git tree. If the marker were random
    // (or salted per run), re-syncing an unchanged instance would produce a diff on
    // every secret-bearing field of every record — the mirror's core invariant is
    // that an unchanged instance re-serialises byte-identically.
    for (const { value } of SECRET_VALUES) {
      expect(redactValue(value)).toBe(redactValue(value));
    }
  });

  it("changes when the plaintext changes, so a rotation still shows up as a diff", () => {
    // The other half of the trade. A constant marker would be simpler and would
    // erase history: rotating a credential would produce no diff at all, and the
    // one event most worth seeing in a mirror is the one that becomes invisible.
    const before = redactValue("hunter2");
    const after = redactValue("hunter3");
    expect(before).not.toBe(after);
    expect(after).toMatch(MARKER);
  });

  it("never leaks the plaintext it replaces", () => {
    // Cheap to assert, catastrophic to get wrong: the whole point of the function is
    // that its output can be committed to a repository.
    for (const { value } of SECRET_VALUES) {
      const marker = redactValue(value);
      expect(marker).not.toContain(value);
      expect(marker).toHaveLength(REDACTION_MARKER_PREFIX.length + REDACTION_MARKER_HASH_CHARS);
    }
  });

  it("uses the first 12 hex characters of the sha256 of the plaintext", () => {
    // Pins the digest to an exact, externally reproducible definition. Anyone
    // auditing a mirror can recompute a marker with `sha256sum` and confirm which
    // plaintext a field held at a point in history, given a candidate.
    const plaintext = "https://admin:hunter2@dev12345.service-now.com/api";
    const digest = createHash("sha256").update(plaintext, "utf8").digest("hex");
    expect(redactValue(plaintext)).toBe(`${REDACTION_MARKER_PREFIX}${digest.slice(0, 12)}`);
  });

  it("is stable for non-ASCII plaintext", () => {
    // The digest is taken over an explicit utf8 encoding, so the marker cannot vary
    // with the platform's default encoding. A mirror synced from two machines must
    // produce the same bytes.
    const plaintext = "паролата-ми-е-таjна";
    const digest = createHash("sha256").update(Buffer.from(plaintext, "utf8")).digest("hex");
    expect(redactValue(plaintext)).toBe(`${REDACTION_MARKER_PREFIX}${digest.slice(0, 12)}`);
  });

  it("returns a well-defined marker for the empty string", () => {
    // Callers decide WHETHER to redact; this function must not also decide. Returning
    // the plaintext for an empty input would make the output type "marker or
    // plaintext", and a caller that trusted the marker shape would be wrong exactly
    // once — on the value that happened to be empty.
    expect(redactValue("")).toMatch(MARKER);
  });

  it("distinguishes plaintexts that differ only in trailing whitespace", () => {
    // No trimming, no normalisation: a redactor that normalised its input would map
    // two different stored secrets onto one marker and hide a real change.
    expect(redactValue("hunter2")).not.toBe(redactValue("hunter2 "));
  });
});
