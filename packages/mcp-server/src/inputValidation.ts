import { z } from "zod";

export const TABLE_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
export const SYS_ID_REGEX = /^[0-9a-f]{32}$/i;

const timeoutSchema = z.number().min(1000).max(900000);
const tableSchema = z
  .string()
  .trim()
  .regex(TABLE_NAME_REGEX, "must match ServiceNow table format: [a-z][a-z0-9_]*");
const sysIdSchema = z
  .string()
  .trim()
  .regex(SYS_ID_REGEX, "must be a 32-character hexadecimal sys_id");

const toolArgSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  sn_query_records: z
    .object({
      table: tableSchema,
      query: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      analyzeField: z.string().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sn_create_record: z
    .object({
      table: tableSchema,
      record: z.record(z.string(), z.unknown()).optional(),
      confirmDestructive: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sn_get_metadata_record: z
    .object({
      sysId: sysIdSchema,
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sn_update_metadata_record: z
    .object({
      sysId: sysIdSchema,
      updates: z.record(z.string(), z.unknown()).optional(),
      confirmDestructive: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_set_update_set: z
    .object({
      updateSetSysId: sysIdSchema.optional(),
      updateSetName: z.string().optional(),
      createIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_prepare_session: z
    .object({
      expectedUpdateSetSysId: sysIdSchema.optional(),
      expectedScope: z.string().optional(),
      expectedUpdateSetName: z.string().optional(),
      createUpdateSetIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_preflight_check: z
    .object({
      expectedUpdateSetSysId: sysIdSchema.optional(),
      expectedScope: z.string().optional(),
      expectedUpdateSetName: z.string().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  // Every tool listed in safetyPolicy.MUTATING_TOOLS carries a schema so
  // malformed mutating calls are rejected before any side effect.
  sync_set_scope: z
    .object({
      scope: z.string().trim().min(1),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_push: z
    .object({
      target: z.string().optional(),
      diff: z.string().optional(),
      scopeSwap: z.boolean().optional(),
      updateSet: z.string().optional(),
      logLevel: z.enum(["error", "warn", "info", "debug", "silly"]).optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sn_execute_background_script: z
    .object({
      script: z.string().min(1),
      endpointPath: z.string().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_create_script_include: z
    .object({
      name: z.string().trim().min(1),
      apiName: z.string().optional(),
      script: z.string().optional(),
      active: z.boolean().optional(),
      clientCallable: z.boolean().optional(),
      refreshAfterCreate: z.boolean().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_create_script_include_and_sync: z
    .object({
      name: z.string().trim().min(1),
      apiName: z.string().optional(),
      script: z.string().optional(),
      active: z.boolean().optional(),
      clientCallable: z.boolean().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sn_autonomous_remediation_workflow: z
    .object({
      script: z.string().min(1),
      apply: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      confirmDestructive: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
  sync_unified_change_workflow: z
    .object({
      task: z.string().optional(),
      script: z.string().optional(),
      taskType: z.enum(["script", "metadata", "hybrid"]).optional(),
      executionMode: z.enum(["mocked", "remote"]).optional(),
      allowRemoteApply: z.boolean().optional(),
      remoteScript: z.string().optional(),
      remoteEndpoint: z.string().optional(),
      proposedChanges: z.array(z.record(z.string(), z.unknown())).optional(),
      footprintBudget: z.record(z.string(), z.unknown()).optional(),
      riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
      approval: z.record(z.string(), z.unknown()).optional(),
      rollbackEvidence: z.record(z.string(), z.unknown()).optional(),
      policy: z.record(z.string(), z.unknown()).optional(),
      apply: z.boolean().optional(),
      confirmDestructive: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    })
    .passthrough(),
};

const topLevelIdentifierSchemas: Record<string, z.ZodType<string>> = {
  table: tableSchema,
  tableName: tableSchema,
  sysId: sysIdSchema,
  updateSetSysId: sysIdSchema,
  expectedUpdateSetSysId: sysIdSchema,
};

export type ToolValidationResult =
  | { valid: true; normalizedArgs: Record<string, unknown> }
  | { valid: false; error: string };

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "Invalid tool arguments";
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
  return `${path}: ${issue.message}`;
}

function validateTopLevelIdentifiers(args: Record<string, unknown>): ToolValidationResult | null {
  for (const [key, schema] of Object.entries(topLevelIdentifierSchemas)) {
    if (!(key in args)) {
      continue;
    }

    const value = args[key];
    if (typeof value !== "string") {
      return {
        valid: false,
        error: `${key}: must be a string`,
      };
    }

    if (value.trim().length === 0) {
      continue;
    }

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        valid: false,
        error: `${key}: ${formatZodError(parsed.error)}`,
      };
    }
  }

  return null;
}

export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>
): ToolValidationResult {
  const schema = toolArgSchemas[toolName];
  let normalizedArgs = args;

  if (schema) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return {
        valid: false,
        error: formatZodError(parsed.error),
      };
    }
    normalizedArgs = parsed.data;
  }

  const identifierValidation = validateTopLevelIdentifiers(normalizedArgs);
  if (identifierValidation) {
    return identifierValidation;
  }

  return {
    valid: true,
    normalizedArgs,
  };
}