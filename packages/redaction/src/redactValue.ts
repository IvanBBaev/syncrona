// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The stable redaction marker.
 *
 * Two consumers, two different needs:
 *
 *  - `packages/mcp-server`'s audit trail replaces a secret with a CONSTANT string.
 *    Its records are append-only forensic lines nobody diffs, and a constant is the
 *    smallest thing that cannot leak.
 *  - The mirror writes a git tree that is re-generated on every sync and diffed
 *    forever. A constant there would erase real history: rotating a credential would
 *    produce no diff at all, so the tree would claim nothing changed when a secret
 *    had in fact been replaced.
 *
 * `redactValue` serves the second need. The marker embeds a short digest OF THE
 * PLAINTEXT, so the same secret is stable across syncs (INV-1: unchanged instance
 * state → byte-identical tree) while a changed secret produces a changed marker.
 */

import { createHash } from "node:crypto";
import { REDACTION_MARKER_HASH_CHARS, REDACTION_MARKER_PREFIX } from "./constants";

/**
 * Replace a secret with its stable, non-reversible marker
 * (`__SYNCRONA_REDACTED__<sha256-12>`).
 *
 * The digest is taken over the UTF-8 bytes of the plaintext, explicitly, so the
 * marker for a given secret does not depend on the ambient default encoding of the
 * Node version that produced it — a mirror tree written by one machine has to be
 * byte-identical to one written by another.
 *
 * SECURITY: the marker is a one-way function of the secret. 48 bits is not enough to
 * invert, but it IS enough to confirm a guess, so a marker still must not be treated
 * as public: a mirror repository is backup-equivalent and stays private
 * (mirror-architecture §9).
 */
export function redactValue(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${REDACTION_MARKER_PREFIX}${digest.slice(0, REDACTION_MARKER_HASH_CHARS)}`;
}
