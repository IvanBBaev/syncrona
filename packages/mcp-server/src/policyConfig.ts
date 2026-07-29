// SPDX-License-Identifier: GPL-3.0-or-later
import { logger } from "./logger";
import { toolImplementsDryRun } from "./safetyPolicy";

type ToolPolicy = {
  deny?: boolean;
  requireDryRun?: boolean;
  requireConfirmDestructive?: boolean;
  requirePreflight?: boolean;
};

type EnvironmentPolicy = {
  allowTools?: string[];
  denyTools?: string[];
  enforcePreflightForMutations?: boolean;
  allowFullNodeAccess?: boolean;
};

type GuardrailPolicy = {
  activeEnvironment: string;
  environments: Record<string, EnvironmentPolicy>;
  tools: Record<string, ToolPolicy>;
};

export type GuardrailConfig = {
  enforcePreflightForMutations: boolean;
  expectedScope: string;
  expectedUpdateSetName: string;
  expectedUpdateSetSysId: string;
  allowFullNodeAccess: boolean;
  policy: GuardrailPolicy;
  // SEC-3 (REV-84) fail-closed marker. Set to `true` ONLY when the guardrail
  // config could not be trusted (unreadable file, or a malformed field such as a
  // non-array allowTools). When set, evaluateToolPolicy denies every tool and
  // getEffectiveAllowFullNodeAccess returns false. The field is left ABSENT on a
  // healthy parse so a clean config still deep-equals DEFAULT_GUARDRAIL_CONFIG.
  invalid?: boolean;
  invalidReason?: string;
};

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  enforcePreflightForMutations: false,
  expectedScope: "",
  expectedUpdateSetName: "",
  expectedUpdateSetSysId: "",
  allowFullNodeAccess: false,
  policy: {
    activeEnvironment: "default",
    environments: {},
    tools: {},
  },
};

// SEC-3 (REV-84): freeze the shared default so no caller can mutate its nested
// `policy` object through an aliased reference. Fallback paths must hand out a
// deep clone (cloneDefaultGuardrailConfig) rather than a shallow spread that
// shares `policy` / `policy.environments` with every other caller.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}

deepFreeze(DEFAULT_GUARDRAIL_CONFIG);

// SEC-4 (REV-119): keys that would poison the prototype chain when used as a
// bracket-assignment target on a plain object. A guardrail config that names an
// environment or tool with one of these is rejected (fail closed) rather than
// silently dropped — a dropped env would fall back to permissive top-level settings.
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep, mutable clone of the permissive default (never the shared frozen instance). */
export function cloneDefaultGuardrailConfig(): GuardrailConfig {
  return structuredClone(DEFAULT_GUARDRAIL_CONFIG);
}

/**
 * SEC-3 (REV-84): build a fail-closed guardrail config. Field values mirror the
 * default (so callers that only read scalar fields keep working), but the
 * `invalid` marker makes evaluateToolPolicy deny every tool.
 */
export function createInvalidGuardrailConfig(reason: string): GuardrailConfig {
  const config = cloneDefaultGuardrailConfig();
  config.invalid = true;
  config.invalidReason = reason;
  return config;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * A node that is present but is not a plain object (array, string, number, boolean) —
 * i.e. an authoring error. `null`/`undefined` mean "absent" and keep their meaning.
 */
function isMalformedConfigNode(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "object" || Array.isArray(value))
  );
}

export function parseGuardrailConfig(value: unknown): GuardrailConfig {
  // SEC-3 follow-up (REV-118): a top-level guardrail config that is a JSON array,
  // string, number or boolean is a malformed file, not "no restrictions". asRecord()
  // would coerce it to {} and hand back the permissive default. Fail closed. (null and
  // undefined keep their existing meaning: the permissive default.)
  if (isMalformedConfigNode(value)) {
    return createInvalidGuardrailConfig("guardrail config root is not an object");
  }

  const parsed = asRecord(value);
  // SEC-3 follow-up (REV-148): the same coercion the root check was added to stop was
  // still applied one level down. `policy`, `policy.tools` and `policy.environments` went
  // straight through asRecord(), which turns ANY non-object into `{}` — so
  // `"policy": "strict"` or `"tools": ["sn_execute_script"]` parsed as "no tool policies
  // and no environments", i.e. the fully permissive default. A malformed guardrail file
  // silently DISABLED the guardrails, which is the exact inversion the fail-closed marker
  // exists to prevent. Every sibling branch here (root, allowTools, denyTools) already
  // rejects its own malformed shape; these three did not.
  if (isMalformedConfigNode(parsed.policy)) {
    return createInvalidGuardrailConfig("guardrail config policy is not an object");
  }

  const policyRaw = asRecord(parsed.policy);
  if (isMalformedConfigNode(policyRaw.tools)) {
    return createInvalidGuardrailConfig("guardrail config policy.tools is not an object");
  }
  if (isMalformedConfigNode(policyRaw.environments)) {
    return createInvalidGuardrailConfig(
      "guardrail config policy.environments is not an object"
    );
  }

  const toolsRaw = asRecord(policyRaw.tools);
  const envsRaw = asRecord(policyRaw.environments);

  const tools: Record<string, ToolPolicy> = {};
  let malformedReason: string | undefined;
  for (const [toolName, rawPolicy] of Object.entries(toolsRaw)) {
    if (FORBIDDEN_CONFIG_KEYS.has(toolName)) {
      malformedReason =
        malformedReason ?? `tool policy uses a forbidden key "${toolName}"`;
      continue;
    }
    // SEC-3 follow-up (REV-192): the REV-148 guard stopped the fail-open coercion at
    // `policy`, `policy.tools` and `policy.environments`, but each ENTRY value was still
    // handed to asRecord(), which turns a string/number/array into `{}` — so a shorthand
    // like `"tools": {"sync_push": "deny"}` parsed as a tool policy with every flag off,
    // i.e. the permissive default, exactly the inversion the marker exists to prevent.
    // (`null` still means "absent" and keeps its all-false meaning.)
    if (isMalformedConfigNode(rawPolicy)) {
      malformedReason =
        malformedReason ?? `tool policy "${toolName}" is not an object`;
    }
    const rule = asRecord(rawPolicy);
    tools[toolName] = {
      deny: rule.deny === true,
      requireDryRun: rule.requireDryRun === true,
      requireConfirmDestructive: rule.requireConfirmDestructive === true,
      requirePreflight: rule.requirePreflight === true,
    };
  }

  const environments: Record<string, EnvironmentPolicy> = {};
  for (const [envName, rawEnvPolicy] of Object.entries(envsRaw)) {
    if (FORBIDDEN_CONFIG_KEYS.has(envName)) {
      malformedReason =
        malformedReason ?? `environment uses a forbidden key "${envName}"`;
      continue;
    }
    // SEC-3 follow-up (REV-192): same fail-open coercion one level down — an environment
    // written as `"prod": "strict"` became an empty EnvironmentPolicy, silently dropping
    // every allow/deny rule while still counting as a defined environment (so the
    // unknown-environment gate did not catch it either).
    if (isMalformedConfigNode(rawEnvPolicy)) {
      malformedReason =
        malformedReason ?? `environment "${envName}" is not an object`;
    }
    const envRule = asRecord(rawEnvPolicy);
    // SEC-3 (REV-84): a present-but-non-array allowTools must NOT silently
    // normalize to [] — evaluateToolPolicy reads an empty allow-list as "no
    // restriction = allow everything", so a typo like `"allowTools": "deploy"`
    // would disable the whole allow-list. Treat it as a config authoring error
    // and fail closed (marker below) instead of quietly widening access.
    if (
      Object.prototype.hasOwnProperty.call(envRule, "allowTools") &&
      !Array.isArray(envRule.allowTools)
    ) {
      malformedReason =
        malformedReason ?? `environment "${envName}" has a non-array allowTools`;
    }
    // SEC-3 follow-up (REV-118): a present-but-non-array denyTools is the same
    // authoring error as a non-array allowTools — it would silently normalize to []
    // and deny nothing. Fail closed via the marker instead.
    if (
      Object.prototype.hasOwnProperty.call(envRule, "denyTools") &&
      !Array.isArray(envRule.denyTools)
    ) {
      malformedReason =
        malformedReason ?? `environment "${envName}" has a non-array denyTools`;
    }
    environments[envName] = {
      allowTools: normalizeStringArray(envRule.allowTools),
      denyTools: normalizeStringArray(envRule.denyTools),
      enforcePreflightForMutations: envRule.enforcePreflightForMutations === true,
      allowFullNodeAccess: envRule.allowFullNodeAccess === true,
    };
  }

  const config: GuardrailConfig = {
    enforcePreflightForMutations: parsed.enforcePreflightForMutations === true,
    expectedScope: typeof parsed.expectedScope === "string" ? parsed.expectedScope.trim() : "",
    expectedUpdateSetName:
      typeof parsed.expectedUpdateSetName === "string" ? parsed.expectedUpdateSetName.trim() : "",
    expectedUpdateSetSysId:
      typeof parsed.expectedUpdateSetSysId === "string" ? parsed.expectedUpdateSetSysId.trim() : "",
    allowFullNodeAccess: parsed.allowFullNodeAccess === true,
    policy: {
      activeEnvironment:
        typeof policyRaw.activeEnvironment === "string" && policyRaw.activeEnvironment.trim().length > 0
          ? policyRaw.activeEnvironment.trim()
          : "default",
      environments,
      tools,
    },
  };

  // Only attach the marker when actually malformed, so a healthy parse (and
  // parseGuardrailConfig({}) in particular) still deep-equals DEFAULT_GUARDRAIL_CONFIG.
  if (malformedReason) {
    config.invalid = true;
    config.invalidReason = malformedReason;
  }

  return config;
}

export function getActiveEnvironmentName(config: GuardrailConfig): string {
  const fromEnv = typeof process.env.SYNCRONA_ENV === "string" ? process.env.SYNCRONA_ENV.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  return config.policy.activeEnvironment || "default";
}

export function getEnvironmentPolicy(config: GuardrailConfig): EnvironmentPolicy {
  const envName = getActiveEnvironmentName(config);
  return config.policy.environments[envName] || {};
}

/**
 * SEC-4 (REV-85): true when the policy DEFINES environments but the selected
 * active one (SYNCRONA_ENV or policy.activeEnvironment) is not among them. In
 * that case the env-scoped guardrails would silently vanish, so callers must
 * fail closed rather than drop to the permissive top-level policy. Returns false
 * when no environments are defined at all (nothing env-scoped to lose).
 */
export function isUnknownActiveEnvironment(config: GuardrailConfig): boolean {
  const definedEnvironments = Object.keys(config.policy.environments);
  if (definedEnvironments.length === 0) {
    return false;
  }
  const active = getActiveEnvironmentName(config);
  return !Object.prototype.hasOwnProperty.call(config.policy.environments, active);
}

export function getEffectiveAllowFullNodeAccess(config: GuardrailConfig): boolean {
  // SEC-3/SEC-4 (REV-84/REV-85): never grant full-node access under an untrusted
  // config or a bogus active environment — do NOT fall back to the top-level flag.
  if (config.invalid === true || isUnknownActiveEnvironment(config)) {
    return false;
  }
  const envPolicy = getEnvironmentPolicy(config);
  if (typeof envPolicy.allowFullNodeAccess === "boolean") {
    return envPolicy.allowFullNodeAccess;
  }
  return config.allowFullNodeAccess === true;
}

export function shouldEnforcePreflight(config: GuardrailConfig, toolName: string): boolean {
  const envPolicy = getEnvironmentPolicy(config);
  const toolPolicy = config.policy.tools[toolName] || {};

  if (toolPolicy.requirePreflight === true) {
    return true;
  }

  if (envPolicy.enforcePreflightForMutations === true) {
    return true;
  }

  return config.enforcePreflightForMutations === true;
}

export function evaluateToolPolicy(
  config: GuardrailConfig,
  toolName: string,
  args: Record<string, unknown>,
  dryRun: boolean
): { allowed: true } | { allowed: false; reason: string } {
  // SEC-3 (REV-84): an unreadable / malformed guardrail config denies every tool.
  if (config.invalid === true) {
    return {
      allowed: false,
      reason: "guardrail config unreadable — refusing mutations",
    };
  }

  // SEC-4 (REV-85): the active environment is not defined in a non-empty
  // policy.environments — the env-scoped guardrails would silently disappear, so
  // fail closed and refuse rather than dropping to the permissive top-level policy.
  if (isUnknownActiveEnvironment(config)) {
    const activeEnvironment = getActiveEnvironmentName(config);
    logger.error("guardrail active environment is not defined in policy.environments", {
      activeEnvironment,
    });
    return {
      allowed: false,
      reason: `Active policy environment "${activeEnvironment}" is not defined in policy.environments — refusing mutations (fail-closed).`,
    };
  }

  const envPolicy = getEnvironmentPolicy(config);
  const toolPolicy = config.policy.tools[toolName] || {};

  const allowTools = normalizeStringArray(envPolicy.allowTools);
  if (allowTools.length > 0 && !allowTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is not allowed in active policy environment ${getActiveEnvironmentName(config)}.`,
    };
  }

  const denyTools = normalizeStringArray(envPolicy.denyTools);
  if (denyTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is denied by active policy environment ${getActiveEnvironmentName(config)}.`,
    };
  }

  if (toolPolicy.deny === true) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is denied by policy.tools.${toolName}.`,
    };
  }

  if (toolPolicy.requireDryRun === true) {
    // SEC-3 follow-up (REV-197): `requireDryRun` is a lock — "this tool may only be
    // PLANNED here". The check accepted the caller's REQUESTED flag, so on a tool whose
    // handler ignores dryRun the lock inverted into its opposite: `dryRun: true` became
    // the ONLY accepted shape, and it still performed the real mutation. An operator who
    // locked such a tool down got every invocation executing for real, with the audit
    // record and the preflight skip both agreeing it was a simulation.
    //
    // Refuse outright when the policy names a tool that cannot honour a dry run: an
    // unenforceable lock must fail closed, not silently pass. REV-149/REV-150/REV-195
    // closed the known gaps, so this branch is a guard against the NEXT tool that gains
    // a requireDryRun policy entry without a dryRun-aware handler.
    if (!toolImplementsDryRun(toolName)) {
      logger.error("guardrail requireDryRun names a tool that does not implement dryRun", {
        tool: toolName,
      });
      return {
        allowed: false,
        reason: `Tool ${toolName} does not implement dryRun, so policy.tools.${toolName}.requireDryRun cannot be enforced — refusing (fail-closed).`,
      };
    }
    if (!dryRun) {
      return {
        allowed: false,
        reason: `Tool ${toolName} requires dryRun=true by policy.tools.${toolName}.requireDryRun.`,
      };
    }
  }

  if (toolPolicy.requireConfirmDestructive === true && args.confirmDestructive !== true) {
    return {
      allowed: false,
      reason: `Tool ${toolName} requires confirmDestructive=true by policy.tools.${toolName}.requireConfirmDestructive.`,
    };
  }

  return { allowed: true };
}
