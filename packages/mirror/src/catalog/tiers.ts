// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tier assignment — design §4.1's five tiers, projected onto the three the
 * {@link TableCatalogEntry} contract can carry.
 *
 * The design names five tiers; `TableCatalogEntry.tier` is `1 | 2 | 3`. That is
 * not an oversight to route around: T4 (runtime/operational — logs, events, ECC
 * queue) and T5 (binaries) have the same answer as an unclassified table —
 * "this is not mirrored as a table" — and a tier number is not where that answer
 * belongs. So the projection keeps `tier` as the MIRRORING BAND the number is
 * read as everywhere downstream (1 = metadata, 2 = curated config, 3 = not
 * mirrored by default) and returns the design's own reason alongside it as
 * {@link TableKind}, which is what {@link CatalogService} turns into a `status`
 * an operator can act on. Dropping T4/T5 tables from the catalog instead would
 * be the one thing R3 forbids outright: a table absent from the coverage report
 * is a silent skip, and "we deliberately never mirror `syslog`" and "we never
 * saw `syslog`" would then be indistinguishable.
 *
 * The T1 band is the only one that is DISCOVERED (design §4.2 — via the
 * `super_class` closure computed by {@link CatalogService}, never a table list).
 * T2/T3/T5 are curated because they cannot be derived: nothing in
 * `sys_db_object` says that `sys_choice` is configuration and `sys_email` is
 * runtime. The curated sets are therefore small, explicit, and — critically —
 * only ever ADD tables to the mirror relative to the default answer, so a
 * ServiceNow release that invents a new table gets the safe answer (not
 * mirrored, reported) rather than a wrong one.
 */

/** Why a table landed in its band — the design tier, not a number. */
export type TableKind =
  /** T1: reached `sys_metadata` through its `super_class` chain (design §4.2). */
  | "metadata"
  /** T2: curated configuration table outside `sys_metadata`. */
  | "config-table"
  /** T3: foundational reference data — opt-in, because it is data and often PII. */
  | "reference-data"
  /** T5: binary content, owned by the attachment pipeline rather than by a table sweep. */
  | "binary"
  /** T4 and everything else: no rule claims it, so the default answer is "not mirrored". */
  | "unclassified";

/** A table's mirroring band plus the reason it got that band. */
export interface TierAssignment {
  /** Mirroring band as {@link TableCatalogEntry} spells it. */
  tier: 1 | 2 | 3;
  /** The design tier that produced the band. */
  kind: TableKind;
}

/**
 * T2 — configuration that lives outside `sys_metadata` (design §4.2, initial set).
 *
 * These carry real configuration and diff meaningfully, but no chain reaches
 * `sys_metadata`, so the closure cannot find them. `sys_trigger` is deliberately
 * NOT here despite the design listing it under T2: its rows carry the next
 * execution time of every scheduled job, so it rewrites itself continuously and
 * would produce a diff on every sync — the churn that `NOISE_ELEMENTS` exists to
 * prevent, one table up. It becomes mirrorable when it can be mirrored
 * report-only.
 */
export const CONFIG_TABLES: ReadonlySet<string> = new Set([
  "sys_choice",
  "sys_number_counter",
  "sys_properties",
  "v_plugin",
]);

/**
 * T3 — foundational reference data, off unless `tiers.referenceData` is on.
 *
 * Off by default for two independent reasons, either of which alone would be
 * enough: it is data rather than configuration, and `sys_user` holds names,
 * emails and phone numbers that an operator did not ask to publish into a git
 * history. The opt-in is a single config flag rather than a per-table list
 * because the tables only make sense together — group membership without groups
 * is not a smaller mirror, it is a broken one.
 */
export const REFERENCE_DATA_TABLES: ReadonlySet<string> = new Set([
  "cmn_location",
  "core_company",
  "sys_user",
  "sys_user_group",
  "sys_user_grmember",
  "sys_user_has_role",
  "sys_user_role",
]);

/**
 * T5 — binaries, handled by the attachment pipeline and not by a table sweep.
 *
 * Named explicitly rather than left to the default so the coverage report can
 * say WHY they are not swept. `sys_attachment` rows do reach the tree — through
 * the Attachment API, with the size and LFS rules of design §8.4 — and sweeping
 * the table as ordinary rows would either duplicate that content or, for
 * `sys_attachment_doc`, pull base64 chunks of every binary on the instance into
 * `record.json` files.
 */
export const BINARY_TABLES: ReadonlySet<string> = new Set([
  "db_image",
  "sys_attachment",
  "sys_attachment_doc",
]);

/**
 * Band one table.
 *
 * `isMetadata` comes from the caller's `super_class` closure and WINS over the
 * curated sets, which is the whole point of design §4.2: the closure is measured
 * against the instance in front of us, and a curated list is a claim about an
 * instance somebody else had. On ven01800 `sys_properties` does extend
 * `sys_metadata`, so it bands as T1 there and the T2 entry never fires — exactly
 * the self-healing the dynamic discovery was chosen for.
 */
export function assignTier(name: string, isMetadata: boolean): TierAssignment {
  if (isMetadata) {
    return { tier: 1, kind: "metadata" };
  }
  if (CONFIG_TABLES.has(name)) {
    return { tier: 2, kind: "config-table" };
  }
  if (REFERENCE_DATA_TABLES.has(name)) {
    return { tier: 3, kind: "reference-data" };
  }
  if (BINARY_TABLES.has(name)) {
    return { tier: 3, kind: "binary" };
  }
  return { tier: 3, kind: "unclassified" };
}
