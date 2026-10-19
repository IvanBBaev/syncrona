// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @syncrona/mirror — the full-instance ServiceNow git mirror engine.
 *
 * The engine is a chain of stages (architecture §5): Catalog → Planner → Fetcher
 * → Serializer → Redactor → Writer → ReportGenerator. Each stage is a separate
 * work package; this entry point is what they are published behind, and it is
 * grown one stage at a time.
 *
 * The package takes no third-party runtime dependency and, in particular, MUST
 * NOT depend on the `syncrona` core CLI package (§4.1): the mirror is a library
 * the CLI drives, not a feature inside it, and the dependency edge only ever
 * points one way. Its three workspace dependencies — `@syncrona/sn-transport`,
 * `@syncrona/redaction` and `@syncrona/credential-store` — are all foundation
 * packages that sit BELOW the CLI, so importing them keeps that edge pointing the
 * same way.
 *
 * Currently exported: the shared contracts and constants, the serializer (WP-M5),
 * the redactor and the row pipeline (WP-M6), the config loader and the HTTP client
 * (WP-M3), the catalog service (WP-M4), the writer, shard store and path
 * derivation (WP-M7), the Planner, the Fetcher, the checkpoint, the
 * ReportGenerator and the sweep orchestrator `runMirrorCommand` (WP-M8) — the
 * last being the one function that runs the whole chain in order, which is what
 * WP-M9's CLI calls — the reconciler (WP-M10), `status` and `verify` (WP-M11),
 * the derived views (WP-M12), and the attachment planner plus the
 * `.gitattributes` scaffolds (WP-M12b).
 *
 * Four of those are exported even though `runMirrorCommand` already drives them,
 * and each has a caller outside a sweep. `generateDerivedViews` is what the INV-9
 * CI check runs: regenerate from canonical alone and fail on any diff, which only
 * works if the check can call the same function the sweep called rather than a
 * re-implementation. `detectDrift` and `verifyMirror` are `mirror status` and
 * `mirror verify` — two commands that answer questions about a tree without
 * touching an instance. `reconcileSweep` opens no door that `applyAuthorizedDeletion`
 * (exported since WP-M7) did not: both need a `DeletionAuthority`, and that object
 * is mintable only by a Writer that saw a whole table.
 *
 * `readOnlyWriterFs` and `MirrorReadOnlyViolation` come with them, because
 * "verify performs zero writes" (§12) is worth more as a wrapper a caller can put
 * around any of these than as a claim in a docblock — the violation is a thrown
 * error naming the method and path, so a consumer can assert on it too.
 *
 * `./checkpoint` and `./write/sweepProgress` are both exported and both name a
 * checkpoint, which looks like one module too many until you ask who is allowed to
 * mint `preQuiescence`. That field is evidence ABOUT THE INSTANCE, gathered by the
 * Planner through an Aggregate call; the Writer never queries the instance, so its
 * view of the file is `Omit<CheckpointState, "preQuiescence">` and it is
 * structurally unable to invent a quiescence reading. Merging the two would hand it
 * a field it could fill in, and D1's whole point is that quiescence is proven
 * rather than assumed. The two therefore share a format and a path but not a type,
 * and each reads the other's files in test.
 *
 * The four absences below are deliberate, and each is an invariant rather than an
 * oversight:
 *
 * - `syncCounter` holds the §5.4 reconcile cadence — the count that decides which
 *   sync is promoted to the mode that can delete. A consumer able to write it can
 *   push the next reconcile arbitrarily far into the future, which is the same
 *   authority INV-5 spends the reconciler refusing to grant, obtained without
 *   producing any evidence at all. `runMirrorCommand` reads it, advances it and
 *   reports the position it reached (`RunMirrorResult.syncCadence`), so a caller can
 *   see the cadence and force a reconcile with an option — and cannot forge one.
 *   `write/gitIgnore` travels with it for the same reason inverted: the scaffold is
 *   what keeps that state out of git, and it is provisioned by every run rather than
 *   left to a caller who might not.
 *
 * - `catalog/fieldPolicy` and `catalog/tiers` are the catalog's internal policy.
 *   `catalogService` re-exports the parts of them that are genuinely part of its
 *   result; exporting the tables as well would invite a caller to re-derive a
 *   decision the service already made, which is how two answers to "is this column
 *   extracted?" come to exist.
 *
 * - `write/atomicWrite` would hand a consumer `atomicWriteFile` — a supported way
 *   to put arbitrary bytes into the mirror tree without passing the redactor
 *   (INV-3) or being claimed by a completed shard (INV-4). The two staging-name
 *   predicates ARE exported below, by name, because anything that walks the tree
 *   has to be able to tell a crashed run's leftovers from real content; the write
 *   primitives are not.
 *
 * - `write/recordPath` owns naming. The name a record has on disk is decided once,
 *   by the writer, and recorded in its shard entry; a consumer able to re-run the
 *   resolver is a consumer able to compute a name that disagrees with the tree.
 *
 * `writeCoverageReport` and `writeMirrorReport` ARE exported, and the contrast with
 * `atomicWriteFile` above is the whole test: the rule is not "no function that
 * touches the disk", it is "nothing that lets a consumer choose both the bytes and
 * the path". Those two choose neither. Each takes a typed {@link CoverageReport},
 * renders it itself through the one canonical renderer, and writes it to one fixed
 * name at the repo root — outside `instance/`, so neither INV-3 nor INV-4 has
 * jurisdiction over what they produce.
 *
 * WP-M12b's two modules are exported unevenly, and the split is that same rule
 * applied twice. `write/gitAttributes` goes out whole: three of its four names are
 * pure byte builders, and `provisionGitAttributes` has the `writeCoverageReport`
 * shape — a typed {@link MirrorConfig} in, one fixed name at the repo root out,
 * the caller choosing neither the bytes nor the path. It has to be exported, and
 * not only for symmetry: `syncrona mirror init` is the command that puts the
 * scaffold in place, and the CLI lives in another package, so an unexported
 * provisioner is a repository whose line endings are the checkout's (INV-1) on
 * every clone that is not the author's.
 *
 * `write/attachments` goes out BY NAME for the `atomicWrite` reason.
 * `applyAttachmentPlan` does not have that shape: an {@link AttachmentPlan} is a
 * plain interface, so a hand-built one names its own `path` and carries its own
 * `bytes`, and `toNativePath` deliberately does not re-check containment — its
 * callers derive their paths through `shards/shardLayout`, which is where the
 * check lives. Exporting it would be exporting `atomicWriteFile` behind a longer
 * signature, with a directory prune attached. What does go out is the pure planner,
 * the path derivation and the directory name: `planRecordAttachments` touches no
 * disk, `attachmentDirRelPath` derives a path exactly as the already-exported
 * `recordDirRelPath` does, and `ATTACHMENTS_DIR_NAME` is the design §8.4 layout
 * that anything reading a tree it did not write — `verify`, a CI check — has to
 * agree with rather than restate.
 *
 * Note what is deliberately NOT re-exported: there is no way to obtain a
 * {@link RedactedRecord} from this barrel other than `redactRecord` /
 * `serializeAndRedact`. That is INV-3 expressed as an export list — the brand is
 * mintable in exactly one module, so a consumer holding a record it can write is a
 * consumer that went through redaction.
 */
export * from "./checkpoint";
export * from "./constants";
export * from "./contracts";
export * from "./catalog/catalogService";
export * from "./config/loadConfig";
export * from "./derived/derivedViews";
export * from "./http/client";
export * from "./order";
export * from "./pipeline";
export * from "./report/commitMetadata";
export * from "./report/coverageReport";
export * from "./report/reportMarkdown";
export * from "./runMirrorCommand";
export * from "./serialize/redactor";
export * from "./serialize/serializer";
export * from "./shards/shardLayout";
export * from "./shards/shardStore";
export * from "./status/driftDetector";
export * from "./status/readOnlyFs";
export * from "./status/verifier";
export * from "./sync/fetcher";
export * from "./sync/planner";
export * from "./sync/reconciler";
export * from "./write/deletionAuthority";
export * from "./write/fs";
export * from "./write/gitAttributes";
export * from "./write/sweepProgress";
export * from "./write/writer";
export { STAGING_PREFIX, isStagingName } from "./write/atomicWrite";
export {
  ATTACHMENTS_DIR_NAME,
  attachmentDirRelPath,
  planRecordAttachments,
  type AttachmentEntry,
  type AttachmentPayload,
  type AttachmentPlan,
  type AttachmentPlanRequest,
} from "./write/attachments";
