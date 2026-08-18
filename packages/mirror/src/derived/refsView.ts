// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `_derived/refs/<scope>.md` — reference display-name indexes, and the D2
 * dangling-reference report (§5.12, §8.1).
 *
 * The canonical layer stores references as bare sys_ids (display resolution is
 * excluded from fidelity, §7.3), which makes `record.json` diffs precise and
 * unreviewable in equal measure. This view is the antidote: one file per scope
 * mapping every sys_id the scope's shard sets claim to its folded display name,
 * so a reviewer confronted with `"assignment_group": "d625dccec0a8016700a222a0f7900d06"`
 * has one predictable place to look it up. The names come straight from the
 * shard entries — the writer already computed the folded display name (§7.4) —
 * so this view needs no envelope reads to build the index itself.
 *
 * **Dangling references (D2)** are detected here and only reported — never
 * repaired, never omitted from the canonical layer. What makes this subtle is
 * that INV-9 forbids asking the instance what a reference column is, so the
 * detector's schema knowledge must ALSO come from the canonical tree:
 *
 *  - Reference columns are the mirrored `sys_dictionary` rows with
 *    `internal_type === "reference"`, an element, a table name, and not
 *    `active === "false"` — the same reading the catalog layer applies to the
 *    wire (M13/P3: `internal_type` arrives as a plain string).
 *  - Column inheritance is honoured by walking `super_class` through the
 *    mirrored `sys_db_object` rows (a child table's rows carry only its OWN
 *    columns in sys_dictionary; `incident.assignment_group` lives on `task`).
 *    The walk carries a seen-set so a hand-edited cycle terminates.
 *  - The dictionary's `reference` column follows the same resolution rule as
 *    the catalog's: a sys_id-shaped value resolves through `sys_db_object`, any
 *    other non-empty value IS the table name, and an unresolvable target makes
 *    the column unverifiable rather than dangling.
 *
 * A reference is counted dangling only when the evidence is real: the value is
 * sys_id-shaped, the target table is mirrored, every one of the target's shard
 * sets is COMPLETE (INV-4 — absence from an incomplete set proves nothing),
 * and the sys_id is still absent. A target table that simply is not mirrored
 * is a configuration choice, not a broken graph, and is not counted. If
 * `sys_dictionary` itself is not mirrored the tree carries no reference
 * knowledge at all: the indexes still generate, and zero dangling references
 * are reported because zero are KNOWABLE — an honest zero, not a hopeful one.
 *
 * Each scope's report section lists the dangling references whose SOURCE row
 * lives in that scope, so the committed derived layer shows the tear next to
 * the scope that owns it; the summary carries the full sorted list.
 */
import { compareBytewise } from "../order";
import { isMirrorSysId, repoPath } from "../shards/shardLayout";
import type { WriterFs } from "../write/fs";
import type { CanonicalTreeReader } from "./canonicalTree";
import { envelopeField } from "./canonicalTree";
import {
  DERIVED_DIR_NAME,
  REFS_DIR_NAME,
  escapeCell,
  writeDerivedFile,
} from "./render";

/** One dangling reference, exactly as observed (D2: reported, never repaired). */
export interface DanglingReference {
  /** Scope of the row holding the reference. */
  scope: string;
  /** Table of the row holding the reference. */
  table: string;
  /** sys_id of the row holding the reference. */
  sysId: string;
  /** Column the value sits in. */
  field: string;
  /** Table the column points at, per the mirrored dictionary. */
  targetTable: string;
  /** The sys_id that no complete shard set of the target table claims. */
  targetSysId: string;
}

/** What the refs view reports back to the summary. */
export interface RefsViewResult {
  scopeDocuments: number;
  indexedRecords: number;
  /** Sorted by (scope, table, sysId, field) — a total order, see the sort. */
  danglingRefs: DanglingReference[];
}

interface ReferenceColumn {
  element: string;
  /** Raw `reference` value from the dictionary row; resolved lazily. */
  targetRaw: string | null;
}

/**
 * Generate the refs view.
 */
export async function generateRefsView(
  fs: WriterFs,
  root: string,
  reader: CanonicalTreeReader,
  filesWritten: string[]
): Promise<RefsViewResult> {
  const tables = await reader.discoverTables();

  // ---- Schema knowledge from the tree alone (see module docblock). --------
  const dbObjects = await reader.table("sys_db_object");
  const dbBySysId = new Map<string, { name: string | null; superRaw: string | null }>();
  const dbSysIdByName = new Map<string, string>();
  for (const row of dbObjects.records) {
    const fields = await reader.envelope(row);
    const name = envelopeField(fields, "name");
    dbBySysId.set(row.sysId, {
      name,
      superRaw: envelopeField(fields, "super_class"),
    });
    // Two sys_db_object rows sharing a name is a tree defect; `records` is
    // sys_id-ascending, so first-wins is bytewise-least-wins — deterministic.
    if (name !== null && !dbSysIdByName.has(name)) {
      dbSysIdByName.set(name, row.sysId);
    }
  }
  const resolveTableRef = (raw: string | null): string | null => {
    if (raw === null) {
      return null;
    }
    if (!isMirrorSysId(raw)) {
      return raw;
    }
    const row = dbBySysId.get(raw);
    return row === undefined ? null : row.name;
  };

  const dictionary = await reader.table("sys_dictionary");
  const referenceColumnsByTable = new Map<string, ReferenceColumn[]>();
  for (const row of dictionary.records) {
    const fields = await reader.envelope(row);
    if (envelopeField(fields, "internal_type") !== "reference") {
      continue;
    }
    const tableName = envelopeField(fields, "name");
    const element = envelopeField(fields, "element");
    if (tableName === null || element === null) {
      continue;
    }
    if (envelopeField(fields, "active") === "false") {
      continue;
    }
    const column: ReferenceColumn = {
      element,
      targetRaw: envelopeField(fields, "reference"),
    };
    const list = referenceColumnsByTable.get(tableName);
    if (list === undefined) {
      referenceColumnsByTable.set(tableName, [column]);
    } else {
      list.push(column);
    }
  }

  /** Table name → its inheritance chain of names, self first (cycle-guarded). */
  const inheritanceChain = (table: string): string[] => {
    const chain = [table];
    const seen = new Set(chain);
    let currentSysId = dbSysIdByName.get(table);
    while (currentSysId !== undefined) {
      const row = dbBySysId.get(currentSysId);
      /* istanbul ignore if -- @preserve: unreachable by construction —
         `dbSysIdByName` only holds sys_ids that were inserted into `dbBySysId`
         in the same loop iteration. */
      if (row === undefined) {
        break;
      }
      const superName = resolveTableRef(row.superRaw);
      if (superName === null || seen.has(superName)) {
        break;
      }
      chain.push(superName);
      seen.add(superName);
      currentSysId = dbSysIdByName.get(superName);
    }
    return chain;
  };

  /** Reference columns applying to a table, inheritance included, one row per element. */
  const referenceColumnsFor = (table: string): ReferenceColumn[] => {
    const columns = new Map<string, ReferenceColumn>();
    for (const chainTable of inheritanceChain(table)) {
      const rows = referenceColumnsByTable.get(chainTable) ?? [];
      const sorted = [...rows].sort((a, b) => compareBytewise(a.element, b.element));
      for (const column of sorted) {
        // Most-derived definition wins: the chain is self-first, and an element
        // already claimed is an override of whatever an ancestor declares.
        if (!columns.has(column.element)) {
          columns.set(column.element, column);
        }
      }
    }
    return [...columns.values()].sort((a, b) => compareBytewise(a.element, b.element));
  };

  // ---- Walk every row: build the per-scope index, collect dangling refs. --
  interface IndexRow {
    sysId: string;
    table: string;
    name: string;
  }
  const rowsByScope = new Map<string, IndexRow[]>();
  const scopes = new Set<string>();
  const danglingRefs: DanglingReference[] = [];
  let indexedRecords = 0;

  for (const table of tables) {
    const data = await reader.table(table);
    // A scope with a shard set but zero records still gets an index file: the
    // file is a function of the tree, and "this scope claims nothing" is a
    // statement worth a stable, reviewable page (INV-9).
    for (const scope of data.scopes) {
      scopes.add(scope);
    }
    const referenceColumns = referenceColumnsFor(table);
    for (const ref of data.refs) {
      const row: IndexRow = { sysId: ref.sysId, table, name: ref.entry.name };
      const list = rowsByScope.get(ref.scope);
      if (list === undefined) {
        rowsByScope.set(ref.scope, [row]);
      } else {
        list.push(row);
      }
      indexedRecords += 1;
      if (referenceColumns.length === 0) {
        continue;
      }
      const fields = await reader.envelope(ref);
      for (const column of referenceColumns) {
        const value = envelopeField(fields, column.element);
        if (value === null || !isMirrorSysId(value)) {
          // Empty, absent, or not sys_id-shaped: nothing verifiable to check.
          continue;
        }
        const targetTable = resolveTableRef(column.targetRaw);
        if (targetTable === null) {
          // The dictionary row's own target is unresolvable — the column is
          // unverifiable, which is not the same claim as dangling.
          continue;
        }
        const target = await reader.table(targetTable);
        if (target.scopes.length === 0 || !target.complete) {
          // Not mirrored, or mirrored without complete evidence (INV-4):
          // absence proves nothing either way.
          continue;
        }
        if (!target.bySysId.has(value)) {
          danglingRefs.push({
            scope: ref.scope,
            table,
            sysId: ref.sysId,
            field: column.element,
            targetTable,
            targetSysId: value,
          });
        }
      }
    }
  }

  // (scope, table, sysId, field) is already unique — a scope's shard set maps
  // each sys_id at most once and reference columns are deduped by element — so
  // this comparator is a total order with no further tiebreak to reach.
  danglingRefs.sort(
    (a, b) =>
      compareBytewise(a.scope, b.scope) ||
      compareBytewise(a.table, b.table) ||
      compareBytewise(a.sysId, b.sysId) ||
      compareBytewise(a.field, b.field)
  );

  // ---- Render one document per scope. -------------------------------------
  let scopeDocuments = 0;
  const sortedScopes = [...scopes].sort(compareBytewise);
  for (const scope of sortedScopes) {
    const rows = rowsByScope.get(scope) ?? [];
    rows.sort(
      (a, b) => compareBytewise(a.sysId, b.sysId) || compareBytewise(a.table, b.table)
    );
    const lines: string[] = [
      `# Reference index: ${escapeCell(scope)}`,
      "",
      "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
      "",
      "| sys_id | table | name |",
      "| --- | --- | --- |",
    ];
    for (const row of rows) {
      lines.push(
        `| ${row.sysId} | ${escapeCell(row.table)} | ${escapeCell(row.name)} |`
      );
    }
    const scopeDangling = danglingRefs.filter((entry) => entry.scope === scope);
    lines.push("", "## Dangling references (D2: reported, never repaired)", "");
    if (scopeDangling.length === 0) {
      lines.push("None.");
    } else {
      lines.push(
        "| table | sys_id | field | target table | target sys_id |",
        "| --- | --- | --- | --- | --- |"
      );
      for (const entry of scopeDangling) {
        lines.push(
          `| ${escapeCell(entry.table)} | ${entry.sysId} | ${escapeCell(entry.field)} | ${escapeCell(entry.targetTable)} | ${entry.targetSysId} |`
        );
      }
    }
    const relPath = repoPath(DERIVED_DIR_NAME, REFS_DIR_NAME, `${scope}.md`);
    await writeDerivedFile(fs, root, relPath, lines.join("\n"), filesWritten);
    scopeDocuments += 1;
  }

  return { scopeDocuments, indexedRecords, danglingRefs };
}
