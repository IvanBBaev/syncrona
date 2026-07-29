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

/**
 * "Nothing configured", worded for the path the caller actually took.
 *
 * REV-203: {@link NO_JIRA_CONFIG_MESSAGE} is only actionable on the default path.
 * REV-130 made an *explicit* `--profile` the exclusive source — `configFromEnv` is
 * never consulted for it (resolveConfig.ts:73-85) — so telling someone who ran
 * `syncrona jira --profile prod` to "set JIRA_BASE_URL and JIRA_TOKEN" is advice that
 * provably cannot work: they export the variables, re-run, and get the identical
 * error. The un-suffixed `jira-login` half is wrong for the same reason — it writes
 * the `default` profile, not `prod`, so it also leaves the failure in place. Both
 * halves of the only remediation offered were dead ends, which reads as a broken
 * tool rather than as a missing login.
 */
export function noJiraConfigMessage(explicitProfile?: string): string {
  const profile = (explicitProfile || "").trim();
  if (!profile) {
    return NO_JIRA_CONFIG_MESSAGE;
  }
  return (
    `No Jira credentials stored for profile "${profile}". ` +
    `Run \`syncrona jira-login --profile ${profile}\`. ` +
    `JIRA_BASE_URL / JIRA_TOKEN are deliberately ignored when \`--profile\` is given, ` +
    `so an explicit profile is never served from the environment — drop \`--profile\` to use those.`
  );
}

/**
 * The 401 next step, worded for the source the credentials actually came from.
 *
 * REV-203, one step later than {@link noJiraConfigMessage}: by the time a request
 * 401s a config *was* resolved, and on the explicit-profile path it came from the
 * credential store. "Verify JIRA_EMAIL / JIRA_TOKEN" then sends the user to inspect
 * environment variables that had no bearing on the request that failed — and if they
 * happen to be set and correct, to conclude the tool is lying to them.
 */
export function jiraAuthRecheckHint(explicitProfile?: string): string {
  const profile = (explicitProfile || "").trim();
  if (!profile) {
    return "Hint: re-check your Jira credentials with `syncrona jira-login`, or verify JIRA_EMAIL / JIRA_TOKEN.";
  }
  return (
    `Hint: the credentials came from the stored profile "${profile}", not the environment — ` +
    `re-check them with \`syncrona jira-login --profile ${profile}\`.`
  );
}
