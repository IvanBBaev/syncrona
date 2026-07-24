// SPDX-License-Identifier: GPL-3.0-or-later
import path from "node:path";

export type RiskLevel = "low" | "medium" | "high" | "critical";

type MinimalFootprintBudget = {
  maxFiles: number;
  maxLines: number;
  maxObjects: number;
};

type MinimalFootprintMetrics = {
  changedFiles: number;
  changedLines: number;
  changedObjects: number;
};

const DEFAULT_MINIMAL_FOOTPRINT_BUDGET: MinimalFootprintBudget = {
  maxFiles: 5,
  maxLines: 200,
  maxObjects: 10,
};

// Upper bound for a caller-supplied budget. Anything larger is treated as an
// attempt (deliberate or accidental) to disable the minimal-footprint gate.
const MAX_MINIMAL_FOOTPRINT_BUDGET = 10_000;

const BLOCKED_COMMANDS = new Set([
  "rm",
  "sudo",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "killall",
  "pkill",
]);

const BLOCKED_SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish"]);
const BLOCKED_SHELL_TOKENS = ["&&", "||", ";", "|", "`", "$(", ">", "<"];

// CLI subcommands that mutate the connected ServiceNow instance and therefore
// require confirmDestructive when reached through run_workspace_command.
const DESTRUCTIVE_CLI_SUBCOMMANDS = new Set(["push", "deploy", "download"]);
// npm identifiers that resolve to the CLI (see packages/core/package.json).
const CLI_PACKAGE_NAMES = new Set(["syncrona"]);
// Runners that take the package name as their first non-flag argument.
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
// Package managers whose exec-style subcommand is followed by the package name.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "run"]);

// Tools whose mutating-ness is decided per invocation rather than by name.
const ARGS_DEPENDENT_MUTATING_TOOLS = new Set(["run_workspace_command"]);

const MUTATING_TOOLS = new Set([
  "sync_set_scope",
  "sync_set_update_set",
  "sync_prepare_session",
  "sync_push",
  "sn_create_record",
  "sn_execute_background_script",
  "sync_create_script_include",
  "sync_create_script_include_and_sync",
  "sn_update_metadata_record",
  "sn_autonomous_remediation_workflow",
  "sync_unified_change_workflow",
  // Triggers ATF execution via a background script — a side effect on the
  // instance — so it must go through the same preflight/audit/confirm gates.
  "sync_run_atf_tests",
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function hasUnsafeShellArg(args: string[]): boolean {
  return args.some((arg) => arg === "-c" || arg === "--command");
}

function commandBaseName(command: string): string {
  // Strip any leading directory so a path to a blocked binary ("/bin/rm",
  // "..\\rm", "./sudo") is still recognised — an exact-string blocklist alone
  // is trivially bypassed by qualifying the command. Handle both separators
  // regardless of host OS, and drop surrounding whitespace.
  const normalized = command.trim().replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Basename of an executable path, without a Windows launcher extension. */
function normalizeBinaryName(value: string): string {
  const base = path.basename(value.trim().replace(/\\/g, "/")).toLowerCase();
  return base.replace(/\.(cmd|exe|bat|ps1)$/, "");
}

/** Strips a version or dist-tag suffix: `syncrona@1.2.3` -> `syncrona`. */
function packageNameOf(token: string): string {
  const normalized = token.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 ? normalized.slice(0, at) : normalized;
}

function isCliPackageToken(token: string): boolean {
  return CLI_PACKAGE_NAMES.has(packageNameOf(token));
}

/** First token that is not a flag (and not the `--` separator). */
function firstOperand(tokens: string[]): string | null {
  for (const token of tokens) {
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.toLowerCase();
  }
  return null;
}

/**
 * Resolves the CLI subcommand an invocation would actually run, or null when the
 * invocation does not reach the CLI at all. Parsed structurally rather than by
 * free-text substring search: the binary is `syncrona`, so a phrase like
 * "sync push" never occurs in a real invocation and matching it gates nothing.
 */
export function findSyncroCliSubcommand(command: string, args: string[]): string | null {
  const base = normalizeBinaryName(command);
  const tokens = args.map((token) => token.trim()).filter((token) => token.length > 0);

  if (isCliPackageToken(base)) {
    return firstOperand(tokens);
  }

  let rest: string[] | null = null;
  if (PACKAGE_RUNNERS.has(base)) {
    rest = tokens;
  } else if (PACKAGE_MANAGERS.has(base)) {
    const first = firstOperand(tokens);
    if (first && PACKAGE_MANAGER_EXEC_SUBCOMMANDS.has(first)) {
      rest = tokens.slice(tokens.indexOf(first) + 1);
    }
  }
  if (!rest) {
    return null;
  }

  // `npx --package syncrona syncrona push` and `npx -y syncrona push` both reach
  // the CLI: locate the package token, then take the following operand. Scan from
  // the right so a `--package syncrona` value does not shadow the binary token
  // that actually precedes the subcommand.
  let cliIndex = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const token = rest[i];
    if (token !== undefined && isCliPackageToken(token)) {
      cliIndex = i;
      break;
    }
  }
  if (cliIndex < 0) {
    return null;
  }
  return firstOperand(rest.slice(cliIndex + 1));
}

/** True when the invocation runs a CLI subcommand that mutates the instance. */
export function isDestructiveWorkspaceCommand(command: string, args: string[]): boolean {
  const subcommand = findSyncroCliSubcommand(command, args);
  return subcommand !== null && DESTRUCTIVE_CLI_SUBCOMMANDS.has(subcommand);
}

// REV-83 (SEC-2): read-only command allowlist for run_workspace_command.
//
// A base-name *denylist* (BLOCKED_COMMANDS) is the wrong model: every command
// not on it — node, python3, perl, ruby, php, env, find, xargs, timeout, nohup,
// setsid, and any other interpreter or wrapper — is implicitly allowed and can
// run arbitrary code unsandboxed, while the old confirmation gate only fired on
// a literal "syncrona push/deploy/download". Enumerate the known-safe read-only
// commands instead; everything else must be explicitly confirmed.
const READONLY_ALLOWLIST = new Set(["git", "ls", "cat", "pwd", "echo", "syncrona"]);

// SEC-2 (REV-117): git accepts space-separated *values* for its global options
// (`git -C <path> reset`, `git -c a=b commit`, `git --git-dir <dir> push`, …), so a
// mutating verb hidden behind a global option must not slip past the gate. Each of
// these value-taking options consumes the FOLLOWING token as its value; the walk in
// gitRequiresConfirmation skips both so it can resolve the real subcommand.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
]);

// SEC-2 (REV-124): the previous denylist of mutating verbs was unsound two ways.
// (1) A git ALIAS (`git -c alias.x='!sh -c …' x`) runs an arbitrary shell command
// under a subcommand name that is on no denylist, so it was never gated — an RCE.
// (2) The denylist enumerated only a handful of writers, so any mutating verb it did
// not list (switch, pull, branch, worktree, update-ref, filter-branch, gc, prune,
// fetch, submodule, config, …) also slipped through. Invert to an ALLOWLIST of
// unambiguously read-only verbs: anything not on it — every alias and every unlisted
// verb — requires confirmation. Keep it conservative; a verb with a mutating sub-mode
// (reflog, stash, notes, remote, config) is intentionally absent so it confirms.
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "shortlog",
  "describe",
  "blame",
  "annotate",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "rev-parse",
  "rev-list",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "merge-base",
  "cherry",
  "whatchanged",
  "count-objects",
  "verify-commit",
  "verify-tag",
  "var",
  "version",
  "help",
]);

// Inline config injection (`-c core.pager=…`, `-c core.sshCommand=…`, `-c alias.*`,
// `--config-env`) is an arbitrary-code-execution vector regardless of subcommand, so
// it ALWAYS confirms. It only carries that meaning as a MAIN option — BEFORE the
// subcommand — which is exactly the region this walk inspects; the same flag AFTER the
// subcommand (`git diff -c`, a combined-diff format option) is the subcommand's own and
// is not treated as injection. Returns true when the invocation must be confirmed.
function gitRequiresConfirmation(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      // End of options; nothing after this is a subcommand.
      return false;
    }
    if (token.startsWith("-")) {
      if (
        token === "-c" ||
        token === "--config-env" ||
        (token.startsWith("-c") && token.length > 2) ||
        token.startsWith("--config-env=")
      ) {
        return true;
      }
      // A value-taking global option written as a separate token (no attached "=")
      // consumes the following token as its value; skip that value too.
      if (!token.includes("=") && GIT_VALUE_OPTIONS.has(token)) {
        i += 1;
      }
      continue;
    }
    // First real operand = the subcommand. Confirm unless it is a known read-only
    // verb. Aliases are never on the allowlist, so an alias invocation confirms.
    return !GIT_READONLY_SUBCOMMANDS.has(token.toLowerCase());
  }
  // Only global options / no subcommand (`git`, `git --version`): nothing to mutate.
  return false;
}

/**
 * REV-83 (SEC-2): whether a run_workspace_command invocation must be explicitly
 * confirmed (confirmDestructive=true). Default-deny — anything whose base name
 * is not on READONLY_ALLOWLIST requires confirmation, which covers every
 * interpreter and wrapper binary the old denylist missed. Allowlisted commands
 * still confirm for their mutating uses: a `syncrona push/deploy/download`, and
 * (REV-124) any git subcommand that is not a known read-only verb — plus any git
 * inline-config injection, which is an arbitrary-code-execution vector.
 */
export function requiresConfirmation(command: string, args: string[]): boolean {
  const base = normalizeBinaryName(command);
  if (!READONLY_ALLOWLIST.has(base)) {
    return true;
  }
  if (base === "syncrona") {
    return isDestructiveWorkspaceCommand(command, args);
  }
  if (base === "git") {
    return gitRequiresConfirmation(args);
  }
  return false;
}

/** Reads the run_workspace_command argument shape the dispatcher passes through. */
function isDestructiveWorkspaceInvocation(args: Record<string, unknown>): boolean {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return false;
  }
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((item): item is string => typeof item === "string")
    : [];
  return isDestructiveWorkspaceCommand(command, commandArgs);
}

/**
 * Whether a tool call mutates instance state. Most tools are decided by name
 * alone, but run_workspace_command runs whatever it is given — `syncrona push`
 * touches the instance while `npm test` does not — so its answer depends on the
 * invocation. Callers that audit an actual call pass `args` to get that
 * per-invocation answer; callers keyed on the tool name alone (such as the
 * preflight gate, which would otherwise force a live instance round-trip before
 * a purely local command) omit `args` and get the name-only answer.
 */
export function isMutatingTool(toolName: string, args?: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(toolName)) {
    return true;
  }
  if (!args || !ARGS_DEPENDENT_MUTATING_TOOLS.has(toolName)) {
    return false;
  }
  return isDestructiveWorkspaceInvocation(args);
}

export function isUnsafeWorkspaceCommand(command: string, args: string[]): boolean {
  const base = commandBaseName(command);
  if (BLOCKED_COMMANDS.has(base)) {
    return true;
  }

  if (BLOCKED_SHELL_INTERPRETERS.has(base) && hasUnsafeShellArg(args)) {
    return true;
  }

  for (const arg of args) {
    if (BLOCKED_SHELL_TOKENS.some((token) => arg.includes(token))) {
      return true;
    }
  }

  return false;
}

export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 10) {
    return "critical";
  }
  if (score >= 6) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

const RISK_LEVEL_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// SEC-7 (REV-122): compose a caller-supplied risk level with the analyzer-computed
// one, always taking the HIGHER. A caller may RAISE the risk but must never be able
// to LOWER it below what the script analysis warrants.
export function maxRiskLevel(
  ...levels: Array<RiskLevel | null | undefined>
): RiskLevel {
  let best: RiskLevel = "low";
  for (const level of levels) {
    if (level && RISK_LEVEL_RANK[level] > RISK_LEVEL_RANK[best]) {
      best = level;
    }
  }
  return best;
}

export function parseRiskLevel(value: unknown): RiskLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "critical"
  ) {
    return normalized;
  }
  return null;
}

export function getApprovalRequirements(riskLevel: RiskLevel): Record<string, unknown> {
  switch (riskLevel) {
    case "low":
      return {
        required: false,
        minimumApprovers: 0,
        roles: ["peer-review"],
      };
    case "medium":
      return {
        required: true,
        minimumApprovers: 1,
        roles: ["reviewer"],
      };
    case "high":
      return {
        required: true,
        minimumApprovers: 2,
        roles: ["reviewer", "owner"],
      };
    case "critical":
      return {
        required: true,
        minimumApprovers: 2,
        roles: ["owner", "change-manager"],
      };
    default:
      return {
        required: true,
        minimumApprovers: 1,
        roles: ["reviewer"],
      };
  }
}

export function isApprovalSatisfied(
  approval: Record<string, unknown>,
  riskLevel: RiskLevel
): boolean {
  const requirements = asRecord(getApprovalRequirements(riskLevel));
  const required = requirements.required === true;
  if (!required) {
    return true;
  }

  const approvalId = typeof approval.approvalId === "string" ? approval.approvalId.trim() : "";
  if (!approvalId) {
    return false;
  }

  const approvers = Array.isArray(approval.approvers)
    ? approval.approvers.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const minimumApprovers =
    typeof requirements.minimumApprovers === "number" ? requirements.minimumApprovers : 1;
  return approvers.length >= minimumApprovers;
}

export function validateRollbackEvidence(
  evidence: Record<string, unknown>,
  riskLevel: RiskLevel
): { ok: boolean; missing: string[] } {
  const mustHaveReason = riskLevel === "high" || riskLevel === "critical";
  const requiredFields = mustHaveReason
    ? ["reason", "impactedEntities", "revertSteps", "validationPlan"]
    : ["revertSteps"];

  const missing: string[] = [];
  for (const field of requiredFields) {
    const value = evidence[field];
    if (typeof value === "string") {
      if (!value.trim()) {
        missing.push(field);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        missing.push(field);
      }
      continue;
    }
    if (!value) {
      missing.push(field);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function sanitizeBudgetValue(value: unknown, fallback: number): number {
  // A non-finite (Infinity/NaN), negative, or absurdly large override would
  // silently neuter the footprint gate. Fall back to the default for an unusable
  // value and clamp the rest to a sane positive integer ceiling.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_MINIMAL_FOOTPRINT_BUDGET);
}

export function evaluateMinimalFootprint(
  changes: Array<Record<string, unknown>>,
  budgetOverride?: Partial<MinimalFootprintBudget>
): Record<string, unknown> {
  const files = new Set<string>();
  const objects = new Set<string>();
  let lines = 0;

  for (const change of changes) {
    const filePath = typeof change.filePath === "string" ? change.filePath.trim() : "";
    const objectId = typeof change.objectId === "string" ? change.objectId.trim() : "";
    const estimatedLines =
      typeof change.estimatedLines === "number" && Number.isFinite(change.estimatedLines)
        ? Math.max(Math.floor(change.estimatedLines), 0)
        : 0;

    if (filePath) {
      files.add(filePath);
    }
    if (objectId) {
      objects.add(objectId);
    }
    lines += estimatedLines;
  }

  const override = budgetOverride || {};
  const budget: MinimalFootprintBudget = {
    maxFiles: sanitizeBudgetValue(override.maxFiles, DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxFiles),
    maxLines: sanitizeBudgetValue(override.maxLines, DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxLines),
    maxObjects: sanitizeBudgetValue(
      override.maxObjects,
      DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxObjects
    ),
  };
  const metrics: MinimalFootprintMetrics = {
    changedFiles: files.size,
    changedLines: lines,
    changedObjects: objects.size,
  };

  const violations: string[] = [];
  if (metrics.changedFiles > budget.maxFiles) {
    violations.push(`changedFiles exceeds budget (${metrics.changedFiles}/${budget.maxFiles})`);
  }
  if (metrics.changedLines > budget.maxLines) {
    violations.push(`changedLines exceeds budget (${metrics.changedLines}/${budget.maxLines})`);
  }
  if (metrics.changedObjects > budget.maxObjects) {
    violations.push(`changedObjects exceeds budget (${metrics.changedObjects}/${budget.maxObjects})`);
  }

  return {
    metrics,
    budget,
    withinBudget: violations.length === 0,
    violations,
  };
}
