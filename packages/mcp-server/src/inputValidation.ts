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
      // REV-195: the handler branches on `dryRun` but the schema never typed it, so a
      // `dryRun: "true"` string passed validation and then failed the `=== true` test —
      // a caller asking for a simulation silently got the real scope switch.
      dryRun: z.boolean().optional(),
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
      // SEC-3 follow-up (REV-150): declared like every other mutating tool now that the
      // handler actually honors it.
      dryRun: z.boolean().optional(),
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

/**
 * Re-checks the identifier fields every tool shares, and writes the normalized
 * value back into `args`.
 *
 * The write-back is the point: each identifier schema `.trim()`s before it matches
 * the regex, so parsing `" <sys_id> "` succeeds. Keeping only `parsed.success` and
 * discarding `parsed.data` therefore reported "valid" while leaving the untrimmed
 * string in the arguments the handler goes on to use — and that happened whenever
 * the tool's own schema had not already normalized the field: for an extra key on
 * a `looseObject` (`sn_query_records` + `sysId`) or for any tool with no entry in
 * `toolArgSchemas` at all (`sn_search_scripts` + `table`). The characters that
 * escaped are exactly the ones `String.prototype.trim` strips, newlines included,
 * so a value the gate had declared regex-clean reached the Table API URL builder
 * and the audit line. Normalizing here makes `normalizedArgs` the single
 * normalized truth, which is what every caller already assumes it is.
 *
 * Mutates `args`, so the caller must hand in an object it owns.
 */
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
      // Normalize to "" rather than passing the blank through. "Treat as not
      // supplied" only holds downstream if the value is falsy there: handlers test
      // `args.table` / `args.sysId` for truthiness to decide whether to resolve by
      // name, and " " is truthy, so a whitespace-only identifier was declared
      // absent here and arrived as a supplied-but-blank table name or sys_id.
      args[key] = "";
      continue;
    }

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        valid: false,
        error: `${key}: ${formatZodError(parsed.error)}`,
      };
    }
    args[key] = parsed.data;
  }

  return null;
}

export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>
): ToolValidationResult {
  // Own properties only: a bare `toolArgSchemas[toolName]` also resolves inherited
  // Object.prototype members, so a client calling the tool "constructor" (or
  // "toString"/"valueOf"/"hasOwnProperty"/"__proto__") got a truthy non-schema back
  // and `schema.safeParse(args)` threw `TypeError: schema.safeParse is not a
  // function`. index.ts hands us `request.params.name` verbatim, before any
  // is-this-a-real-tool check, so the name is fully client-controlled and the throw
  // surfaced as an internal error instead of a clean INVALID_ARGUMENTS. Same guard
  // as normalizeAuthMethod in @syncrona/sn-transport, which had the same bug.
  const schema = Object.prototype.hasOwnProperty.call(toolArgSchemas, toolName)
    ? toolArgSchemas[toolName]
    : undefined;
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
  } else {
    // No schema of its own, so `parsed.data` did not give us a fresh object.
    // Copy before validateTopLevelIdentifiers normalizes in place: index.ts keeps
    // the raw arguments for the audit trail and the correlation id, and must not
    // see them rewritten underneath it.
    normalizedArgs = { ...args };
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