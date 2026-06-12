import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  diffInstanceVsLocal,
  suggestAtfTest,
  type DiffRecordInput,
} from "../analysis";
import { toJsonText } from "../runtimeUtils";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

export type DeveloperToolContext = {
  timeoutMs: number;
  projectDir: string;
  sourceDirectory: string;
  resolveScope: (preferredScope: string) => Promise<string>;
  tableGet: (
    table: string,
    opts: { query?: string; fields?: string[]; limit?: number },
    timeoutMs: number
  ) => Promise<Array<Record<string, unknown>>>;
};

const SCRIPT_FIELD_BY_TABLE: Record<string, { scriptField: string; nameField: string }> = {
  sys_script_include: { scriptField: "script", nameField: "name" },
  sys_script: { scriptField: "script", nameField: "name" },
  sys_script_client: { scriptField: "script", nameField: "name" },
  sys_ui_script: { scriptField: "script", nameField: "name" },
  sys_ws_operation: { scriptField: "operation_script", nameField: "name" },
  sys_transform_script: { scriptField: "script", nameField: "name" },
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

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

function escapeQueryValue(value: string): string {
  return value.replace(/\^/g, " ");
}

function readLocalRecordsFromManifest(
  projectDir: string,
  sourceDirectory: string,
  table: string,
  recordName?: string
): DiffRecordInput[] {
  const manifestPath = path.join(projectDir, "sync.manifest.json");
  if (!existsSync(manifestPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (_) {
    return [];
  }

  const root = asRecord(parsed);
  const tables = asRecord(root.tables);
  const tableEntry = asRecord(tables[table]);
  const records = asRecord(tableEntry.records);

  const local: DiffRecordInput[] = [];
  for (const key of Object.keys(records)) {
    const rec = asRecord(records[key]);
    const recName = toStringField(rec.name);
    if (!recName) {
      continue;
    }
    if (recordName && recName !== recordName) {
      continue;
    }

    const files = Array.isArray(rec.files) ? rec.files : [];
    const parts: string[] = [];
    for (const fileRaw of files) {
      const file = asRecord(fileRaw);
      const fileName = toStringField(file.name) || "script";
      const fileType = toStringField(file.type) || "js";
      const filePath = path.join(projectDir, sourceDirectory, table, recName, `${fileName}.${fileType}`);
      if (existsSync(filePath)) {
        try {
          parts.push(readFileSync(filePath, "utf-8"));
        } catch (_) {
          // ignore unreadable file
        }
      }
    }

    local.push({
      name: recName,
      value: parts.join("\n"),
      sysId: toStringField(rec.sys_id) || undefined,
      updatedOn: toStringField(rec.sys_updated_on) || toStringField(rec.updatedOn) || undefined,
    });
  }

  return local;
}

async function handleSuggestTests(
  args: Record<string, unknown>,
  context: DeveloperToolContext
): Promise<ToolResponse> {
  const scriptIncludeName = toStringField(args.scriptIncludeName).trim();
  const scriptIncludeSysId = toStringField(args.scriptIncludeSysId).trim();
  const inlineScript = toStringField(args.script);

  if (!scriptIncludeName && !scriptIncludeSysId) {
    return errorResponse("Provide scriptIncludeName or scriptIncludeSysId.");
  }

  let script = inlineScript;
  let resolvedName = scriptIncludeName;
  let clientCallable = false;

  if (!inlineScript) {
    const scope = await context.resolveScope(toStringField(args.scope));
    const conditions: string[] = [];
    if (scriptIncludeSysId) {
      conditions.push(`sys_id=${escapeQueryValue(scriptIncludeSysId)}`);
    } else {
      conditions.push(`name=${escapeQueryValue(scriptIncludeName)}`);
    }
    if (scope && scope !== "unknown_scope") {
      conditions.push(`sys_scope.scope=${escapeQueryValue(scope)}`);
    }

    const rows = await context.tableGet(
      "sys_script_include",
      {
        query: conditions.join("^"),
        fields: ["sys_id", "name", "script", "api_name", "client_callable"],
        limit: 1,
      },
      context.timeoutMs
    );

    if (rows.length === 0) {
      return errorResponse(
        `Script Include not found for ${scriptIncludeSysId || scriptIncludeName}. Verify the name/sys_id and scope.`
      );
    }

    const row = rows[0];
    script = toStringField(row.script);
    resolvedName = toStringField(row.name) || scriptIncludeName;
    clientCallable = row.client_callable === true || row.client_callable === "true";
  }

  if (!script.trim()) {
    return errorResponse(`Script Include ${resolvedName} has no script body to analyze.`);
  }

  const suggestion = suggestAtfTest({
    scriptIncludeName: resolvedName,
    script,
    clientCallable,
  });

  return textResponse({
    tool: "sync_suggest_tests",
    source: inlineScript ? "inline" : "instance",
    suggestion,
  });
}

async function handleDiffInstanceVsLocal(
  args: Record<string, unknown>,
  context: DeveloperToolContext
): Promise<ToolResponse> {
  const table = toStringField(args.tableName).trim() || "sys_script_include";
  const fieldConfig = SCRIPT_FIELD_BY_TABLE[table] || { scriptField: "script", nameField: "name" };
  const recordName = toStringField(args.recordName).trim() || undefined;
  const scope = await context.resolveScope(toStringField(args.scope));

  const local = readLocalRecordsFromManifest(
    context.projectDir,
    context.sourceDirectory,
    table,
    recordName
  );

  const conditions: string[] = [];
  if (scope && scope !== "unknown_scope") {
    conditions.push(`sys_scope.scope=${escapeQueryValue(scope)}`);
  }
  if (recordName) {
    conditions.push(`${fieldConfig.nameField}=${escapeQueryValue(recordName)}`);
  }

  const rows = await context.tableGet(
    table,
    {
      query: conditions.join("^"),
      fields: ["sys_id", fieldConfig.nameField, fieldConfig.scriptField, "sys_updated_on"],
      limit: 1000,
    },
    context.timeoutMs
  );

  const instance: DiffRecordInput[] = rows.map((row) => ({
    name: toStringField(row[fieldConfig.nameField]),
    value: toStringField(row[fieldConfig.scriptField]),
    sysId: toStringField(row.sys_id) || undefined,
    updatedOn: toStringField(row.sys_updated_on) || undefined,
  }));

  const report = diffInstanceVsLocal({ local, instance });

  return textResponse({
    tool: "sync_diff_instance_vs_local",
    table,
    scope: scope && scope !== "unknown_scope" ? scope : null,
    recordName: recordName || null,
    report,
  });
}

export async function handleDeveloperTool(
  toolName: string,
  args: Record<string, unknown>,
  context: DeveloperToolContext
): Promise<ToolResponse | null> {
  switch (toolName) {
    case "sync_suggest_tests":
      return handleSuggestTests(args, context);
    case "sync_diff_instance_vs_local":
      return handleDiffInstanceVsLocal(args, context);
    default:
      return null;
  }
}
