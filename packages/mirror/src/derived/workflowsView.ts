// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `_derived/workflows/<name>@<version>.md` — legacy workflow summaries (§5.12, §4.3).
 *
 * A legacy workflow is a graph across four tables: `wf_workflow` (the named
 * container), `wf_workflow_version` (the published revisions — the container
 * points at "current", but the VERSIONS are the content), `wf_activity` (nodes,
 * keyed to a version) and `wf_transition` (edges between activities). §4.3
 * calls for "one ordered document per published version", and "published" is
 * taken literally: `published === "true"` on the version row. Draft versions
 * are working state, not instance behaviour, and a derived layer that rendered
 * drafts would churn on every designer keystroke that syncs; the count of
 * versions skipped this way is returned so the summary can say so (R3 — a
 * filter is still a named skip, just a counted one).
 *
 * Document identity is the VERSION, not the workflow: two published versions of
 * one workflow are two documents, which is what makes the file name's
 * `<name>@<version>` shape from §8.1 work. The version label is the envelope's
 * `version` field when it carries one and the version row's sys_id otherwise —
 * `wf_workflow_version` has no universally populated human version column, and
 * a sys_id label is ugly but stable, which is the priority ordering INV-9
 * imposes. The workflow name resolves through the `workflow` reference to the
 * container's folded shard-entry name; a dangling reference (D2) falls back to
 * the version's own `name` and then to its sys_id, with the tear named in the
 * anomaly list.
 *
 * Activities have no ordering column (their `x`/`y` are canvas coordinates),
 * so the document orders them by (label, sys_id) — readable and, unlike any
 * coordinate scheme, stable under the pixel-nudges designers make without
 * meaning anything by them. Transitions are attributed to a version through
 * their `from` activity, because `wf_transition` itself carries no version
 * reference; an edge whose `from` is not in the tree belongs to no document
 * and is skipped by name (D2 — reported, never repaired).
 */
import { compareBytewise } from "../order";
import { isMirrorSysId, repoPath } from "../shards/shardLayout";
import type { WriterFs } from "../write/fs";
import type { CanonicalTreeReader, DerivedAnomaly } from "./canonicalTree";
import { envelopeField } from "./canonicalTree";
import {
  DERIVED_DIR_NAME,
  WORKFLOWS_DIR_NAME,
  escapeCell,
  writeDerivedFile,
} from "./render";
import {
  buildSafeRecordName,
  resolveUniqueNames,
  type NameCandidate,
} from "@syncrona/sn-transport";

interface ActivityInfo {
  label: string;
  sysId: string;
  versionSysId: string;
}

interface TransitionRow {
  fromLabel: string;
  toLabel: string;
  sysId: string;
}

/** What the workflows view reports back to the summary. */
export interface WorkflowsViewResult {
  documents: number;
  /** Versions excluded by the published-only filter — counted, not silent. */
  unpublishedVersions: number;
}

/**
 * Generate the workflows view.
 */
export async function generateWorkflowsView(
  fs: WriterFs,
  root: string,
  reader: CanonicalTreeReader,
  filesWritten: string[],
  anomalies: DerivedAnomaly[]
): Promise<WorkflowsViewResult> {
  const workflows = await reader.table("wf_workflow");
  const versions = await reader.table("wf_workflow_version");
  const activities = await reader.table("wf_activity");
  const transitions = await reader.table("wf_transition");

  // Activities first: transitions can only be attributed through them.
  const activityInfo = new Map<string, ActivityInfo>();
  const activitiesByVersion = new Map<string, ActivityInfo[]>();
  for (const activity of activities.records) {
    const fields = await reader.envelope(activity);
    const versionSysId = envelopeField(fields, "workflow_version");
    if (versionSysId === null) {
      anomalies.push({
        source: "workflows",
        detail: `wf_activity ${activity.sysId}: missing workflow_version reference; skipped`,
      });
      continue;
    }
    const info: ActivityInfo = {
      label: envelopeField(fields, "name") ?? activity.sysId,
      sysId: activity.sysId,
      versionSysId,
    };
    activityInfo.set(activity.sysId, info);
    const list = activitiesByVersion.get(versionSysId);
    if (list === undefined) {
      activitiesByVersion.set(versionSysId, [info]);
    } else {
      list.push(info);
    }
  }
  const activityOrder = (a: ActivityInfo, b: ActivityInfo): number =>
    compareBytewise(a.label, b.label) || compareBytewise(a.sysId, b.sysId);
  for (const list of activitiesByVersion.values()) {
    list.sort(activityOrder);
  }

  const transitionsByVersion = new Map<string, TransitionRow[]>();
  for (const transition of transitions.records) {
    const fields = await reader.envelope(transition);
    const fromSysId = envelopeField(fields, "from");
    if (fromSysId === null) {
      anomalies.push({
        source: "workflows",
        detail: `wf_transition ${transition.sysId}: missing from reference; skipped`,
      });
      continue;
    }
    const fromInfo = activityInfo.get(fromSysId);
    if (fromInfo === undefined) {
      anomalies.push({
        source: "workflows",
        detail: `wf_transition ${transition.sysId}: from-activity ${fromSysId} is not in the tree; skipped (D2)`,
      });
      continue;
    }
    const toSysId = envelopeField(fields, "to");
    let toLabel: string;
    if (toSysId === null) {
      toLabel = "(no target)";
    } else {
      const toInfo = activityInfo.get(toSysId);
      // A dangling `to` still renders — the edge exists in the tree, and the
      // document's job is to show the tear, not to hide the edge (D2).
      toLabel = toInfo === undefined ? `(missing activity ${toSysId})` : toInfo.label;
    }
    const row: TransitionRow = {
      fromLabel: fromInfo.label,
      toLabel,
      sysId: transition.sysId,
    };
    const list = transitionsByVersion.get(fromInfo.versionSysId);
    if (list === undefined) {
      transitionsByVersion.set(fromInfo.versionSysId, [row]);
    } else {
      list.push(row);
    }
  }
  for (const list of transitionsByVersion.values()) {
    list.sort(
      (a, b) =>
        compareBytewise(a.fromLabel, b.fromLabel) ||
        compareBytewise(a.toLabel, b.toLabel) ||
        compareBytewise(a.sysId, b.sysId)
    );
  }

  interface VersionDoc {
    versionSysId: string;
    workflowName: string;
    versionLabel: string;
  }
  const docs: VersionDoc[] = [];
  let unpublishedVersions = 0;
  for (const version of versions.records) {
    const fields = await reader.envelope(version);
    if (fields === null) {
      anomalies.push({
        source: "workflows",
        detail: `wf_workflow_version ${version.sysId}: unreadable envelope; skipped`,
      });
      continue;
    }
    if (envelopeField(fields, "published") !== "true") {
      unpublishedVersions += 1;
      continue;
    }
    const workflowRaw = envelopeField(fields, "workflow");
    let workflowName: string | null = null;
    if (workflowRaw !== null && isMirrorSysId(workflowRaw)) {
      const workflowRef = workflows.bySysId.get(workflowRaw);
      if (workflowRef === undefined) {
        anomalies.push({
          source: "workflows",
          detail: `wf_workflow_version ${version.sysId}: workflow reference ${workflowRaw} is not in the tree; using the version's own name (D2)`,
        });
      } else {
        workflowName = workflowRef.entry.name;
      }
    }
    if (workflowName === null) {
      workflowName = envelopeField(fields, "name") ?? version.sysId;
    }
    docs.push({
      versionSysId: version.sysId,
      workflowName,
      versionLabel: envelopeField(fields, "version") ?? version.sysId,
    });
  }

  // File names: `<name>@<version>` through the canonical naming pipeline, with
  // the version's sys_id as the anchor. Anchors are unique (one per version
  // row), so two versions rendering the same label collide into `_<sysId>`
  // suffixes exactly like colliding record names do (D18).
  const candidates: NameCandidate[] = docs.map((doc) => ({
    sysId: doc.versionSysId,
    name: buildSafeRecordName(
      `${doc.workflowName}@${doc.versionLabel}`,
      doc.versionSysId
    ),
  }));
  const resolution = resolveUniqueNames(candidates);

  let documents = 0;
  for (const doc of docs) {
    const stem = resolution.names.get(doc.versionSysId);
    /* istanbul ignore if -- @preserve: unreachable by construction. The anchor
       is a sys_id validated at shard-parse time (INV-6), so the candidate can
       never be classified unusable — the only way `names` lacks it. */
    if (stem === undefined) {
      continue;
    }
    const lines: string[] = [
      `# Workflow: ${escapeCell(doc.workflowName)} — version ${escapeCell(doc.versionLabel)}`,
      "",
      "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
      "",
      "## Activities",
      "",
    ];
    for (const activity of activitiesByVersion.get(doc.versionSysId) ?? []) {
      lines.push(`- ${escapeCell(activity.label)}`);
    }
    lines.push("", "## Transitions", "");
    for (const row of transitionsByVersion.get(doc.versionSysId) ?? []) {
      lines.push(`- ${escapeCell(row.fromLabel)} -> ${escapeCell(row.toLabel)}`);
    }
    const relPath = repoPath(DERIVED_DIR_NAME, WORKFLOWS_DIR_NAME, `${stem}.md`);
    await writeDerivedFile(fs, root, relPath, lines.join("\n"), filesWritten);
    documents += 1;
  }
  return { documents, unpublishedVersions };
}
