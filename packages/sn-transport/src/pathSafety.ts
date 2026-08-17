// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Path safety — the rules that decide whether a ServiceNow-supplied string may
 * become a filesystem path component, and what it looks like once it does.
 *
 * This is the WP-M0 lift (architecture doc §5.1, Δ2). The predicate and the
 * containment assertion below are **behavior-identical copies** of the v1 core
 * implementation, moved here so the CLI download pipeline and the full-instance
 * mirror share one rule instead of two that drift:
 *
 *   - `isSafePathComponent` — `packages/core/src/genericUtils.ts`
 *   - `assertSafePathComponent` / `CONTAINMENT_BOUNDARY` — `packages/core/src/downloadPipeline.ts`
 *   - `canonicalFoldName` — `canonicalName` in `packages/core/src/repairCommand.ts`
 *   - `foldNameComponent` / `buildSafeRecordName` — the naming half of
 *     `buildRecordName` in `packages/core/src/manifestBuilder.ts`
 *   - `resolveUniqueNames` — the order-independent collision pass in the same file
 *
 * The core golden tests for the predicate are copied verbatim into this
 * package's suite (only the import path changes), so a behavioral change here
 * fails them.
 *
 * On top of the lift this module adds the three D18 guards that the mirror
 * needs and v1 did not have, because v1 only ever wrote a hand-picked scope
 * while the mirror writes every record on the instance (analyses §9.2):
 *
 *   1. NFC normalization, so a name that arrives decomposed does not become a
 *      second directory next to its composed twin.
 *   2. A `MAX_NAME_BYTES` UTF-8 byte cap, because the limit filesystems enforce
 *      is bytes, not characters.
 *   3. Case-insensitive uniqueness with a deterministic `_<sysId>` suffix,
 *      because APFS and NTFS fold case and two records whose names differ only
 *      in case would otherwise fight over one file forever.
 *
 * Pure compute: nothing here touches the filesystem.
 */

/**
 * Whether a string may be used as a single path component.
 *
 * Lifted verbatim from `packages/core/src/genericUtils.ts`. The rule is the
 * INJ-1 containment guard: reject anything empty, anything that is only dots
 * (`.`, `..`, `...`), and anything carrying a separator in either slash
 * direction. The `typeof` check stays even though the parameter is typed,
 * because the values reaching it come from JSON the instance sent, not from
 * TypeScript.
 */
export const isSafePathComponent = (component: string): boolean =>
  typeof component === "string" &&
  component.length > 0 &&
  !/^\.+$/.test(component) &&
  !/[/\\]/.test(component);

/** Which kind of component failed the check — shapes the error message. */
export type UnsafeComponentKind = "table name" | "record name" | "field name" | "file type";

/**
 * The boundary each component kind must not escape.
 *
 * Lifted verbatim from `packages/core/src/downloadPipeline.ts`. Naming the
 * actual boundary is the point: "unsafe record name" alone does not tell an
 * operator what the instance was trying to reach.
 */
const CONTAINMENT_BOUNDARY: Record<UnsafeComponentKind, string> = {
  "table name": "the workspace source root",
  "record name": "the workspace source root",
  "field name": "its record's directory",
  "file type": "its record's directory",
};

/**
 * Throw unless `component` is safe to use as a path component.
 *
 * Lifted verbatim from `packages/core/src/downloadPipeline.ts`, message text
 * included, so the copied golden tests keep matching.
 */
export const assertSafePathComponent = (component: string, kind: UnsafeComponentKind): void => {
  if (!isSafePathComponent(component)) {
    throw new Error(
      `Refusing to download: unsafe ${kind} ${JSON.stringify(component)} ` +
        `would escape ${CONTAINMENT_BOUNDARY[kind]}.`
    );
  }
};

/**
 * What a `/` or `\` inside a record name becomes on disk: U+3033, VERTICAL KANA
 * REPEAT MARK.
 *
 * Same character v1 uses (`manifestBuilder.ts`), for the same reason: it reads
 * like a slash, it is legal in a path component on every filesystem the project
 * supports, and it is rare enough in real record names that the substitution is
 * effectively unambiguous.
 */
export const SEPARATOR_REPLACEMENT = "〳";

/**
 * Longest a single path component may be, in UTF-8 bytes (architecture doc §11).
 *
 * Bytes, not characters: ext4 and APFS both cap a component at 255 *bytes*, so
 * a 100-character Cyrillic name is already 200 bytes. 200 leaves room for the
 * `_<sysId>` collision suffix (33 bytes) inside the 255 limit, and M15 measured
 * the longest real name on a live instance at 92 bytes — over 2x headroom.
 */
export const MAX_NAME_BYTES = 200;

/** UTF-8 measurement, shared so a per-call encoder is not allocated. */
const UTF8 = new TextEncoder();

/** UTF-8 byte length of a string. */
export const nameByteLength = (name: string): number => UTF8.encode(name).length;

/**
 * The comparison form of a name — what "the same name" means on disk.
 *
 * Lifted from `canonicalName` in `packages/core/src/repairCommand.ts`. Three
 * folds, each for a real filesystem behavior: NFC because macOS hands back
 * composed names for what was written decomposed, lower-case because APFS and
 * NTFS are case-insensitive by default, and the trailing dot/space strip
 * because Windows silently drops both when creating a file, so `Foo.` and `Foo`
 * are one file there.
 *
 * This is the stronger of the two folds v1 uses (the collision pass in
 * `manifestBuilder.ts` only does NFC + lower-case). The mirror deliberately
 * takes the stronger one: it writes a fresh tree with no legacy names to
 * preserve, so catching the extra collision class up front costs nothing and
 * avoids a rename later.
 */
export const canonicalFoldName = (name: string): string =>
  name.normalize("NFC").toLowerCase().replace(/[.\s]+$/u, "");

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * Slicing by `.length` would cut inside a surrogate pair or a multi-byte
 * sequence and produce a name containing U+FFFD, which then differs from
 * itself between the manifest and the disk. Iterating a string yields whole
 * code points, so the accumulator can never stop mid-character.
 */
export function truncateToNameByteCap(name: string, maxBytes = MAX_NAME_BYTES): string {
  if (nameByteLength(name) <= maxBytes) {
    return name;
  }
  let out = "";
  let used = 0;
  for (const codePoint of name) {
    const size = nameByteLength(codePoint);
    if (used + size > maxBytes) {
      break;
    }
    out += codePoint;
    used += size;
  }
  return out;
}

/**
 * Turn a raw ServiceNow name into the on-disk form, or `""` if it has none.
 *
 * The pipeline order matters:
 *
 *  1. Separators are replaced first, so a name like `a/b` becomes one component
 *     rather than being rejected as unsafe.
 *  2. NFC next (D18), so the byte cap measures the form that is actually
 *     written and the fold below compares like with like.
 *  3. The byte cap last, so truncation cannot chop a combining mark off the
 *     base character it was just composed onto.
 *
 * Returns `""` for a name that is blank or only dots after folding — the same
 * signal `buildRecordName` uses in v1 to tell the caller to fall back to the
 * sys_id rather than write `..` as a directory.
 */
export function foldNameComponent(raw: string): string {
  const separated = raw.replace(/[/\\]/g, SEPARATOR_REPLACEMENT);
  const normalized = separated.normalize("NFC");
  const capped = truncateToNameByteCap(normalized);
  if (capped.trim() === "" || /^\.+$/.test(capped.trim())) {
    return "";
  }
  return capped;
}

/**
 * The on-disk name for one record: its folded display name, else its sys_id.
 *
 * Mirrors the tail of `buildRecordName` in `packages/core/src/manifestBuilder.ts`
 * — including the last resort of `""`, which means the row cannot be given a
 * containable name at all and must be reported as a gap rather than written
 * somewhere unpredictable.
 */
export function buildSafeRecordName(rawName: string, sysId: string): string {
  const folded = foldNameComponent(rawName);
  if (folded) {
    return folded;
  }
  return isSafePathComponent(sysId) ? sysId : "";
}

/**
 * One record competing for a name inside a single directory.
 *
 * `name` MUST already be the output of `buildSafeRecordName` (or at least of
 * `foldNameComponent`). This mirrors v1, where the collision pass in
 * `manifestBuilder.ts` runs over names `buildRecordName` has already produced —
 * but here the two halves are exported side by side, so the precondition has to
 * be stated rather than implied by call order.
 *
 * It is load-bearing, not stylistic. `resolveUniqueNames` compares under
 * `canonicalFoldName` yet writes `name` through verbatim, so a raw instance
 * string handed in directly is grouped in its folded form and then written in
 * its unfolded one: past the `MAX_NAME_BYTES` cap, still NFD, still carrying the
 * separators `foldNameComponent` would have replaced. The names would be unique
 * and the tree would still be wrong.
 */
export interface NameCandidate {
  readonly sysId: string;
  readonly name: string;
}

/** Outcome of resolving a directory's worth of names (D18). */
export interface UniqueNameResolution {
  /** sys_id to final on-disk name, for every candidate that got one. */
  names: Map<string, string>;
  /** sys_ids that needed the `_<sysId>` suffix, in input order. */
  collided: string[];
  /** Candidates dropped because the name or the sys_id is not containable. */
  unusable: NameCandidate[];
}

/**
 * Make every name in one directory unique under case-insensitive comparison.
 *
 * The algorithm is v1's (`manifestBuilder.ts`) and its key property is that it
 * is **order-independent**: names are grouped by their canonical fold first,
 * and then *every* member of a group larger than one distinct sys_id gets the
 * suffix. The naive alternative — "first writer keeps the plain name, later
 * ones get suffixed" — makes the output depend on the order the API happened to
 * return rows in, so an unchanged instance would produce a different tree on
 * every run and every mirror commit would look like a change.
 *
 * The suffix is `_<sysId>`: deterministic, globally unique, and it survives a
 * later rename of the colliding record.
 *
 * Unusable candidates are returned rather than dropped silently, so the caller
 * can record them as coverage gaps instead of quietly shrinking the tree.
 */
export function resolveUniqueNames(
  candidates: readonly NameCandidate[]
): UniqueNameResolution {
  const usable: NameCandidate[] = [];
  const unusable: NameCandidate[] = [];
  for (const candidate of candidates) {
    if (isSafePathComponent(candidate.name) && isSafePathComponent(candidate.sysId)) {
      usable.push(candidate);
    } else {
      unusable.push(candidate);
    }
  }

  // Insertion-ordered so `collided` and the resulting tree are reproducible.
  const groups = new Map<string, NameCandidate[]>();
  for (const candidate of usable) {
    const key = canonicalFoldName(candidate.name);
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  const names = new Map<string, string>();
  const collided: string[] = [];
  for (const group of groups.values()) {
    // Distinct sys_ids, not group length: the same record listed twice is not a
    // collision with itself, and v1 counts it the same way.
    const distinct = new Set(group.map((candidate) => candidate.sysId));
    if (distinct.size === 1) {
      for (const candidate of group) {
        names.set(candidate.sysId, candidate.name);
      }
      continue;
    }
    for (const candidate of group) {
      const suffix = `_${candidate.sysId}`;
      // The suffix has to fit inside the cap too, so the base is re-truncated
      // against the remaining budget rather than appended blindly.
      const budget = Math.max(0, MAX_NAME_BYTES - nameByteLength(suffix));
      const base = truncateToNameByteCap(candidate.name, budget);
      names.set(candidate.sysId, `${base}${suffix}`);
      collided.push(candidate.sysId);
    }
  }

  return { names, collided, unusable };
}
