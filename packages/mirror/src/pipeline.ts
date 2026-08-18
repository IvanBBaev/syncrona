// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Row → bytes, in one call — architecture §5.7, INV-3.
 *
 * The serializer and the redactor are separate modules because they answer separate
 * questions (§8 shape versus §5.7 content) and are tested separately. But a caller
 * that gets to hold the intermediate {@link SerializedRecord} is a caller that can
 * write it, and that record still contains every plaintext the wire carried. INV-3
 * says no pre-redaction bytes reach disk; this module is how that is made structural
 * rather than a rule people remember.
 *
 * So the two stages are composed here, the intermediate never leaves the function,
 * and what comes back is a {@link RedactedRecord} — which the Writer will accept —
 * plus the parse failures, which the run report needs and which are field NAMES, not
 * field values. Everything downstream (WP-M7's writer, WP-M8's report) consumes this
 * function; a stage that called `serializeRow` directly would be visible in review
 * as exactly the bypass it is.
 */
import type { RedactedRecord } from "./contracts";
import { redactRecord, type RedactionOptions } from "./serialize/redactor";
import { serializeRow } from "./serialize/serializer";

/** What one row produces once it is safe to write. */
export interface MirrorPipelineResult {
  /** The only record shape the Writer accepts (§4.6). */
  record: RedactedRecord;
  /**
   * Columns whose JSON blob did not parse and were written under the `raw:` marker
   * (F6). Names only — the values stay inside the record, where they have been
   * scanned like any other string. R3 forbids a silent skip, so these are carried
   * out to the run report rather than logged and dropped.
   */
  parseFailures: string[];
}

/**
 * Serialize a wire row and redact it in one step, never exposing the intermediate.
 *
 * Pure, like both stages it composes (INV-7): same row and same options in, same
 * bytes out, no clock and no ambient state, which is what lets INV-1 claim that an
 * unchanged instance re-runs to a byte-identical tree.
 */
export function serializeAndRedact(
  row: Record<string, unknown>,
  options: RedactionOptions
): MirrorPipelineResult {
  const serialized = serializeRow(row, options.table);
  return {
    record: redactRecord(serialized, options),
    // A copy: the caller must not be able to reach back into the intermediate by
    // mutating an array it shares with a record that no longer exists.
    parseFailures: [...serialized.parseFailures],
  };
}
