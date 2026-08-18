// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Record naming and collision resolution for a streaming sweep (§5.8, F9, D18).
 *
 * The problem this module solves is a shape mismatch. `resolveUniqueNames` in
 * `@syncrona/sn-transport` answers "given ALL the records that want to live in this
 * directory, what is each one called?" — and it must see all of them, because its
 * defining property is order-independence: when two names fold to the same string,
 * *every* member of the group gets the `_<sysId>` suffix, including the one that
 * arrived first. That is what stops an unchanged instance from producing a
 * different tree depending on the order the Table API happened to page rows in.
 *
 * The mirror, however, writes as it fetches. A table of 900 000 records cannot be
 * buffered to decide names, and a sweep that only wrote at the end would lose
 * everything it had done on an interrupt.
 *
 * The reconciliation is that collision groups are **independent**. A record's final
 * name depends only on the other records whose names share its canonical fold —
 * `resolveUniqueNames` groups first, then decides each group in isolation, and no
 * decision crosses a group boundary. So running it on a single growing group
 * produces exactly the same answer it would have produced on the whole directory,
 * and it can be re-run each time that group grows. That equivalence is not asserted
 * here by argument alone: the `describe("order independence")` block in
 * `test/recordPath.test.ts` fuzzes arbitrary
 * candidate lists and requires this class's final assignment to equal
 * `resolveUniqueNames` over the same list as a whole, in every permutation.
 *
 * The price is a rename. When a group grows from one distinct sys_id to two, the
 * record already on disk must move from `foo` to `foo_<sysId>`. The alternative —
 * "first writer keeps the plain name" — needs no rename and is exactly the
 * order-dependent rule D18 rejects, because it makes the tree a function of the
 * API's paging order. One directory rename per collision, against a permanently
 * unstable tree: not a close call. Renames are surfaced to the caller rather than
 * performed here, because this module is pure and the writer owns the filesystem.
 *
 * Honest limit: memory. The resolver holds one candidate per record for the
 * duration of a table's sweep — roughly the sys_id plus the folded name, so on the
 * order of 100 bytes per record. A one-million-record table therefore costs about
 * 100 MB here, on top of the shard entries the writer holds for INV-4. Both are
 * bounded by the largest single table, not by the instance, and the largest table
 * measured in analyses §9 is far below that. If it ever becomes a problem the fix
 * is a spill-to-disk group index, not a change to the naming rule.
 *
 * Honest limit: `isSafePathComponent` (sn-transport, shared with v1's download
 * pipeline) rejects empty, dots-only and separator-bearing names, but not a name
 * containing a NUL or another C0 control character. Such a name reaches
 * `fs.writeFile`, where Node rejects it with `ERR_INVALID_ARG_VALUE` — so it fails
 * loudly and never creates a truncated path, but it is classified as a local I/O
 * failure (F8) rather than as the bad input it is. Fixing that means widening the
 * shared predicate in sn-transport, which is a change to v1's download behaviour
 * too and therefore not WP-M7's to make.
 */
import {
  buildSafeRecordName,
  canonicalFoldName,
  resolveUniqueNames,
  type NameCandidate,
} from "@syncrona/sn-transport";

import { SHARD_DIR_NAME, assertMirrorSysId } from "../shards/shardLayout";

/** Fold key of the one directory name a record may not take. */
const RESERVED_FOLD_KEY = canonicalFoldName(SHARD_DIR_NAME);

/**
 * Keep a record out of the directory the shard index owns.
 *
 * `.shards` is a legal ServiceNow display name and it survives the whole naming
 * pipeline untouched: `buildSafeRecordName` returns it verbatim and
 * `isSafePathComponent` accepts it. Left alone, `recordDirRelPath` would then
 * derive exactly the string `shardDirRelPath` derives — the record would be
 * written into the table's shard index, and a later `applyAuthorizedDeletion`,
 * re-deriving the same path, would delete the index for the whole table.
 *
 * The reservation is applied to the candidate BEFORE it is grouped, not to the
 * resolved name afterwards, and that ordering is what makes it correct rather than
 * merely effective. Two records both called `.shards` become two candidates called
 * `.shards_<their own sys_id>`, which are already distinct; and the pathological
 * case — one record called `.shards` while another is literally called
 * `.shards_<the first one's sys_id>` — lands both in the same fold group, where
 * `resolveUniqueNames` suffixes them exactly as it would any other collision. A
 * rename applied after grouping would have had to re-run that reasoning itself.
 *
 * The replacement is the constant `.shards_<sysId>` rather than
 * `<candidate>_<sysId>`, because the fold strips trailing dots and spaces: a name
 * of `.shards` followed by 190 spaces folds to the reserved key too, and appending
 * 33 bytes to it would breach `MAX_NAME_BYTES`. Those trailing characters carry no
 * meaning on disk — Windows drops them when creating the file, which is why the
 * fold strips them — so collapsing to the constant loses nothing and is 40 bytes
 * whatever the input was.
 */
function avoidReservedName(candidateName: string, sysId: string): string {
  return canonicalFoldName(candidateName) === RESERVED_FOLD_KEY
    ? `${SHARD_DIR_NAME}_${sysId}`
    : candidateName;
}

/** A previously admitted record whose on-disk name changed (F9). */
export interface RecordRename {
  /** The record that must move. */
  sysId: string;
  /** Name it currently has on disk. */
  from: string;
  /** Name it must have after this admission. */
  to: string;
}

/** What admitting one record to a directory decided. */
export interface NameAdmission {
  /**
   * Final on-disk name. Never empty, and deliberately not `string | null`.
   *
   * The obvious design has an "unnameable record" case: `buildSafeRecordName`
   * returns `""` when the display name folds away AND the sys_id is not a usable
   * component, and a caller would report that as a coverage gap. It cannot happen
   * here, and pretending otherwise would put an untestable branch on the hottest
   * path in the writer. `admit` asserts INV-6 first, so the sys_id is 32 lowercase
   * hex digits, and `isSafePathComponent` rejects only the empty string, dots-only
   * names and names carrying a separator — none of which 32 hex digits can be. The
   * fallback therefore always yields a usable name.
   *
   * That is an argument, so it is also a test: `test/recordPath.test.ts` fuzzes
   * the sys_id space and asserts `buildSafeRecordName(anything, sysId) !== ""`. If
   * sn-transport ever tightens the predicate and breaks the theorem, that test goes
   * red rather than this file silently starting to throw.
   */
  name: string;
  /**
   * Records already admitted whose name this admission changed. Empty on the
   * overwhelming majority of admissions; non-empty exactly when a fold group
   * crossed from one distinct sys_id to more than one.
   */
  renames: RecordRename[];
}

/**
 * Incremental, order-independent name assignment for one directory's records.
 *
 * "One directory" means one `(scope, table)` pair: names only collide with names
 * that share a parent, so a separate resolver per directory is both correct and the
 * smallest thing that can be correct.
 */
export class RecordNameResolver {
  /** Fold key → the candidates competing under it, in admission order. */
  private readonly groups = new Map<string, NameCandidate[]>();
  /** sys_id → the fold key it is currently filed under (re-admission needs it). */
  private readonly keyOf = new Map<string, string>();
  /** sys_id → the name the caller was last told to use. */
  private readonly assigned = new Map<string, string>();

  /**
   * Admit one record and get its name plus any renames the admission forced.
   *
   * Re-admitting a sys_id is supported and is not a corner case: an incremental
   * sweep re-fetches a record whose display name changed, which moves it from one
   * fold group to another. Both groups then have to be re-resolved — the old one
   * may drop back to a single member and lose its suffixes, the new one may gain
   * its second member and acquire them — which is why the removal below is a real
   * operation and not a `delete` on the assignment map.
   */
  admit(sysId: string, rawName: string): NameAdmission {
    // INV-6 before anything else. `buildSafeRecordName` falls back to the sys_id
    // when the display name is unusable, so an unvalidated sys_id would become a
    // directory name one line below this.
    assertMirrorSysId(sysId);

    // Non-empty by the theorem in {@link NameAdmission.name}. Were it ever empty,
    // `resolveUniqueNames` would file it as unusable and the guard at the bottom of
    // this method would throw — loudly, rather than deriving a path from `""`.
    const candidateName = avoidReservedName(
      buildSafeRecordName(rawName, sysId),
      sysId
    );

    const renames: RecordRename[] = [];
    const previousKey = this.keyOf.get(sysId);
    const key = canonicalFoldName(candidateName);
    if (previousKey !== undefined && previousKey !== key) {
      this.removeFromGroup(previousKey, sysId);
      this.resolveGroup(previousKey, renames);
    }

    const group = this.groups.get(key) ?? [];
    const existingIndex = group.findIndex((member) => member.sysId === sysId);
    const candidate: NameCandidate = { sysId, name: candidateName };
    if (existingIndex === -1) {
      group.push(candidate);
    } else {
      group[existingIndex] = candidate;
    }
    this.groups.set(key, group);
    this.keyOf.set(sysId, key);

    this.resolveGroup(key, renames);

    const name = this.assigned.get(sysId);
    /* istanbul ignore if -- @preserve: unreachable by construction; see below. */
    if (name === undefined) {
      // `resolveUniqueNames` only drops a candidate whose name or sys_id fails
      // `isSafePathComponent`, and both were established above (INV-6 for the
      // sys_id, `buildSafeRecordName` for the name). Kept as a loud failure rather
      // than a `!` so that a future change to either precondition surfaces here
      // instead of writing `undefined` into a path.
      throw new Error(
        `Internal error: name resolution dropped ${sysId}, which had passed validation`
      );
    }
    // Self-renames are reported too. A record that was seeded from the previous
    // sweep's baseline and comes back with a different display name has a directory
    // on disk under the old name; the writer must move it rather than write a second
    // directory and leave an orphan behind.
    return { name, renames };
  }

  /**
   * Register a record that this sweep has not (yet) fetched, from the shard baseline.
   *
   * Only an INCREMENTAL sweep seeds. The reason is a real collision: if record A is
   * called `foo` and is not re-fetched, and record B is renamed to `foo` in the same
   * window, an unseeded resolver sees one candidate for the fold key, hands B the
   * plain name `foo`, and B is written straight into A's directory. Seeding puts A
   * back in the group, so both get the `_<sysId>` suffix D18 requires and A's
   * directory is moved by the rename the admission reports.
   *
   * A FULL sweep must not seed: it observes every live record by definition, so a
   * baseline entry that never comes back is a deleted record, and keeping it in a
   * fold group would hold a suffix on a name that no longer collides with anything.
   *
   * `currentName` is the final on-disk name, so it may already carry the `_<sysId>`
   * suffix; the suffix is stripped to recover the base the group is keyed on.
   *
   * Honest limit: when a suffix was applied, `resolveUniqueNames` re-truncated the
   * base to fit the remaining byte budget, so for a name within ~33 bytes of
   * `MAX_NAME_BYTES` the recovered base is the truncated one and folds to a
   * different key than the untruncated original would. The consequence is confined
   * to that case and is a spurious extra suffix, never a lost or overwritten record.
   * Storing the pre-suffix base in {@link RecordEntry} would remove the caveat, and
   * that is a §4.3 contract change WP-M7 is not entitled to make.
   */
  seed(sysId: string, currentName: string): void {
    assertMirrorSysId(sysId);
    const suffix = `_${sysId}`;
    const base = currentName.endsWith(suffix)
      ? currentName.slice(0, currentName.length - suffix.length)
      : currentName;
    // A base that has been truncated to nothing (a name that was ONLY a suffix)
    // cannot be a path component; fall back to the stored name, which was one.
    //
    // The reservation is applied here as well, and not only in `admit`. The two
    // must agree on the fold key or seeding stops working: a baseline entry named
    // `.shards_<sysId>` recovers the base `.shards`, and without this call it would
    // be filed under the reserved key while the same record's admission files it
    // under the suffixed one — the seeded copy would linger in a group it can never
    // be re-resolved out of, holding a suffix on a name nothing collides with.
    const candidateName = avoidReservedName(
      base === "" ? currentName : base,
      sysId
    );
    const key = canonicalFoldName(candidateName);
    const group = this.groups.get(key) ?? [];
    group.push({ sysId, name: candidateName });
    this.groups.set(key, group);
    this.keyOf.set(sysId, key);
    // Seeded with the name that is actually on disk, so that a later re-resolution
    // reports a rename only if the name genuinely has to change.
    this.assigned.set(sysId, currentName);
  }

  /** The name currently assigned to a sys_id, or `undefined` if never admitted. */
  nameOf(sysId: string): string | undefined {
    return this.assigned.get(sysId);
  }

  /** Every assignment made so far — used by the equivalence property test. */
  snapshot(): Map<string, string> {
    return new Map(this.assigned);
  }

  private removeFromGroup(key: string, sysId: string): void {
    const group = this.groups.get(key);
    /* istanbul ignore if -- @preserve: keyOf and groups are written together. */
    if (group === undefined) {
      return;
    }
    const remaining = group.filter((member) => member.sysId !== sysId);
    if (remaining.length === 0) {
      this.groups.delete(key);
    } else {
      this.groups.set(key, remaining);
    }
  }

  /**
   * Re-decide one fold group and record every name that changed.
   *
   * `resolveUniqueNames` is called on the group alone — that is the whole trick, and
   * the reason it is a call rather than a reimplementation is that the suffix
   * format, the re-truncation of the base against the remaining byte budget, and
   * the "distinct sys_ids, not group length" rule are all decisions D18 already
   * made in one place. A second copy here would be a second place for them to
   * change.
   */
  private resolveGroup(key: string, renames: RecordRename[]): void {
    const group = this.groups.get(key);
    if (group === undefined) {
      return;
    }
    const resolution = resolveUniqueNames(group);
    for (const [sysId, name] of resolution.names) {
      const previous = this.assigned.get(sysId);
      if (previous !== undefined && previous !== name) {
        renames.push({ sysId, from: previous, to: name });
      }
      this.assigned.set(sysId, name);
    }
  }
}
