// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "child_process";
import {
  extractIssueKey,
  getIssue,
  resolveJiraConfigSync,
  NO_JIRA_CONFIG_MESSAGE,
} from "@syncro-now-ai/jira";
import { toJsonText } from "../runtimeUtils";
import type { ToolResponse } from "../toolResponse";

type JiraToolContext = {
  timeoutMs: number;
  /** Project root the MCP server is bound to — git fallback runs against it. */
  projectDir: string;
};

function textResponse(payload: unknown, isError = false): ToolResponse {
  return {
    isError,
    content: [{ type: "text", text: toJsonText(payload) }],
  };
}

function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/** Current git branch in the project dir, or null when unavailable. */
function currentBranch(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim();
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
    return errorResponse(NO_JIRA_CONFIG_MESSAGE);
  }

  let key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) {
    const branch = currentBranch(context.projectDir);
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
    return textResponse(issue);
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
