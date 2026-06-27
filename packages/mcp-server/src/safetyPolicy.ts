// SPDX-License-Identifier: GPL-3.0-or-later
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

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
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
