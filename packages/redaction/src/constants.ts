// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tunables shared by the detectors and the redaction marker.
 *
 * They live in their own module so a consumer can assert against the SAME
 * number the scanner uses. `packages/mcp-server` has a regression test that
 * pads a value to exactly the budget and one byte past it; a test that hardcodes
 * `8192` while the scanner drifts to another value would keep passing while
 * testing nothing.
 */

/**
 * Upper bound, in UTF-16 code units, on the length of a value the detectors will
 * scan in full.
 *
 * SEC-8 follow-up (REV-145): the length guard used to `return false` for anything
 * over the budget — a plain fail-OPEN. Padding a secret past 8 KB (trivial for a
 * model-supplied argument, a pasted PEM bundle or a verbose remote error body) was
 * all it took to get it written to the audit log in cleartext. The budget exists to
 * bound regex work, not to whitelist large strings, so a value that cannot be
 * scanned in full is now treated as a secret instead of trusted.
 *
 * The mirror inherits the same rule under a different name: an over-budget value is
 * redacted whole with reason `scan-overflow` (mirror-architecture §5.7, F7).
 */
export const SCAN_BUDGET = 8192;

/**
 * Prefix of the mirror's stable redaction marker
 * (`__SYNCRONA_REDACTED__<sha256-12>`), fixed by mirror-architecture §11.
 *
 * The prefix is deliberately loud and unlikely to occur in real ServiceNow field
 * content, so `grep` over a mirror tree finds every redaction and a reviewer can
 * never mistake a marker for data.
 */
export const REDACTION_MARKER_PREFIX = "__SYNCRONA_REDACTED__";

/**
 * Number of leading hex characters of the sha256 digest embedded in a marker.
 *
 * 12 hex chars = 48 bits. That is far too little to invert or brute-force a real
 * secret out of, and still enough that two DIFFERENT secrets in the same tree
 * essentially never collide — which is the property the marker exists for: a
 * rotated credential must produce a marker that CHANGES, so the git history of a
 * mirror still shows "this secret was rotated here" without ever showing the
 * secret.
 */
export const REDACTION_MARKER_HASH_CHARS = 12;
