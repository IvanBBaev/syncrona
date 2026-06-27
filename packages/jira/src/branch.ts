// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Extract a Jira issue key (e.g. `ABC-123`) from a git branch name.
 *
 * Pure and trivially unit-testable. Matches the first occurrence of a Jira-style
 * key: a project prefix of an uppercase letter followed by uppercase letters or
 * digits, a hyphen, then the issue number — `feature/ABC-123-do-thing` → `ABC-123`.
 *
 * Returns null when no key is present. The input is upper-cased first so a
 * lowercase branch (`feature/abc-123`) still resolves; Jira keys are always
 * stored/queried in uppercase.
 */
export function extractIssueKey(branch: string | null | undefined): string | null {
  if (!branch) {
    return null;
  }
  const match = /([A-Z][A-Z0-9]+-\d+)/.exec(branch.toUpperCase());
  return match ? match[1] : null;
}
