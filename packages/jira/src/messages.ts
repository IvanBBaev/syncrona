// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical user-facing strings shared across the Jira surfaces (core CLI and the
 * MCP server), so the same guidance never drifts between them. The CLI and the
 * MCP handler both import these instead of hard-coding their own copies.
 */

/** Shown when no Jira config (environment or stored credentials) can be resolved. */
export const NO_JIRA_CONFIG_MESSAGE =
  "No Jira credentials configured. Run `syncro-now-ai jira-login`, or set JIRA_BASE_URL and JIRA_TOKEN.";
