// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared rendering and naming machinery for the `_derived/` views (§5.12, §8).
 *
 * Three concerns live here because every view needs all three identically, and
 * a view that re-spelled any of them would drift:
 *
 *  1. **Where the views live.** §8.1 fixes `_derived/forms/<table>/<view>.md`,
 *     `_derived/workflows/<name>@<version>.md` and `_derived/refs/<scope>.md`.
 *     The ACL matrix (D9) has no path in any spec document; `_derived/acl/`
 *     with a single `matrix.md` is this module's decision — its own directory
 *     rather than a loose file so that the entry point can manage every view as
 *     "one subtree per flag", which is what makes disabled-flag cleanup and the
 *     INV-9 delete-and-regenerate test uniform across all four views.
 *
 *  2. **How bytes land.** Derived files go through `atomicWriteFile` (R4 — a
 *     truncated Markdown file in a git working tree commits and diffs just as
 *     badly as a truncated `record.json`) and are encoded with the serializer's
 *     own `encodeUtf8`/`withTrailingNewline`, so §8's byte canon (UTF-8, no
 *     BOM, LF, exactly one trailing newline) is inherited rather than imitated.
 *
 *  3. **How instance strings become file names.** Table names, view names and
 *     workflow names are instance-controlled text; the canonical layer already
 *     solved "hostile string → safe unique path component" (§7.4, D18) with
 *     `buildSafeRecordName` + `resolveUniqueNames`, and the derived layer MUST
 *     reuse that pipeline, not approximate it: two views whose names differ
 *     only by case must collide here for exactly the reasons they collide in
 *     the record tree (case-insensitive filesystems), and the `_<sysId>` suffix
 *     must be the same suffix a reader has already learned to ignore. The
 *     anchor sys_id fed to the resolver is always content-derived (the
 *     bytewise-least contributing record's sys_id), never enumeration-derived,
 *     so the resolved names are as reproducible as the content (INV-9).
 */
import { compareBytewise } from "../order";
import { encodeUtf8, withTrailingNewline } from "../serialize/serializer";
import { atomicWriteFile } from "../write/atomicWrite";
import type { WriterFs } from "../write/fs";
import { toNativePath } from "../write/fs";
import { dirname } from "node:path";
import {
  buildSafeRecordName,
  resolveUniqueNames,
  type NameCandidate,
} from "@syncrona/sn-transport";

/** Root of the regenerable layer (§8.1). Not in `constants.ts` on purpose: no other module may write here. */
export const DERIVED_DIR_NAME = "_derived";
/** `_derived/forms/<table>/<view>.md` (§8.1). */
export const FORMS_DIR_NAME = "forms";
/** `_derived/workflows/<name>@<version>.md` (§8.1). */
export const WORKFLOWS_DIR_NAME = "workflows";
/** `_derived/refs/<scope>.md` (§8.1). */
export const REFS_DIR_NAME = "refs";
/** `_derived/acl/` — D9's matrix view; path decided here (see module docblock). */
export const ACL_DIR_NAME = "acl";
/** The single file inside `_derived/acl/`. */
export const ACL_MATRIX_FILE_NAME = "matrix.md";

/**
 * Make an instance string safe inside one Markdown table cell or heading.
 *
 * Record display names and captions are instance-controlled and may contain
 * the two characters that break a Markdown table — `|` and line breaks — plus
 * the escape character itself. The replacement is visible (`\n` renders as the
 * two characters backslash-n) rather than lossy (collapsing to a space would
 * make two distinct names render identically), because a derived view exists
 * to be read and diffed, and a diff between `a\nb` and `a b` must not vanish.
 */
export function escapeCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/**
 * Write one derived file: parent directory, atomic replace, §8 byte canon.
 *
 * `makeDir` before every write rather than once per view: `atomicWriteFile`
 * stages a sibling of the destination, so the destination's directory must
 * exist BEFORE the staging write, and "the caller surely created it" is
 * exactly the kind of implied precondition this codebase spells out instead.
 * The repo-relative path is appended to `filesWritten` so the summary can say
 * precisely what landed; the entry point sorts that list at the end.
 */
export async function writeDerivedFile(
  fs: WriterFs,
  root: string,
  relPath: string,
  markdown: string,
  filesWritten: string[]
): Promise<void> {
  const nativePath = toNativePath(root, relPath);
  await fs.makeDir(dirname(nativePath));
  await atomicWriteFile(fs, nativePath, encodeUtf8(withTrailingNewline(markdown)));
  filesWritten.push(relPath);
}

/**
 * Resolve raw instance labels to unique, safe file-name stems.
 *
 * Input: raw label → anchor sys_id, where the anchor is the bytewise-least
 * sys_id among the records that produced the label (content-derived, so the
 * suffix a collision mints is stable across runs and enumeration orders).
 * Output: raw label → path-safe stem, unique within one output directory under
 * the same case-insensitive fold the canonical layer uses.
 *
 * Labels are sorted before resolution only for reproducibility of the
 * resolver's internal grouping; `resolveUniqueNames` is order-independent for
 * the names it PRODUCES, but this module refuses to rely on that when one
 * `sort` makes the question moot.
 */
export function uniqueNamesForLabels(
  labelAnchors: ReadonlyMap<string, string>
): Map<string, string> {
  const sorted = [...labelAnchors.entries()].sort(([a], [b]) =>
    compareBytewise(a, b)
  );
  const candidates: NameCandidate[] = sorted.map(([raw, anchor]) => ({
    sysId: anchor,
    name: buildSafeRecordName(raw, anchor),
  }));
  const resolution = resolveUniqueNames(candidates);
  const names = new Map<string, string>();
  for (const [raw, anchor] of sorted) {
    const resolved = resolution.names.get(anchor);
    /* istanbul ignore if -- @preserve: unreachable by construction. Anchors are
       sys_ids validated at shard-parse time (INV-6), so `buildSafeRecordName`
       always has a safe fallback and `resolveUniqueNames` can never classify
       the candidate unusable — the only way `names` lacks an anchor. */
    if (resolved === undefined) {
      continue;
    }
    names.set(raw, resolved);
  }
  return names;
}
