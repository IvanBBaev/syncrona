// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `_derived/acl/matrix.md` — the ACL matrix view (D9, §5.12).
 *
 * D9: "ACL corpus gets a derived-layer matrix view; canonical stays
 * row-by-row." The canonical layer's ACL story is deliberately boring — one
 * record directory per `sys_security_acl` row, one per `sys_security_acl_role`
 * join, one per `sys_user_role` — because row-level storage is what makes ACL
 * diffs attributable to single instance changes. The cost is that answering
 * "who can write incident.number?" from the canonical layer means joining
 * three tables by hand. This view pays that cost once per sync: one table,
 * one row per ACL, roles resolved to names, sorted so the same corpus always
 * renders the same bytes (INV-9).
 *
 * WP-M12's acceptance for this view is explicit: "ACL matrix renders from
 * row-level canonical" — the inputs here are shard entries and `record.json`
 * envelopes of those three tables, nothing else.
 *
 * Rendering decisions, since no spec document fixes the shape:
 *  - One Markdown table, rows sorted by (name, type, operation, sys_id). The
 *    sys_id column stays: two ACLs on the same name+operation are distinct
 *    rows on the instance and must be distinct — and attributable — rows here.
 *  - The row's roles are the `sys_user_role` names reached through the join
 *    table, sorted and comma-joined; a role reference the tree cannot resolve
 *    renders as the raw sys_id (D2 — the tear stays visible). No roles renders
 *    as an empty cell: an ACL with no role requirement is a real and important
 *    configuration, not a defect.
 *  - The file is written even when no ACL tables are mirrored: flag on ⇒ file
 *    exists is a contract the CI regeneration check can rely on, and an empty
 *    matrix over a tree that mirrors no ACLs is the correct function value
 *    (INV-9), not a degenerate case to special-case away.
 */
import { compareBytewise } from "../order";
import { repoPath } from "../shards/shardLayout";
import type { WriterFs } from "../write/fs";
import type { CanonicalTreeReader, DerivedAnomaly } from "./canonicalTree";
import { envelopeField } from "./canonicalTree";
import {
  ACL_DIR_NAME,
  ACL_MATRIX_FILE_NAME,
  DERIVED_DIR_NAME,
  escapeCell,
  writeDerivedFile,
} from "./render";

/**
 * Generate the ACL matrix. Returns the number of ACL rows rendered.
 */
export async function generateAclMatrixView(
  fs: WriterFs,
  root: string,
  reader: CanonicalTreeReader,
  filesWritten: string[],
  anomalies: DerivedAnomaly[]
): Promise<number> {
  const acls = await reader.table("sys_security_acl");
  const joins = await reader.table("sys_security_acl_role");
  const roles = await reader.table("sys_user_role");

  const roleLabel = (roleSysId: string): string => {
    const roleRef = roles.bySysId.get(roleSysId);
    // Dangling role reference: the sys_id is the label (D2 — render the tear).
    return roleRef === undefined ? roleSysId : roleRef.entry.name;
  };

  const roleLabelsByAcl = new Map<string, string[]>();
  for (const join of joins.records) {
    const fields = await reader.envelope(join);
    const aclSysId = envelopeField(fields, "sys_security_acl");
    const roleSysId = envelopeField(fields, "sys_user_role");
    if (aclSysId === null || roleSysId === null) {
      anomalies.push({
        source: "aclMatrix",
        detail: `sys_security_acl_role ${join.sysId}: missing sys_security_acl or sys_user_role reference; skipped`,
      });
      continue;
    }
    if (!acls.bySysId.has(aclSysId)) {
      // The join names an ACL the tree does not hold, so there is no matrix
      // row to attach the role to — named here, counted by the refs view's
      // dangling detector when enabled (D2).
      anomalies.push({
        source: "aclMatrix",
        detail: `sys_security_acl_role ${join.sysId}: acl ${aclSysId} is not in the tree; skipped (D2)`,
      });
      continue;
    }
    const label = roleLabel(roleSysId);
    const list = roleLabelsByAcl.get(aclSysId);
    if (list === undefined) {
      roleLabelsByAcl.set(aclSysId, [label]);
    } else {
      list.push(label);
    }
  }

  interface MatrixRow {
    name: string;
    type: string;
    operation: string;
    active: string;
    rolesCell: string;
    sysId: string;
  }
  const rows: MatrixRow[] = [];
  for (const acl of acls.records) {
    const fields = await reader.envelope(acl);
    if (fields === null) {
      anomalies.push({
        source: "aclMatrix",
        detail: `sys_security_acl ${acl.sysId}: unreadable envelope; skipped`,
      });
      continue;
    }
    const labels = roleLabelsByAcl.get(acl.sysId) ?? [];
    rows.push({
      name: envelopeField(fields, "name") ?? "(unnamed)",
      type: envelopeField(fields, "type") ?? "",
      operation: envelopeField(fields, "operation") ?? "",
      active: envelopeField(fields, "active") ?? "",
      rolesCell: [...labels].sort(compareBytewise).join(", "),
      sysId: acl.sysId,
    });
  }
  rows.sort(
    (a, b) =>
      compareBytewise(a.name, b.name) ||
      compareBytewise(a.type, b.type) ||
      compareBytewise(a.operation, b.operation) ||
      compareBytewise(a.sysId, b.sysId)
  );

  const lines: string[] = [
    "# ACL matrix (D9)",
    "",
    "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
    "The canonical layer stays row-by-row; this view is the join.",
    "",
    "| name | type | operation | active | roles | sys_id |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.name)} | ${escapeCell(row.type)} | ${escapeCell(row.operation)} | ${escapeCell(row.active)} | ${escapeCell(row.rolesCell)} | ${row.sysId} |`
    );
  }
  const relPath = repoPath(DERIVED_DIR_NAME, ACL_DIR_NAME, ACL_MATRIX_FILE_NAME);
  await writeDerivedFile(fs, root, relPath, lines.join("\n"), filesWritten);
  return rows.length;
}
