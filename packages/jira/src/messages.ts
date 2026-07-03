// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical user-facing strings shared across the Jira surfaces (core CLI and the
 * MCP server), so the same guidance never drifts between them. The CLI and the
 * MCP handler both import these instead of hard-coding their own copies.
 */

/** Shown when no Jira config (environment or stored credentials) can be resolved. */
export const NO_JIRA_CONFIG_MESSAGE =
  "No Jira credentials configured. Run `syncrona jira-login`, or set JIRA_BASE_URL and JIRA_TOKEN.";

/**
 * Shown when a Jira *Cloud* site is targeted with a token but no account email.
 * Cloud Basic auth is `email:api-token`; with an empty email the header is
 * `base64(":token")`, which Atlassian always rejects with a 401 — so we fail
 * early with this message instead of emitting a header guaranteed to 401 and
 * then misdiagnosing it as "bad credentials". Server/Data Center uses a Bearer
 * token and needs no email, so this only applies to Cloud.
 */
export const CLOUD_MISSING_EMAIL_MESSAGE =
  "Jira Cloud requires an account email for authentication. Set JIRA_EMAIL (the address that owns the API token), " +
  "or run `syncrona jira-login` and provide the email.";

/**
 * Shown when a stored Jira profile *exists* but cannot be decrypted — almost
 * always because it was encrypted on a different machine or user account (the
 * store key is machine-derived). Distinct from {@link NO_JIRA_CONFIG_MESSAGE} so
 * the user fixes the right thing (re-login) instead of assuming nothing is set up.
 */
export function jiraUndecryptableMessage(profile: string): string {
  return (
    `Stored Jira credentials for profile "${profile}" could not be decrypted — ` +
    `they were likely encrypted on a different machine or user account. ` +
    `Re-run \`syncrona jira-login --profile ${profile}\`.`
  );
}
