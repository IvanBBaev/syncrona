// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The read-only filesystem seam for `mirror status` and `mirror verify`.
 *
 * Architecture §5.10 gives both commands one sentence each and the same last
 * word: status is a comparison, verify "reports, never mutates". This module is
 * that word made structural instead of aspirational, in two steps:
 *
 * - {@link MirrorReadFs} is the type the status stages accept — a `Pick` of
 *   {@link WriterFs} down to `readFile` and `readDir`. A caller cannot hand the
 *   detector or the verifier a write capability, because no parameter has a slot
 *   for one. This is the same move the barrel makes by not exporting
 *   `atomicWriteFile`: the safe property is carried by what the type system
 *   refuses to accept, not by a code review promising the methods go unused.
 *
 * - {@link readOnlyWriterFs} widens a {@link MirrorReadFs} back into the full
 *   {@link WriterFs} shape, with every mutating method replaced by one that
 *   throws {@link MirrorReadOnlyViolation}. The widening exists because the shard
 *   readers this package must reuse — `loadShardSet` and the walk conventions
 *   around it — take a full `WriterFs`. §11 forbids re-implementing a rule
 *   another module owns, and shard parsing is exactly such a rule (INV-5: a
 *   corrupt shard must never read as an empty one), so the readers are reused
 *   as-is and the seam they demand is satisfied with a shape that detonates on
 *   first write. Reuse without the widening would mean either forking the shard
 *   reader (re-implementing INV-5's trust boundary) or passing a real writable
 *   fs (trusting a comment instead of a type).
 *
 * The throw is not dead code ornamentation. `loadShardSet` today only reads, but
 * it lives in the writer's module family and nothing in ITS contract promises it
 * never will write; if a future revision adds a repair or restamp step, every
 * status run would fail loudly on the first mutation instead of silently editing
 * the tree it is supposed to be judging. The test suite pins the same property
 * from the outside with a recording fs spy; this class is the inside half —
 * defence at the seam, evidence in the test.
 */

import type { WriterFs } from "../write/fs";

/**
 * What `mirror status` and `mirror verify` are allowed to do to the tree:
 * read files, list directories, nothing else. Both methods keep `WriterFs`'s
 * exact semantics — `null` for an absent file or directory, never a throw for
 * mere absence — so anything written against this type composes with the
 * writer's helpers unchanged.
 */
export type MirrorReadFs = Pick<WriterFs, "readFile" | "readDir">;

/**
 * A mutating filesystem call reached a stage that §5.10 defines as read-only.
 *
 * This error is a bug report about THIS package, never about the user's tree or
 * instance: the only way to raise it is for code on the status path to call
 * `makeDir`, `writeFile`, `rename` or `removeRecursive` through the widened
 * seam, and no input — hostile, corrupt or otherwise — is supposed to be able
 * to make that happen. It deliberately does not extend the mirror's failure
 * taxonomy (`MirrorFailureClass` has no member for it) because classifying it
 * would imply a caller should handle it; the correct handling is a stack trace.
 */
export class MirrorReadOnlyViolation extends Error {
  /** The `WriterFs` method that was invoked. */
  readonly operation: "makeDir" | "writeFile" | "rename" | "removeRecursive";
  /** The native path (or `from -> to` pair) the call would have touched. */
  readonly target: string;

  constructor(operation: MirrorReadOnlyViolation["operation"], target: string) {
    super(
      `mirror status/verify are read-only, but ${operation} was invoked on ${target}; ` +
        `this is a bug in the status stages, not a problem with the mirror tree`
    );
    this.name = "MirrorReadOnlyViolation";
    this.operation = operation;
    this.target = target;
  }
}

/**
 * Widen a read-only fs into the {@link WriterFs} shape the shard readers demand,
 * with the four mutating methods replaced by throws.
 *
 * The read methods delegate — they do not bind — so a test double whose
 * `readFile`/`readDir` close over mutable state keeps working. The returned
 * object is a fresh literal per call and shares nothing with its argument
 * beyond the two delegated methods.
 */
export function readOnlyWriterFs(fs: MirrorReadFs): WriterFs {
  return {
    readFile: (filePath) => fs.readFile(filePath),
    readDir: (dir) => fs.readDir(dir),
    makeDir: (dir) => Promise.reject(new MirrorReadOnlyViolation("makeDir", dir)),
    writeFile: (filePath) =>
      Promise.reject(new MirrorReadOnlyViolation("writeFile", filePath)),
    rename: (from, to) =>
      Promise.reject(new MirrorReadOnlyViolation("rename", `${from} -> ${to}`)),
    removeRecursive: (target) =>
      Promise.reject(new MirrorReadOnlyViolation("removeRecursive", target)),
  };
}
