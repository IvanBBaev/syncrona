// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The package entry point — what `main` resolves to after `prepack`.
 *
 * Worth a test of its own for two reasons. The barrel is the only file a consumer
 * is guaranteed to touch, so a missing re-export is a broken package that every
 * unit test still passes; and the exported NAMES are the public API surface, so
 * pinning them turns an accidental rename into a failing test here rather than
 * into a silent breaking change in a published tarball.
 */
import * as mirror from "../src/index";
import { MAX_REQUESTS_PER_SECOND, SYS_ID_RE } from "@syncrona/sn-transport";
import { MAX_NAME_BYTES } from "@syncrona/sn-transport";
import { REDACTION_MARKER_PREFIX } from "@syncrona/redaction";

describe("@syncrona/mirror entry point", () => {
  it("re-exports exactly the runtime surface it promises", () => {
    // Types (`FieldDescriptor`, `TableCatalogEntry`, `SerializedRecord`,
    // `MirrorConfig`, the transport seam …) are deliberately absent from this
    // list: they are erased at runtime and are checked by the compiler instead.
    expect(Object.keys(mirror).sort()).toEqual([
      // Serializer (WP-M5) and the format pins.
      "FORMAT_VERSION",
      "JSON_INDENT",
      "RAW_MARKER_PREFIX",
      "canonicalJsonBytes",
      "canonicalJsonText",
      "encodeUtf8",
      "serializeRow",
      "withTrailingNewline",
      // Redactor and the row pipeline (WP-M6). `RedactedRecord`, `Redaction`,
      // `RedactionReason`, `RedactionOptions` and `MirrorPipelineResult` are types
      // and so are absent for the same reason as the contracts above.
      "redactRecord",
      "serializeAndRedact",
      // §11 constants owned by this package (WP-M3).
      "LFS_THRESHOLD_BYTES",
      "PAGE_SIZE_DEFAULT",
      "RPS_DEFAULT",
      "SHARD_FANOUT_THRESHOLD_1",
      "SHARD_FANOUT_THRESHOLD_2",
      "WATERMARK_OVERLAP_MS",
      // §11 constants BOUND from the packages that own them, never copied.
      "MAX_NAME_BYTES",
      "REDACTION_MARKER_PREFIX",
      "RPS_MAX",
      "SYS_ID_RE",
      // Config loader and HTTP client (WP-M3).
      "MirrorConfigError",
      "MirrorHttpClient",
      "MirrorHttpError",
      "createMirrorHttpClient",
      "credentialStoreSource",
      "loadMirrorConfig",
      "resolveMirrorAuthorization",
      // Catalog service (WP-M4). `catalog/fieldPolicy` and `catalog/tiers` are
      // NOT re-exported — they are the service's internal policy, and a caller
      // able to re-derive "is this column extracted?" is a caller able to
      // disagree with the service that already decided it.
      "CatalogService",
      // The one ordering primitive (`order.ts`), shared by the catalog, the shard
      // parser and the deletion authority so INV-1 has a single definition of
      // "sorted" rather than one per stage.
      "compareBytewise",
      // Path derivation and the shard format (WP-M7). §5.8 makes `shardLayout` the
      // SINGLE site that turns a scope/table/record into a path; exporting it is
      // what lets `verify` and `repair` use that site instead of re-deriving.
      "INSTANCE_DIR_NAME",
      "MirrorPathRejection",
      "RECORD_FILE_NAME",
      "SHARD_DIR_NAME",
      "SHARD_FILE_SUFFIX",
      "ShardManifestCorrupt",
      "SINGLE_SHARD_FILE",
      "assertMirrorPathComponent",
      "assertMirrorSysId",
      "buildShardManifest",
      "chooseShardFanout",
      "enumerateShardKeys",
      "isContainedRepoPath",
      "isMirrorSysId",
      "isShardKey",
      "parseShardManifest",
      "recordDirRelPath",
      "renderShardManifest",
      "repoPath",
      "shardDirRelPath",
      "shardFileName",
      "shardFileNamesFor",
      "shardKeyFor",
      "stickyFanout",
      // Shard store (WP-M7).
      "ShardFanoutConflict",
      "listScopesWithShards",
      "loadShardSet",
      "writeShardSet",
      // Writer, deletion authority and the filesystem seam (WP-M7).
      "DeletionAuthority",
      "DeletionNotAuthorized",
      "MirrorWriter",
      "TableSweepWriter",
      "applyAuthorizedDeletion",
      "nodeWriterFs",
      "tableDirRelPath",
      "toNativePath",
      // Checkpointing, so a resumed sweep is the CLI's to drive (WP-M7).
      "CHECKPOINT_FLUSH_EVERY_DEFAULT",
      "CHECKPOINT_REL_PATH",
      "CheckpointProgressSink",
      "nullProgressSink",
      "readWriterCheckpoint",
      // Fetcher (WP-M8) — one function to start a sweep, because a sweep is one
      // thing you start. Its seams (`FetchRowSink`, `FetchProgressReporter`,
      // `SweepFetchResult`) are types; a caller supplies them, it does not
      // import them at runtime. `pageFields` is exported under the same trade as
      // the planner's query builders below: a projection is a claim about a
      // STRING, and a caller that can reuse the checked one is a caller that will
      // not write a third copy of the D19 denial rule.
      "fetchSweep",
      "pageFields",
      // Planner (WP-M8). The query builders are exported alongside `planSync`
      // because D20 is a claim about a STRING — "every field named in a generated
      // query exists in the catalog" — and a second caller that builds that string
      // itself is a second place D20 can be wrong. Exporting the builders is what
      // lets a caller reuse the checked one instead of re-deriving it.
      "PlannerQueryError",
      "assertQueryFieldsCataloged",
      "buildWatermarkQuery",
      "effectiveFieldSet",
      "loadShardStates",
      "parseInstantMs",
      "planSync",
      "plannedQueryFor",
      // Checkpointing as the PLANNER sees it (WP-M8) — the full `CheckpointState`,
      // including the `preQuiescence` readings the Writer's narrower view below
      // deliberately cannot name. Both halves are exported because a resumed sweep
      // is the CLI's to drive and it needs to read the file before it has decided
      // which stage will write it next.
      "SweepCheckpointSink",
      "checkpointForPlan",
      "clearCheckpoint",
      "decideResume",
      "parseCheckpoint",
      "readCheckpoint",
      "remainingTables",
      "writeCheckpoint",
      // ReportGenerator (WP-M8). `coverage.json` is the file a consumer verifies a
      // mirror against, and the trailer keys are exported so a CI recipe can read a
      // commit back without re-typing the strings — the mirror never commits.
      //
      // The two writers are here rather than withheld like `atomicWriteFile`: each
      // takes a typed `CoverageReport`, renders it through the one canonical
      // renderer, and writes it to one fixed name at the repo root. A consumer
      // chooses neither the bytes nor the path, and nothing they produce lands
      // under `instance/`, so no invariant is on offer. `CoverageReportInputs` and
      // `CommitMetadataInputs` are types and stay out, as above.
      "COVERAGE_REL_PATH",
      "MIRROR_REPORT_REL_PATH",
      "MIRROR_TRAILER_CONSISTENCY",
      "MIRROR_TRAILER_SCOPES",
      "MIRROR_TRAILER_SWEEP",
      "MIRROR_TRAILER_TABLES_CHANGED",
      "buildCoverageReport",
      "buildMirrorCommitMessage",
      "renderMirrorReport",
      "writeCoverageReport",
      "writeMirrorReport",
      // Orchestrator (WP-M8) — one function, because a sweep is one thing the CLI
      // starts. Its option and result shapes (`RunMirrorCommandOptions`,
      // `RunMirrorResult`, `MirrorSweepClient`, `MirrorTransportOptions`) are
      // types and so are absent, as above.
      "runMirrorCommand",
      // Reconciler (WP-M10). Exported for the same reason `applyAuthorizedDeletion`
      // is: both are gated by a `DeletionAuthority`, which only a Writer that swept
      // a whole table can mint, so the export widens no invariant (INV-5).
      "reconcileSweep",
      // status / verify (WP-M11) — the two read-only commands, plus the wrapper
      // that makes "performs zero writes" checkable rather than merely claimed.
      // Their option, verdict and finding shapes are types and stay out.
      "DRIFT_VERDICT_KINDS",
      "MirrorReadOnlyViolation",
      "detectDrift",
      "readOnlyWriterFs",
      "verifyMirror",
      // Derived views (WP-M12). The INV-9 CI check regenerates from canonical
      // alone and diffs; it has to call the function the sweep calls, not a
      // second implementation of it.
      "generateDerivedViews",
      // The `.gitattributes` scaffolds (WP-M12b), exported whole. Three are pure
      // byte builders; `provisionGitAttributes` is the `writeCoverageReport` shape
      // — a typed config in, one fixed name at the repo root out — and it is
      // `syncrona mirror init`, in another package, that has to call it, so the
      // export is load-bearing rather than symmetrical.
      "GITATTRIBUTES_FILE_NAME",
      "LFS_ATTRIBUTES",
      "buildAttachmentGitAttributes",
      "buildRootGitAttributes",
      "provisionGitAttributes",
      // Attachments (WP-M12b), BY NAME rather than by `export *` — see the
      // withholding test below for why `applyAttachmentPlan` is not here. The pure
      // planner and the design §8.4 layout are, because anything reading a tree it
      // did not write has to agree with that layout rather than restate it.
      // `AttachmentPayload`, `AttachmentEntry`, `AttachmentPlan` and
      // `AttachmentPlanRequest` are exported too and absent here as types.
      "ATTACHMENTS_DIR_NAME",
      "attachmentDirRelPath",
      "planRecordAttachments",
      // From `write/atomicWrite`, BY NAME rather than by `export *`. Anything that
      // walks the tree must be able to tell a crashed run's leftovers from real
      // content; nothing outside this package may write into the tree.
      "STAGING_PREFIX",
      "isStagingName",
    ].sort());
  });

  it("resolves every name it exports, not just declares it", () => {
    // `Object.keys` above proves the key is there; it does not prove the key
    // RESOLVES. A re-export compiles to a getter, so a name whose target module
    // failed to provide it is a key present on the namespace whose read is
    // `undefined` — the test above passes and the consumer gets a TypeError. This
    // is the assertion that actually invokes all of them.
    const unresolved = Object.keys(mirror).filter(
      (name) => (mirror as Record<string, unknown>)[name] === undefined
    );
    expect(unresolved).toEqual([]);
  });

  it("withholds the exports that would let a consumer bypass an invariant", () => {
    // Each of these is absent on purpose and the reason differs, so the assertion
    // is one per name rather than a set difference — a future `export *` that
    // reintroduces any of them should say which invariant it costs.
    //
    // `atomicWriteFile` / `atomicRemoveDir` / `removeFileIfPresent`: byte-level
    // access to the mirror tree without passing the redactor (INV-3) or being
    // claimed by a completed shard (INV-4).
    expect(mirror).not.toHaveProperty("atomicWriteFile");
    expect(mirror).not.toHaveProperty("atomicRemoveDir");
    expect(mirror).not.toHaveProperty("removeFileIfPresent");
    expect(mirror).not.toHaveProperty("stagingSiblingOf");
    // `RecordNameResolver`: naming is decided once, by the writer, and recorded in
    // the shard entry. A second caller running the resolver can compute a name that
    // disagrees with the tree.
    expect(mirror).not.toHaveProperty("RecordNameResolver");
    // `applyAttachmentPlan`: an `AttachmentPlan` is a plain interface, so a
    // hand-built one names its own repo-relative `path` and carries its own
    // `bytes`, and `toNativePath` does not re-check containment — the check lives
    // in `shards/shardLayout`, which only the real planner goes through. Exporting
    // it would be `atomicWriteFile` behind a longer signature, with a directory
    // prune attached. `planRecordAttachments` IS exported: it is pure, and a plan
    // it produced can only name paths under `attachments/<table>/<sys_id>/`.
    expect(mirror).not.toHaveProperty("applyAttachmentPlan");
  });

  it("exports the format version the on-disk tree is pinned to", () => {
    expect(mirror.FORMAT_VERSION).toBe(1);
    expect(mirror.JSON_INDENT).toBe(2);
    expect(mirror.RAW_MARKER_PREFIX).toBe("raw:");
  });

  it("binds the borrowed constants to their owners instead of copying them", () => {
    // §11's whole purpose is that one number has one home. A copied value passes
    // an equality check on the day it is written and then drifts silently when
    // the owner changes it — which is the failure mode §11 exists to prevent.
    // Identity is the only assertion that can tell the two apart: `===` on a
    // regex object holds for a re-export and fails for a re-declaration, even a
    // character-identical one.
    expect(mirror.SYS_ID_RE).toBe(SYS_ID_RE);
    expect(mirror.MAX_NAME_BYTES).toBe(MAX_NAME_BYTES);
    expect(mirror.REDACTION_MARKER_PREFIX).toBe(REDACTION_MARKER_PREFIX);
    // RPS_MAX is the same binding under the mirror's §11 name.
    expect(mirror.RPS_MAX).toBe(MAX_REQUESTS_PER_SECOND);
  });

  it("exports the §11 defaults at the values the analyses measured", () => {
    expect(mirror.PAGE_SIZE_DEFAULT).toBe(1000);
    expect(mirror.RPS_DEFAULT).toBe(4);
    expect(mirror.WATERMARK_OVERLAP_MS).toBe(300_000);
    expect(mirror.SHARD_FANOUT_THRESHOLD_1).toBe(16_000);
    expect(mirror.SHARD_FANOUT_THRESHOLD_2).toBe(256_000);
    expect(mirror.LFS_THRESHOLD_BYTES).toBe(262_144);
    // The default rate must sit inside the ceiling it is measured against;
    // otherwise every sweep starts by violating the platform's own limit.
    expect(mirror.RPS_DEFAULT).toBeLessThanOrEqual(mirror.RPS_MAX);
  });
});
