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