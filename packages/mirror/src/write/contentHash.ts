// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one content-hash primitive in the package (§4.3, §11).
 *
 * `RecordEntry.contentHash` and `AttachmentEntry.sha256` are both "lowercase hex
 * sha-256 of these bytes", minted by the writer and checked, later and elsewhere,
 * by `mirror status --deep` and `mirror verify`. Those two sides have to agree
 * exactly or a clean tree reports as drifted, which is why §11's "never a second
 * implementation of a rule another module owns" applies to a one-line function
 * that looks far too small to deserve a module.
 *
 * It got one because it had grown to three copies. `write/writer.ts` had it for
 * shard entries, the former `status/recordHash.ts` had it for verification (that
 * module was an empty shell once the hash moved here, and is gone), and
 * `write/attachments.ts` had a third — that last one unavoidably, because the
 * writer imports the attachments module, so an edge back for the hash would have
 * been a runtime cycle and `no-circular` rejects it. A leaf that depends on
 * nothing inside this package is the shape that resolves that: every one of the
 * three can import it, and none of them gains a dependency on another.
 *
 * ## Why the module is this small, and stays this small
 *
 * There is deliberately no `sha256HexOf(text)`, no encoding argument, and no
 * algorithm parameter. What makes the triplication harmless TODAY is that "sha-256
 * hex of these bytes" admits exactly one meaning — the real owner of the rule is
 * `node:crypto`, and a copy cannot drift from a copy when neither has a decision
 * in it. The hazard the copies carried was the FUTURE one: the day someone adds a
 * `{ encoding }` option to one call site, the tree stops agreeing with the shard
 * about what its own files hash to, and the disagreement surfaces as a verify
 * finding on a repository nobody touched. Keeping this module without a policy
 * knob is what keeps that day from arriving through a local edit.
 *
 * Hex rather than base64 because the value is committed to git and read by humans
 * in diffs, and it matches what `sha256sum` on the same file prints — which makes
 * a shard entry's claim checkable from a shell, without the mirror.
 */
import { createHash } from "node:crypto";

/** Lowercase hex sha-256 of the given bytes — the `contentHash` rule. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
