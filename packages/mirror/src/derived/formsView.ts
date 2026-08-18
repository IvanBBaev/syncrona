// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `_derived/forms/<table>/<view>.md` — the sys_ui_form graph, flattened (§5.12, §4.3).
 *
 * A form layout on the instance is a four-table graph: `sys_ui_form` (one row
 * per table+view), `sys_ui_form_section` (the ordered join), `sys_ui_section`
 * (the section definition and caption) and `sys_ui_element` (the ordered fields
 * inside a section). Reviewing a form change in the canonical layer means
 * chasing sys_ids across four directories; the whole point of this view is that
 * the diff of ONE Markdown file shows "field moved from section A to B".
 *
 * Document identity is `(table, view)` — §8.1's `<table>/<view>.md` — and every
 * `sys_ui_form` row for that pair (there can be several: per-user and
 * per-domain variants are rows in the same table) is rendered into the same
 * document, ordered by form sys_id. Sections are ordered by their join row's
 * numeric `position` (ties broken by join sys_id), elements by their own
 * `position` (ties by element sys_id): position is the instance's own ordering
 * column, and the sys_id tiebreak is what keeps the document stable when two
 * rows share a position (INV-9 — the file must not depend on which row a
 * directory listing yielded first).
 *
 * D2 shows up three ways, all rendered rather than repaired:
 *  - a join pointing at a `sys_ui_section` the tree does not hold renders a
 *    `(missing section <sys_id>)` heading — its elements are still looked up,
 *    because `sys_ui_element` rows key on the section sys_id, not the record;
 *  - a form whose `view` reference resolves to nothing labels the view with the
 *    raw sys_id;
 *  - rows that cannot be placed at all (no table name, no parent reference) are
 *    skipped BY NAME into the anomaly list (R3), never silently.
 *
 * The view label prefers the referenced `sys_ui_view`'s folded record name from
 * its shard entry — the display name the canonical layer already computed —
 * over re-reading the view's envelope: the label needs to be a recognisable
 * name, not a second resolution pipeline. An absent `view` field means the
 * default view, labelled `Default`.
 */
import { compareBytewise } from "../order";
import { isMirrorSysId, repoPath } from "../shards/shardLayout";
import type { WriterFs } from "../write/fs";
import type {
  CanonicalRecordRef,
  CanonicalTreeReader,
  DerivedAnomaly,
} from "./canonicalTree";
import { envelopeField } from "./canonicalTree";
import {
  DERIVED_DIR_NAME,
  FORMS_DIR_NAME,
  escapeCell,
  uniqueNamesForLabels,
  writeDerivedFile,
} from "./render";

/** Label used when a form has no `view` reference — ServiceNow's default view. */
const DEFAULT_VIEW_LABEL = "Default";

/**
 * Numeric rank of an ordering column, `Infinity` for absent or non-numeric.
 *
 * `Number(...)` rather than `parseInt`: `position` is an integer column, so a
 * value like `"12abc"` is already a hand-edit, and silently reading it as `12`
 * would order the document by a number the envelope does not contain. Absent
 * and unparsable both rank last, where the sys_id tiebreak takes over.
 */
function positionRank(fields: ReadonlyMap<string, string> | null): number {
  const text = envelopeField(fields, "position");
  if (text === null) {
    return Number.POSITIVE_INFINITY;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

interface SectionAssignment {
  rank: number;
  joinSysId: string;
  sectionSysId: string;
}

interface ElementRow {
  rank: number;
  sysId: string;
  element: string | null;
  type: string | null;
}

interface ViewGroup {
  /** Bytewise-least contributing form sys_id — the naming anchor. */
  anchor: string;
  forms: CanonicalRecordRef[];
}

interface TableGroup {
  anchor: string;
  views: Map<string, ViewGroup>;
}

/**
 * Generate the forms view. Returns the number of documents written.
 */
export async function generateFormsView(
  fs: WriterFs,
  root: string,
  reader: CanonicalTreeReader,
  filesWritten: string[],
  anomalies: DerivedAnomaly[]
): Promise<number> {
  const forms = await reader.table("sys_ui_form");
  const joins = await reader.table("sys_ui_form_section");
  const sections = await reader.table("sys_ui_section");
  const elements = await reader.table("sys_ui_element");
  const views = await reader.table("sys_ui_view");

  // Join rows, grouped by parent form. `records` (deduplicated, sys_id-sorted)
  // rather than `refs`: a join row duplicated across scopes is a tree defect
  // the reader has already reported, and rendering it twice would repair the
  // report away by making the defect look intentional.
  const assignmentsByForm = new Map<string, SectionAssignment[]>();
  for (const join of joins.records) {
    const fields = await reader.envelope(join);
    const formSysId = envelopeField(fields, "sys_ui_form");
    const sectionSysId = envelopeField(fields, "sys_ui_section");
    if (formSysId === null || sectionSysId === null) {
      anomalies.push({
        source: "forms",
        detail: `sys_ui_form_section ${join.sysId}: missing sys_ui_form or sys_ui_section reference; skipped`,
      });
      continue;
    }
    const assignment: SectionAssignment = {
      rank: positionRank(fields),
      joinSysId: join.sysId,
      sectionSysId,
    };
    const list = assignmentsByForm.get(formSysId);
    if (list === undefined) {
      assignmentsByForm.set(formSysId, [assignment]);
    } else {
      list.push(assignment);
    }
  }
  for (const list of assignmentsByForm.values()) {
    list.sort(
      (a, b) => a.rank - b.rank || compareBytewise(a.joinSysId, b.joinSysId)
    );
  }

  const elementsBySection = new Map<string, ElementRow[]>();
  for (const element of elements.records) {
    const fields = await reader.envelope(element);
    const sectionSysId = envelopeField(fields, "sys_ui_section");
    if (sectionSysId === null) {
      anomalies.push({
        source: "forms",
        detail: `sys_ui_element ${element.sysId}: missing sys_ui_section reference; skipped`,
      });
      continue;
    }
    const row: ElementRow = {
      rank: positionRank(fields),
      sysId: element.sysId,
      element: envelopeField(fields, "element"),
      type: envelopeField(fields, "type"),
    };
    const list = elementsBySection.get(sectionSysId);
    if (list === undefined) {
      elementsBySection.set(sectionSysId, [row]);
    } else {
      list.push(row);
    }
  }
  for (const list of elementsBySection.values()) {
    list.sort((a, b) => a.rank - b.rank || compareBytewise(a.sysId, b.sysId));
  }

  // Group forms into (table, view) documents. Iteration over `records` is
  // sys_id-ascending, so the FIRST form to open a group is its bytewise-least
  // member — the content-derived naming anchor falls out of the iteration.
  const byTable = new Map<string, TableGroup>();
  for (const form of forms.records) {
    const fields = await reader.envelope(form);
    const tableRaw = envelopeField(fields, "name");
    if (tableRaw === null) {
      anomalies.push({
        source: "forms",
        detail: `sys_ui_form ${form.sysId}: no table name in envelope; skipped`,
      });
      continue;
    }
    const viewRaw = envelopeField(fields, "view");
    let viewLabel: string;
    if (viewRaw === null) {
      viewLabel = DEFAULT_VIEW_LABEL;
    } else if (isMirrorSysId(viewRaw)) {
      const viewRef = views.bySysId.get(viewRaw);
      // Dangling view reference: the raw sys_id IS the label (D2 — render the
      // tear). The refs view is where dangling references are counted.
      viewLabel = viewRef === undefined ? viewRaw : viewRef.entry.name;
    } else {
      // Exports sometimes carry the view NAME instead of a sys_id; a value
      // that cannot be a sys_id can only be meant as a name.
      viewLabel = viewRaw;
    }
    let tableGroup = byTable.get(tableRaw);
    if (tableGroup === undefined) {
      tableGroup = { anchor: form.sysId, views: new Map() };
      byTable.set(tableRaw, tableGroup);
    }
    const viewGroup = tableGroup.views.get(viewLabel);
    if (viewGroup === undefined) {
      tableGroup.views.set(viewLabel, { anchor: form.sysId, forms: [form] });
    } else {
      viewGroup.forms.push(form);
    }
  }

  const tableAnchors = new Map<string, string>();
  for (const [tableRaw, group] of byTable) {
    tableAnchors.set(tableRaw, group.anchor);
  }
  const tableDirNames = uniqueNamesForLabels(tableAnchors);

  let documents = 0;
  const tableLabels = [...byTable.keys()].sort(compareBytewise);
  for (const tableRaw of tableLabels) {
    const tableGroup = byTable.get(tableRaw) as TableGroup;
    const tableDir = tableDirNames.get(tableRaw) as string;
    const viewAnchors = new Map<string, string>();
    for (const [viewLabel, group] of tableGroup.views) {
      viewAnchors.set(viewLabel, group.anchor);
    }
    const viewFileNames = uniqueNamesForLabels(viewAnchors);
    const viewLabels = [...tableGroup.views.keys()].sort(compareBytewise);
    for (const viewLabel of viewLabels) {
      const viewGroup = tableGroup.views.get(viewLabel) as ViewGroup;
      const lines: string[] = [
        `# Form layout: ${escapeCell(tableRaw)} — view ${escapeCell(viewLabel)}`,
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
      ];
      for (const form of viewGroup.forms) {
        lines.push("", `## Form ${form.sysId} (scope ${form.scope})`);
        const assignments = assignmentsByForm.get(form.sysId) ?? [];
        for (const assignment of assignments) {
          const sectionRef = sections.bySysId.get(assignment.sectionSysId);
          if (sectionRef === undefined) {
            lines.push("", `### (missing section ${assignment.sectionSysId})`);
          } else {
            const sectionFields = await reader.envelope(sectionRef);
            const caption =
              envelopeField(sectionFields, "caption") ?? "(untitled section)";
            lines.push(
              "",
              `### ${escapeCell(caption)} — ${assignment.sectionSysId}`
            );
          }
          const sectionElements =
            elementsBySection.get(assignment.sectionSysId) ?? [];
          if (sectionElements.length > 0) {
            lines.push("");
          }
          for (const row of sectionElements) {
            if (row.element === null) {
              const typeSuffix = row.type === null ? "" : `, type ${escapeCell(row.type)}`;
              lines.push(`- (unnamed element ${row.sysId}${typeSuffix})`);
            } else {
              const typeSuffix =
                row.type === null || row.type === "element"
                  ? ""
                  : ` — ${escapeCell(row.type)}`;
              lines.push(`- \`${row.element}\`${typeSuffix}`);
            }
          }
        }
      }
      const relPath = repoPath(
        DERIVED_DIR_NAME,
        FORMS_DIR_NAME,
        tableDir,
        `${viewFileNames.get(viewLabel) as string}.md`
      );
      await writeDerivedFile(fs, root, relPath, lines.join("\n"), filesWritten);
      documents += 1;
    }
  }
  return documents;
}
