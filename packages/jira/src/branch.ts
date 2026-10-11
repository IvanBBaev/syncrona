// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Extract a Jira issue key (e.g. `ABC-123`) from a git branch name.
 *
 * Pure and trivially unit-testable. Scans for Jira-style keys — a project prefix
 * of an uppercase letter followed by uppercase letters, digits or underscores, a
 * hyphen, then the issue number — and returns the *first* one whose prefix is not
 * a well-known non-project token: `feature/ABC-123-do-thing` → `ABC-123`,
 * `MY_PROJ-12` → `MY_PROJ-12` (not `PROJ-12`, which is a different project).
 *
 * Returns null when no key is present. The input is upper-cased first so a
 * lowercase branch (`feature/abc-123`) still resolves; Jira keys are always
 * stored/queried in uppercase.
 */

/**
 * Prefixes that look like a Jira key (uppercase letters + `-` + digits) but are
 * really standards/notation tokens commonly found in branch names. Without this
 * denylist `fix/utf-8-encoding` would resolve to the bogus key `UTF-8`. The trade
 * is a false-negative for the (vanishingly rare) project literally named one of
 * these; when several keys are present we skip the denylisted ones and keep the
 * first genuine match, so `fix-utf-8-for-ABC-42` still resolves to `ABC-42`.
 */
const NON_KEY_PREFIXES = new Set(["UTF", "SHA", "RFC", "ISO", "CVE", "UTC"]);

/**
 * Branch-type words that snake_case branch names put in front of the key with an
 * underscore (`feature_abc-123`). Since `_` is legal inside a project key, they
 * would otherwise be read as part of it (`FEATURE_ABC-123`).
 */
const BRANCH_TYPE_SEGMENTS = new Set([
  "FEATURE",
  "FEAT",
  "BUGFIX",
  "FIX",
  "HOTFIX",
  "RELEASE",
  "CHORE",
]);

/** Shape of a Jira project key; the same prefix pattern the scanner matches. */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/**
 * Strip leading branch-type words (and the empty segments a doubled underscore
 * leaves between them and the key, as in `feature__abc-1`). Returns null when
 * what remains is not a project key: `release_2026-10` leaves `2026`, which
 * starts with a digit and so names no project.
 */
function stripBranchTypeSegments(prefix: string): string | null {
  const segments = prefix.split("_");
  let stripped = false;
  while (
    segments.length > 1 &&
    (BRANCH_TYPE_SEGMENTS.has(segments[0]) || (stripped && segments[0] === ""))
  ) {
    segments.shift();
    stripped = true;
  }
  const key = segments.join("_");
  return PROJECT_KEY.test(key) ? key : null;
}

export function extractIssueKey(branch: string | null | undefined): string | null {
  if (!branch) {
    return null;
  }
  const re = /([A-Z][A-Z0-9_]+)-(\d+)/g;
  const upper = branch.toUpperCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(upper)) !== null) {
    const prefix = stripBranchTypeSegments(match[1]);
    if (prefix !== null && !NON_KEY_PREFIXES.has(prefix)) {
      return `${prefix}-${match[2]}`;
    }
  }
  return null;
}
