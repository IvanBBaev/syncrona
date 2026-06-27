// SPDX-License-Identifier: GPL-3.0-or-later
import { adfToText } from "./adf";
import type {
  JiraComment,
  JiraDeployment,
  JiraIssue,
  JiraIssueLink,
  JiraIssueRef,
} from "./types";

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? (value as RawRecord) : {};
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => asString(item)).filter((item) => item.length > 0);
}

/** Build the public browse URL for an issue from the site base URL. */
function browseUrl(baseUrl: string, key: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/browse/${key}`;
}

/** Display name of a user object, falling back to name/email/accountId. */
function userName(value: unknown): string {
  const user = asRecord(value);
  return (
    asString(user.displayName) ||
    asString(user.name) ||
    asString(user.emailAddress) ||
    ""
  );
}

/** Map a nested issue (parent / subtask / link target) to a JiraIssueRef. */
function toIssueRef(value: unknown): JiraIssueRef | undefined {
  const record = asRecord(value);
  const key = asString(record.key);
  if (!key) {
    return undefined;
  }
  const fields = asRecord(record.fields);
  const ref: JiraIssueRef = { key, summary: asString(fields.summary) };
  const status = asString(asRecord(fields.status).name);
  if (status) {
    ref.status = status;
  }
  const type = asString(asRecord(fields.issuetype).name);
  if (type) {
    ref.type = type;
  }
  return ref;
}

function toIssueLinks(value: unknown): JiraIssueLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const links: JiraIssueLink[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const type = asRecord(record.type);
    const outward = toIssueRef(record.outwardIssue);
    const inward = toIssueRef(record.inwardIssue);
    if (outward) {
      links.push({
        relationship: asString(type.outward) || "relates to",
        issue: outward,
      });
    }
    if (inward) {
      links.push({
        relationship: asString(type.inward) || "relates to",
        issue: inward,
      });
    }
  }
  return links;
}

function toComments(value: unknown, limit: number): JiraComment[] {
  const container = asRecord(value);
  const raw = Array.isArray(container.comments) ? container.comments : [];
  // Most-recent N comments, preserving chronological order in the slice.
  const recent = limit > 0 ? raw.slice(-limit) : [];
  return recent.map((entry) => {
    const record = asRecord(entry);
    const comment: JiraComment = {
      author: userName(record.author),
      created: asString(record.created),
      body: adfToText(record.body),
    };
    const updated = asString(record.updated);
    if (updated) {
      comment.updated = updated;
    }
    return comment;
  });
}

/**
 * Map a raw Jira REST issue payload to the normalized {@link JiraIssue}. Handles
 * both Cloud (ADF bodies) and Server/DC (string bodies) shapes — the ADF
 * converter passes strings through. `commentLimit` caps the most-recent comments.
 */
export function normalizeIssue(
  raw: unknown,
  deployment: JiraDeployment,
  baseUrl: string,
  commentLimit = 5
): JiraIssue {
  const record = asRecord(raw);
  const key = asString(record.key);
  const fields = asRecord(record.fields);
  const status = asRecord(fields.status);

  const components = Array.isArray(fields.components)
    ? fields.components
        .map((item) => asString(asRecord(item).name))
        .filter((item) => item.length > 0)
    : [];
  const fixVersions = Array.isArray(fields.fixVersions)
    ? fields.fixVersions
        .map((item) => asString(asRecord(item).name))
        .filter((item) => item.length > 0)
    : [];
  const subtasks = Array.isArray(fields.subtasks)
    ? fields.subtasks
        .map((item) => toIssueRef(item))
        .filter((item): item is JiraIssueRef => item !== undefined)
    : [];

  const issue: JiraIssue = {
    key,
    url: browseUrl(baseUrl, key),
    summary: asString(fields.summary),
    description: adfToText(fields.description),
    status: asString(status.name),
    statusCategory: asString(asRecord(status.statusCategory).key),
    type: asString(asRecord(fields.issuetype).name),
    priority: asString(asRecord(fields.priority).name),
    assignee: userName(fields.assignee),
    reporter: userName(fields.reporter),
    labels: asStringArray(fields.labels),
    components,
    subtasks,
    links: toIssueLinks(fields.issuelinks),
    fixVersions,
    created: asString(fields.created),
    updated: asString(fields.updated),
    comments: toComments(fields.comment, commentLimit),
  };

  const parent = toIssueRef(fields.parent);
  if (parent) {
    issue.parent = parent;
  }

  // `deployment` is kept in the signature for symmetry and future per-deployment
  // mapping; today the ADF converter handles both Cloud and Server bodies, so no
  // branch is needed here.
  void deployment;

  return issue;
}
