// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared Jira types for SyncroNow AI. Co-located in this package (rather than in
 * `@syncro-now-ai/types`) so the Jira client stays self-contained — only the CLI
 * and the MCP server consume it, and both already depend on this package.
 */

/**
 * Jira deployment flavour. Cloud (`*.atlassian.net`) and Server/Data Center
 * differ in REST API version and auth scheme; see `deployment.ts`.
 */
export type JiraDeployment = "cloud" | "server";

/** Resolved connection config for a single Jira site/profile. */
export type JiraConfig = {
  /** Base site URL without a trailing slash, e.g. `https://acme.atlassian.net`. */
  baseUrl: string;
  deployment: JiraDeployment;
  /** Account email — Cloud only (used as the Basic-auth username). */
  email?: string;
  /** API token (Cloud) or personal access token (Server/DC). */
  token: string;
};

/** A named reference to another issue (parent, subtask, or link target). */
export type JiraIssueRef = {
  key: string;
  summary: string;
  status?: string;
  type?: string;
};

/** A single linked-issue relationship (e.g. "blocks", "is blocked by"). */
export type JiraIssueLink = {
  /** Human-readable relationship from this issue's perspective. */
  relationship: string;
  issue: JiraIssueRef;
};

/** A single comment, with its body already flattened to plain text. */
export type JiraComment = {
  author: string;
  created: string;
  updated?: string;
  body: string;
};

/** Normalized, surface-agnostic view of a Jira issue. */
export type JiraIssue = {
  key: string;
  /** Browse URL for humans, e.g. `https://acme.atlassian.net/browse/ABC-1`. */
  url: string;
  summary: string;
  /** Description flattened to plain text (ADF on Cloud, wiki/text on Server). */
  description: string;
  status: string;
  /** Status category key: `new` | `indeterminate` | `done` (when available). */
  statusCategory: string;
  type: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];
  components: string[];
  parent?: JiraIssueRef;
  subtasks: JiraIssueRef[];
  links: JiraIssueLink[];
  fixVersions: string[];
  created: string;
  updated: string;
  comments: JiraComment[];
};

/** Options for a single issue lookup. */
export type GetIssueOptions = {
  /** Maximum number of most-recent comments to include (default 5). */
  comments?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
};
