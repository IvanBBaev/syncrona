// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `generateDerivedViews` — the single entry point of the derived layer (§5.12, INV-9).
 *
 * §5.12: "Regenerates `_derived/` from the canonical tree alone (INV-9): form
 * layouts, workflow summaries, reference display-name indexes, and the ACL
 * matrix view (D9)." This module is the ONLY writer under `_derived/`, and the
 * one property everything else here serves is:
 *
 *     the four managed subtrees are a pure function of
 *     (canonical tree, `config.derived`) — of nothing else.
 *
 * No clock, no network, no environment, no enumeration order. That is what
 * makes §5.12's CI check possible at all ("regenerates everything and fails on
 * diff — catches hand-edits"): a regeneration that could legitimately differ
 * from the last one would make every CI failure ambiguous.
 *
 * **Regeneration is remove-then-rebuild, per view directory.** Each of the
 * four managed subtrees (`forms/`, `workflows/`, `refs/`, `acl/`) is removed
 * via `atomicRemoveDir` before its flag is even consulted, then rebuilt when
 * enabled. Three things fall out of that one decision:
 *
 *  - a DISABLED view's directory is absent, not stale — flipping a flag off
 *    cannot leave last sync's files sitting there looking current;
 *  - documents that stop existing (a deleted form, an unpublished version)
 *    disappear without any diffing logic that could drift from the builders;
 *  - the INV-9 acceptance test ("delete `_derived/`, regenerate,
 *    byte-identical") is the code path every run takes, not a special case.
 *
 * The cost — every derived file is rewritten on every run — is accepted
 * knowingly. §5.12's incremental mode ("regenerates derived views for changed
 * tables") is an orchestrator optimisation over WHEN to call this; it must
 * never change WHAT this produces. Files outside the four managed subtrees
 * (a hand-dropped `_derived/notes.md`) are deliberately not touched: this
 * module owns exactly what it generates, and the CI diff gate is the layer
 * that argues with humans about the rest.
 *
 * Ordering between views is fixed (forms, workflows, refs, aclMatrix) and the
 * summary's lists are sorted before return, so the summary is as reproducible
 * as the tree — a summary that varied between identical runs would fail the
 * spirit of INV-9 even though no bytes on disk differed.
 *
 * Wiring is the orchestrator's job, on purpose: `mirror sync` and the CI check
 * call this with a `WriterFs` and a loaded config; nothing here is reachable
 * from `runMirrorCommand` until it is wired there (WP-M12 leaves that seam to
 * the orchestrator half).
 */
import type { MirrorConfig } from "../contracts";
import { compareBytewise } from "../order";
import { repoPath } from "../shards/shardLayout";
import { atomicRemoveDir } from "../write/atomicWrite";
import type { WriterFs } from "../write/fs";
import { toNativePath } from "../write/fs";
import type { DerivedAnomaly } from "./canonicalTree";
import { CanonicalTreeReader } from "./canonicalTree";
import { generateAclMatrixView } from "./aclMatrixView";
import { generateFormsView } from "./formsView";
import type { DanglingReference } from "./refsView";
import { generateRefsView } from "./refsView";
import { generateWorkflowsView } from "./workflowsView";
import {
  ACL_DIR_NAME,
  DERIVED_DIR_NAME,
  FORMS_DIR_NAME,
  REFS_DIR_NAME,
  WORKFLOWS_DIR_NAME,
} from "./render";

export type { DerivedAnomaly } from "./canonicalTree";
export type { DanglingReference } from "./refsView";

/**
 * What one derived-views run did — everything the orchestrator needs to log,
 * fold into coverage (`TableCoverage.danglingRefs`, D2), or fail CI on.
 *
 * The types are local to `src/derived/` by WP-M12's own instruction: the
 * contracts module is the writer-side seam, and the orchestrator half decides
 * what of this, if anything, graduates into it.
 */
export interface DerivedViewsSummary {
  /** Which views ran — an echo of `config.derived`, so logs are self-contained. */
  views: {
    forms: boolean;
    workflows: boolean;
    refs: boolean;
    aclMatrix: boolean;
  };
  /** Repo-relative paths of every file written, sorted bytewise. */
  filesWritten: string[];
  counts: {
    /** Form documents written (one per table+view pair). */
    formDocuments: number;
    /** Workflow documents written (one per published version). */
    workflowDocuments: number;
    /** Versions the published-only filter excluded (R3: counted, not silent). */
    unpublishedWorkflowVersions: number;
    /** Reference-index documents written (one per scope). */
    refScopes: number;
    /** Rows across all reference indexes. */
    refRecords: number;
    /** Rows in the ACL matrix. */
    aclRules: number;
  };
  /**
   * Dangling references found while building the refs view (D2: reported,
   * never repaired). Empty when the refs view is disabled — detection reads
   * every envelope in the tree, and a disabled view must cost nothing.
   */
  danglingRefs: DanglingReference[];
  /** Every named defect and named skip, sorted (R3: no silent skips). */
  anomalies: DerivedAnomaly[];
}

/**
 * Regenerate the enabled derived views from the canonical tree alone (INV-9).
 *
 * `root` is the repo root as a native absolute path, exactly as the writer
 * modules take it. Throws `ShardManifestCorrupt` when the canonical index
 * itself is broken — see `canonicalTree.ts` for why that is fatal while a
 * broken record is a report.
 */
export async function generateDerivedViews(
  fs: WriterFs,
  root: string,
  config: MirrorConfig
): Promise<DerivedViewsSummary> {
  // Remove all four managed subtrees up front — enabled or not (see module
  // docblock). Removal is per-subtree rather than `_derived/` wholesale so a
  // file a human parked at `_derived/notes.md` is not this module's casualty.
  for (const dirName of [
    FORMS_DIR_NAME,
    WORKFLOWS_DIR_NAME,
    REFS_DIR_NAME,
    ACL_DIR_NAME,
  ]) {
    await atomicRemoveDir(
      fs,
      toNativePath(root, repoPath(DERIVED_DIR_NAME, dirName))
    );
  }

  const anomalies: DerivedAnomaly[] = [];
  const reader = new CanonicalTreeReader(fs, root, anomalies);
  const filesWritten: string[] = [];
  const summary: DerivedViewsSummary = {
    views: {
      forms: config.derived.forms,
      workflows: config.derived.workflows,
      refs: config.derived.refs,
      aclMatrix: config.derived.aclMatrix,
    },
    filesWritten,
    counts: {
      formDocuments: 0,
      workflowDocuments: 0,
      unpublishedWorkflowVersions: 0,
      refScopes: 0,
      refRecords: 0,
      aclRules: 0,
    },
    danglingRefs: [],
    anomalies,
  };

  if (config.derived.forms) {
    summary.counts.formDocuments = await generateFormsView(
      fs,
      root,
      reader,
      filesWritten,
      anomalies
    );
  }
  if (config.derived.workflows) {
    const result = await generateWorkflowsView(fs, root, reader, filesWritten, anomalies);
    summary.counts.workflowDocuments = result.documents;
    summary.counts.unpublishedWorkflowVersions = result.unpublishedVersions;
  }
  if (config.derived.refs) {
    const result = await generateRefsView(fs, root, reader, filesWritten);
    summary.counts.refScopes = result.scopeDocuments;
    summary.counts.refRecords = result.indexedRecords;
    summary.danglingRefs = result.danglingRefs;
  }
  if (config.derived.aclMatrix) {
    summary.counts.aclRules = await generateAclMatrixView(
      fs,
      root,
      reader,
      filesWritten,
      anomalies
    );
  }

  filesWritten.sort(compareBytewise);
  anomalies.sort(
    (a, b) => compareBytewise(a.source, b.source) || compareBytewise(a.detail, b.detail)
  );
  return summary;
}
