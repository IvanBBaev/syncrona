// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "child_process";
import { promisify } from "util";
import {
  extractIssueKey,
  getIssue,
  resolveJiraConfigSync,
  jiraUndecryptableMessage,
  noJiraConfigMessage,
} from "@syncrona/jira";
import { jiraCredentialHealth } from "@syncrona/credential-store";
import { toJsonText, wrapUntrustedData } from "../runtimeUtils";
import type { ToolResponse } from "../toolResponse";

const execFileAsync = promisify(execFile);

type JiraToolContext = {
  timeoutMs: number;
  /** Project root the MCP server is bound to — git fallback runs against it. */
  projectDir: string;
};

function textResponse(payload: unknown, isError = false): ToolResponse {
  const text = toJsonText(payload);
  const response: ToolResponse = {
    isError,
    content: [{ type: "text", text }],
  };
  // Mirror plain-object success payloads into MCP structuredContent, re-parsed
  // from the serialized text so both views stay identical (see insightShared).
  if (!isError && payload && typeof payload === "object" && !Array.isArray(payload)) {
    response.structuredContent = JSON.parse(text) as Record<string, unknown>;
  }
  return response;
}

function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * REV-158: fence EVERY third-party-authored free-text field of a Jira issue as
 * untrusted before it reaches the LLM. The old fence covered only summary,
 * description and comment bodies, which left four channels of exactly the same
 * provenance wide open: `comments[].author` (a display name the commenter sets),
 * `parent.summary`, `subtasks[].summary` and `links[].issue.summary` (prose from
 * OTHER issues, pulled in automatically — an attacker who cannot touch this issue
 * only has to link one of their own to it). Because the same server exposes
 * code-execution tools, an unfenced field is an indirect-prompt-injection entry
 * point; a partial fence is worse than none, since it advertises which fields are
 * safe to trust.
 *
 * Structural/metadata fields (key, status, labels, link relationship) are left
 * untouched. Honest limit: the issue-level `assignee`/`reporter` display names are
 * still passed through verbatim — they are documented as structural and pinned by
 * the handler contract test, so widening the fence there is a deliberate follow-up
 * rather than a silent change here. Non-object input is returned as-is.
 */
function frameRefUntrusted(ref: unknown): unknown {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return ref;
  }
  const record = ref as Record<string, unknown>;
  if (!("summary" in record)) {
    return ref;
  }
  return { ...record, summary: wrapUntrustedData(record.summary, "jira") };
}

function frameIssueUntrusted(issue: unknown): unknown {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    return issue;
  }
  const record = issue as Record<string, unknown>;
  const framed: Record<string, unknown> = { ...record };
  if ("summary" in framed) {
    framed.summary = wrapUntrustedData(framed.summary, "jira");
  }
  if ("description" in framed) {
    framed.description = wrapUntrustedData(framed.description, "jira");
  }
  if (Array.isArray(framed.comments)) {
    framed.comments = framed.comments.map((comment) => {
      if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
        return comment;
      }
      const commentRecord = comment as Record<string, unknown>;
      const framedComment: Record<string, unknown> = { ...commentRecord };
      if ("body" in framedComment) {
        framedComment.body = wrapUntrustedData(framedComment.body, "jira");
      }
      if ("author" in framedComment) {
        framedComment.author = wrapUntrustedData(framedComment.author, "jira");
      }
      return framedComment;
    });
  }
  if ("parent" in framed) {
    framed.parent = frameRefUntrusted(framed.parent);
  }
  if (Array.isArray(framed.subtasks)) {
    framed.subtasks = framed.subtasks.map((subtask) => frameRefUntrusted(subtask));
  }
  if (Array.isArray(framed.links)) {
    framed.links = framed.links.map((link) => {
      if (!link || typeof link !== "object" || Array.isArray(link)) {
        return link;
      }
      const linkRecord = link as Record<string, unknown>;
      if (!("issue" in linkRecord)) {
        return link;
      }
      return { ...linkRecord, issue: frameRefUntrusted(linkRecord.issue) };
    });
  }
  return framed;
}

/**
 * Current git branch in the project dir, or null when unavailable. Async so the
 * git subprocess never blocks the MCP server's event loop while a request is in
 * flight (the handler is already awaited end to end).
 */
async function currentBranch(
  projectDir: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      // Bound the subprocess: a hung git (network filesystem, stuck index lock)
      // must not leave the awaited handler blocked indefinitely. On timeout
      // execFile kills git and rejects, which the catch below maps to null.
      { cwd: projectDir, encoding: "utf8", timeout: Math.max(1, timeoutMs) }
    );
    const out = stdout.trim();
    // Detached HEAD reports the literal "HEAD" — no branch name to mine.
    if (!out || out === "HEAD") {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

async function handleGetIssue(
  args: Record<string, unknown>,
  context: JiraToolContext
): Promise<ToolResponse> {
  const profile = typeof args.profile === "string" ? args.profile.trim() : "";
  const config = resolveJiraConfigSync({ profile });
  if (!config) {
    // Mirror the CLI: a stored profile that exists but won't decrypt (creds moved
    // between machines/users) must point at re-login, not claim nothing is set up.
    const healthProfile = profile || "default";
    if (jiraCredentialHealth(healthProfile) === "undecryptable") {
      return errorResponse(jiraUndecryptableMessage(healthProfile));
    }
    // REV-203: an agent reading this error acts on it literally, so advice that cannot
    // work is worse here than on the CLI — it will set JIRA_BASE_URL/JIRA_TOKEN, retry,
    // get the same error, and have no way to discover that an explicit profile ignores
    // them by design (REV-130).
    return errorResponse(noJiraConfigMessage(profile));
  }

  let key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) {
    const branch = await currentBranch(context.projectDir, context.timeoutMs);
    const inferred = branch ? extractIssueKey(branch) : null;
    if (!inferred) {
      return errorResponse(
        "No Jira issue key provided and none could be inferred from the current git branch."
      );
    }
    key = inferred;
  }

  const comments =
    typeof args.comments === "number" && args.comments >= 0
      ? Math.floor(args.comments)
      : undefined;

  try {
    const issue = await getIssue(config, key, {
      comments,
      timeoutMs: context.timeoutMs,
    });
    return textResponse(frameIssueUntrusted(issue));
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
}

export async function handleJiraTool(
  toolName: string,
  args: Record<string, unknown>,
  context: JiraToolContext
): Promise<ToolResponse | null> {
  switch (toolName) {
    case "jira_get_issue":
      return handleGetIssue(args, context);
    default:
      return null;
  }
}
