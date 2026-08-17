// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @syncrona/redaction — shared secret detection and redaction.
 *
 * WHY THIS PACKAGE EXISTS
 *
 * The detectors below grew inside `packages/mcp-server/src/audit.ts`, hardened one
 * review at a time (REV-96 → REV-126 → REV-145 → REV-147 → REV-190). They are now
 * needed by a second consumer with a much larger blast radius: the full-instance git
 * mirror, which writes an entire ServiceNow instance into a git tree. A copy-paste
 * would have meant two corpora drifting apart, and the direction of that drift is
 * predictable — the copy nobody is currently reviewing falls behind, and the leak
 * lands in the consumer that writes to a repository rather than to a local log file.
 *
 * So the scanner is a package, with its own versioned corpus tests, and both
 * consumers import it (design §13.3, mirror-architecture §3 / WP-M1).
 *
 * DESIGN CONSTRAINTS
 *
 *  - **Leaf package.** It depends on no other `@syncrona/*` package — only on
 *    `node:crypto`. That is an acceptance criterion, not a preference: a security
 *    primitive that sits at the bottom of the dependency graph can be audited on its
 *    own and can never be made to import something that imports it back.
 *  - **Pure and synchronous.** No I/O, no clock, no configuration. The mcp-server
 *    calls this while holding the audit lock and the mirror calls it once per field
 *    of every record on an instance, so the cost has to be bounded and the result has
 *    to be a function of the input alone.
 *  - **Fail closed.** Every guard in here resolves an "I cannot tell" toward
 *    redaction. See {@link SCAN_BUDGET}.
 *
 * WHAT IS NOT HERE
 *
 * Field-TYPE deny (drop a column because `sys_dictionary` says its `internal_type` is
 * `password`/`password2`) belongs to the caller: it needs schema knowledge this
 * package deliberately does not have. It is nonetheless the strongest of the three
 * signals — measured on a real instance, a `password2` column returns a 106-character
 * ciphertext over the Table API, which no value-shape rule here would flag
 * (mirror-architecture §5.7 / D19). Never weaken that path on the strength of this
 * one.
 */

export {
  REDACTION_MARKER_HASH_CHARS,
  REDACTION_MARKER_PREFIX,
  SCAN_BUDGET,
} from "./constants";
export { isSensitiveKey } from "./sensitiveKeys";
export { looksLikeSecretValue } from "./secretValues";
export { redactValue } from "./redactValue";
