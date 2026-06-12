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

export function parseGuardrailConfig(value: unknown): GuardrailConfig {
  const parsed = asRecord(value);
  const policyRaw = asRecord(parsed.policy);
  const toolsRaw = asRecord(policyRaw.tools);
  const envsRaw = asRecord(policyRaw.environments);

  const tools: Record<string, ToolPolicy> = {};
  for (const [toolName, rawPolicy] of Object.entries(toolsRaw)) {
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
    const envRule = asRecord(rawEnvPolicy);
    environments[envName] = {
      allowTools: normalizeStringArray(envRule.allowTools),
      denyTools: normalizeStringArray(envRule.denyTools),
      enforcePreflightForMutations: envRule.enforcePreflightForMutations === true,
      allowFullNodeAccess: envRule.allowFullNodeAccess === true,
    };
  }

  return {
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

export function getEffectiveAllowFullNodeAccess(config: GuardrailConfig): boolean {
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

  if (toolPolicy.requireDryRun === true && !dryRun) {
    return {
      allowed: false,
      reason: `Tool ${toolName} requires dryRun=true by policy.tools.${toolName}.requireDryRun.`,
    };
  }

  if (toolPolicy.requireConfirmDestructive === true && args.confirmDestructive !== true) {
    return {
      allowed: false,
      reason: `Tool ${toolName} requires confirmDestructive=true by policy.tools.${toolName}.requireConfirmDestructive.`,
    };
  }

  return { allowed: true };
}
