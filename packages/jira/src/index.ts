// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @syncro-now-ai/jira — shared Jira read client.
 *
 * Single source of truth for Jira awareness across SyncroNow AI: the core CLI
 * (`jira` / `jira-login` / `jira-logout` commands) and the MCP server
 * (`jira_get_issue` tool) both consume this package so the auth model, deployment
 * detection, REST shape, and issue normalization never drift between surfaces.
 */
export * from "./types";
export { extractIssueKey } from "./branch";
export { detectDeployment, restApiBase } from "./deployment";
export { adfToText } from "./adf";
export { normalizeIssue } from "./normalize";
export { getIssue, verifyAuth, buildAuthHeader } from "./client";
export { resolveJiraConfig, resolveJiraConfigSync } from "./resolveConfig";
