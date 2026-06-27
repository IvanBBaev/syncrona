// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncro-now-ai/types";
import inquirer from "inquirer";
import {
  detectDeployment,
  extractIssueKey,
  getIssue,
  resolveJiraConfig,
  verifyAuth,
  NO_JIRA_CONFIG_MESSAGE,
  type JiraComment,
  type JiraDeployment,
  type JiraIssue,
} from "@syncro-now-ai/jira";
import {
  saveJiraCredentials,
  removeJiraCredentials,
  removeAllJiraCredentials,
} from "@syncro-now-ai/credential-store";
import { logger } from "./Logger";
import { getCurrentBranch } from "./gitUtils";
import { setLogLevel } from "./commandHelpers";

const DEFAULT_COMMENT_LIMIT = 5;

/** Print one labelled line, but only when the value is non-empty. */
function field(label: string, value: string): void {
  if (value && value.trim().length > 0) {
    logger.info(`${label}: ${value}`);
  }
}

/** Indent a (possibly multi-line) block under a header for readability. */
function block(text: string): void {
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    logger.info(`  ${ln}`);
  }
}

function formatComment(comment: JiraComment): string {
  const when = comment.updated || comment.created;
  const header = [comment.author || "unknown", when].filter(Boolean).join(" — ");
  return `${header}\n${comment.body}`.trimEnd();
}

/**
 * Emit a Jira-tailored, actionable next step after a failed request. The shared
 * ServiceNow error taxonomy (`logErrorHint`) gives ServiceNow-specific advice
 * (`syncro-now-ai login`, `SN_INSTANCE`) that would mislead here, so the `jira`
 * commands classify their own errors and point at the Jira equivalents.
 */
function logJiraErrorHint(message: string): void {
  if (/HTTP 401|HTTP 403|authentication failed/i.test(message)) {
    logger.info(
      "Hint: re-check your Jira credentials with `syncro-now-ai jira-login`, or verify JIRA_EMAIL / JIRA_TOKEN."
    );
  } else if (/HTTP 404|not found/i.test(message)) {
    logger.info("Hint: verify the issue key and that your account can view it.");
  } else if (/timed out|timeout/i.test(message)) {
    logger.info(
      "Hint: the request timed out — check your network/VPN and the Jira base URL, then retry."
    );
  } else {
    logger.info("Hint: re-run with `--log-level debug` for more detail.");
  }
}

/** Human-readable rich rendering of a normalized issue. */
function printIssue(issue: JiraIssue): void {
  logger.success(`${issue.key}  ${issue.summary}`.trim());
  field("URL", issue.url);
  field("Type", issue.type);
  const statusLine = issue.statusCategory
    ? `${issue.status} (${issue.statusCategory})`
    : issue.status;
  field("Status", statusLine);
  field("Priority", issue.priority);
  field("Assignee", issue.assignee);
  field("Reporter", issue.reporter);
  field("Labels", issue.labels.join(", "));
  field("Components", issue.components.join(", "));
  field("Fix versions", issue.fixVersions.join(", "));
  field("Created", issue.created);
  field("Updated", issue.updated);

  if (issue.parent) {
    field("Parent", `${issue.parent.key} ${issue.parent.summary}`.trim());
  }

  if (issue.subtasks.length > 0) {
    logger.info("Subtasks:");
    for (const sub of issue.subtasks) {
      const status = sub.status ? ` [${sub.status}]` : "";
      block(`${sub.key} ${sub.summary}${status}`.trim());
    }
  }

  if (issue.links.length > 0) {
    logger.info("Linked issues:");
    for (const link of issue.links) {
      block(`${link.relationship}: ${link.issue.key} ${link.issue.summary}`.trim());
    }
  }

  if (issue.description && issue.description.trim().length > 0) {
    logger.info("Description:");
    block(issue.description);
  }

  if (issue.comments.length > 0) {
    logger.info(`Comments (${issue.comments.length}):`);
    for (const comment of issue.comments) {
      block(formatComment(comment));
    }
  }
}

/** Resolve the issue key from an explicit arg, falling back to the git branch. */
async function resolveIssueKey(explicit?: string): Promise<string | null> {
  const fromArg = (explicit || "").trim();
  if (fromArg) {
    return fromArg.toUpperCase();
  }
  const branch = await getCurrentBranch();
  if (!branch) {
    return null;
  }
  return extractIssueKey(branch);
}

export async function jiraCommand(
  args: Sync.SharedCmdArgs & {
    key?: string;
    profile?: string;
    comments?: number;
    json?: boolean;
  }
): Promise<void> {
  setLogLevel(args);

  const key = await resolveIssueKey(args.key);
  if (!key) {
    logger.error(
      "No Jira issue key given and none could be inferred from the current git branch."
    );
    logger.info("Pass a key explicitly, e.g. `syncro-now-ai jira PROJ-123`.");
    process.exitCode = 1;
    return;
  }

  const config = await resolveJiraConfig({ profile: args.profile });
  if (!config) {
    logger.error(NO_JIRA_CONFIG_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const comments =
    typeof args.comments === "number" && args.comments >= 0
      ? Math.floor(args.comments)
      : DEFAULT_COMMENT_LIMIT;

  let issue: JiraIssue;
  try {
    issue = await getIssue(config, key, { comments });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message);
    logJiraErrorHint(message);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    // Raw, pipe-friendly JSON (no log coloring) for scripting and AI consumption.
    process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }

  printIssue(issue);
}

export async function jiraLoginCommand(
  args: Sync.SharedCmdArgs & { profile?: string }
): Promise<void> {
  setLogLevel(args);

  const profile = (args.profile || "").trim() || "default";

  const { baseUrlRaw } = await inquirer.prompt<{ baseUrlRaw: string }>([
    {
      type: "input",
      name: "baseUrlRaw",
      message: "Jira base URL (e.g. https://your-org.atlassian.net):",
      validate: (v: string) =>
        v.trim().length > 0 ? true : "Base URL is required.",
    },
  ]);
  const baseUrl = baseUrlRaw.trim().replace(/\/$/, "");

  const detected = detectDeployment(baseUrl);
  const { deployment } = await inquirer.prompt<{ deployment: JiraDeployment }>([
    {
      type: "list",
      name: "deployment",
      message: "Deployment type:",
      choices: [
        { name: "Jira Cloud (atlassian.net) — email + API token", value: "cloud" },
        { name: "Jira Server / Data Center — personal access token", value: "server" },
      ],
      default: detected,
    },
  ]);

  let email = "";
  if (deployment === "cloud") {
    const answer = await inquirer.prompt<{ email: string }>([
      {
        type: "input",
        name: "email",
        message: "Atlassian account email:",
        validate: (v: string) =>
          v.trim().length > 0 ? true : "Email is required for Jira Cloud.",
      },
    ]);
    email = answer.email.trim();
  }

  const tokenPrompt =
    deployment === "cloud" ? "API token:" : "Personal access token:";
  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: "password",
      name: "token",
      message: tokenPrompt,
      mask: "*",
      validate: (v: string) => (v.trim().length > 0 ? true : "Token is required."),
    },
  ]);

  // Do not trim the token — surrounding whitespace can be significant.
  const config = {
    baseUrl,
    deployment,
    token,
    ...(email ? { email } : {}),
  };

  logger.info(`Verifying credentials against ${baseUrl}...`);
  let who: string;
  try {
    who = await verifyAuth(config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`Could not authenticate to Jira: ${message}`);
    logJiraErrorHint(message);
    process.exitCode = 1;
    return;
  }

  await saveJiraCredentials({
    profile,
    baseUrl,
    deployment,
    token,
    ...(email ? { email } : {}),
  });

  logger.success(
    `Authenticated as ${who}. Saved Jira credentials under profile "${profile}".`
  );
}

export async function jiraLogoutCommand(
  args: Sync.SharedCmdArgs & { profile?: string; all?: boolean }
): Promise<void> {
  setLogLevel(args);

  if (args.all) {
    const count = await removeAllJiraCredentials();
    logger.success(`Removed Jira credentials for ${count} profile(s).`);
    return;
  }

  const profile = (args.profile || "").trim() || "default";
  await removeJiraCredentials(profile);
  logger.success(`Removed Jira credentials for profile "${profile}".`);
}
