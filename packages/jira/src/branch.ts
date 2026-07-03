// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Extract a Jira issue key (e.g. `ABC-123`) from a git branch name.
 *
 * Pure and trivially unit-testable. Scans for Jira-style keys — a project prefix
 * of an uppercase letter followed by uppercase letters or digits, a hyphen, then
 * the issue number — and returns the *first* one whose prefix is not a well-known
 * non-project token: `feature/ABC-123-do-thing` → `ABC-123`.
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

export function extractIssueKey(branch: string | null | undefined): string | null {
  if (!branch) {
    return null;
  }
  const re = /([A-Z][A-Z0-9]+)-(\d+)/g;
  const upper = branch.toUpperCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(upper)) !== null) {
    const prefix = match[1];
    if (!NON_KEY_PREFIXES.has(prefix)) {
      return `${prefix}-${match[2]}`;
    }
  }
  return null;
}
