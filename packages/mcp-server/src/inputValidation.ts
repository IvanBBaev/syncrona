// SPDX-License-Identifier: GPL-3.0-or-later
// Zod 4 migration (DEP1): looseObject replaces .passthrough(); the sys_id union carries its own error.
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
// The tool schemas advertise `default: ""` for the optional sys_id fields, so a
// client that materializes its own declared defaults sends "". Treat that as
// "not supplied" — matching validateTopLevelIdentifiers, which already skips
// empty values — instead of rejecting a schema-conformant call with a bogus
// sys_id format complaint. Handlers resolve an empty sys_id by name.
// Zod 4 reports a failed union as a generic "Invalid input" instead of zod 3's
// surfacing of the matching-type branch's check message, so the union carries
// the sys_id message itself to keep the surfaced reason informative.
const optionalSysIdSchema = z
  .union([z.literal(""), sysIdSchema], {
    error: "must be a 32-character hexadecimal sys_id",
  })
  .optional();

const toolArgSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  sn_query_records: z
    .looseObject({
      table: tableSchema,
      query: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      analyzeField: z.string().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sn_create_record: z
    .looseObject({
      table: tableSchema,
      record: z.record(z.string(), z.unknown()).optional(),
      confirmDestructive: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sn_get_metadata_record: z
    .looseObject({
      sysId: sysIdSchema,
      timeoutMs: timeoutSchema.optional(),
    }),
  sn_update_metadata_record: z
    .looseObject({
      sysId: sysIdSchema,
      updates: z.record(z.string(), z.unknown()).optional(),
      confirmDestructive: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_set_update_set: z
    .looseObject({
      updateSetSysId: optionalSysIdSchema,
      updateSetName: z.string().optional(),
      createIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_prepare_session: z
    .looseObject({
      expectedUpdateSetSysId: optionalSysIdSchema,
      expectedScope: z.string().optional(),
      expectedUpdateSetName: z.string().optional(),
      createUpdateSetIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_preflight_check: z
    .looseObject({
      expectedUpdateSetSysId: optionalSysIdSchema,
      expectedScope: z.string().optional(),
      expectedUpdateSetName: z.string().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  // Every tool listed in safetyPolicy.MUTATING_TOOLS carries a schema so
  // malformed mutating calls are rejected before any side effect.
  sync_set_scope: z
    .looseObject({
      scope: z.string().trim().min(1),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_push: z
    .looseObject({
      target: z.string().optional(),
      diff: z.string().optional(),
      scopeSwap: z.boolean().optional(),
      updateSet: z.string().optional(),
      logLevel: z.enum(["error", "warn", "info", "debug", "silly"]).optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sn_execute_background_script: z
    .looseObject({
      script: z.string().min(1),
      endpointPath: z.string().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_create_script_include: z
    .looseObject({
      name: z.string().trim().min(1),
      apiName: z.string().optional(),
      script: z.string().optional(),
      active: z.boolean().optional(),
      clientCallable: z.boolean().optional(),
      refreshAfterCreate: z.boolean().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_create_script_include_and_sync: z
    .looseObject({
      name: z.string().trim().min(1),
      apiName: z.string().optional(),
      script: z.string().optional(),
      active: z.boolean().optional(),
      clientCallable: z.boolean().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_run_atf_tests: z
    .looseObject({
      scope: z.string().trim().min(1),
      suiteId: z.string().optional(),
      testId: z.string().optional(),
      runAll: z.boolean().optional(),
      confirmDestructive: z.boolean(),
      dryRun: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sn_autonomous_remediation_workflow: z
    .looseObject({
      script: z.string().min(1),
      apply: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      confirmDestructive: z.boolean().optional(),
      timeoutMs: timeoutSchema.optional(),
    }),
  sync_unified_change_workflow: z
    .looseObject({
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
    }),
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