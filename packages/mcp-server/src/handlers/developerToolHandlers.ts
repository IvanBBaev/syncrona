// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  diffInstanceVsLocal,
  suggestAtfTest,
  type DiffRecordInput,
} from "../analysis";
import { escapeQueryValue, toJsonText } from "../runtimeUtils";
import { recordFieldFilePath, type WorkspaceLayout } from "../workspaceLayout";

import type { ToolResponse } from "../toolResponse";

export type DeveloperToolContext = {
  timeoutMs: number;
  projectDir: string;
  // DX17: the on-disk layout, not just the source directory — under `flat: true`
  // a record's field files live at `<table>/<record>~<field>.<ext>`, and probing
  // the record-folder path instead makes every existsSync below miss silently.
  layout: WorkspaceLayout;
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

const INSTANCE_DIFF_LIMIT = 1000;

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
  const text = toJsonText(payload);
  const response: ToolResponse = {
    isError,
    content: [{ type: "text", text }],
  };
  // Mirror plain-object success payloads into MCP structuredContent, re-parsed
  // from the serialized text so both views stay identical (see insightShared).
  if (!isError && payload && typeof payload === "object" && !Array.isArray(payload)) {
    response.structuredContent = JSON.parse(text) as Record<string, unknown>;
  }
  return response;
}

function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

type LocalManifestRead =
  | { ok: true; records: DiffRecordInput[]; missingLocalFiles: string[] }
  | { ok: false; error: string };

// A missing or unreadable manifest is not "no local records": diffed against it,
// every instance record would read as instance-only. Field files the manifest
// lists but the workspace lacks are reported, since the record's local value is
// then partial and its diff entry misleading.
function readLocalRecordsFromManifest(
  projectDir: string,
  layout: WorkspaceLayout,
  table: string,
  scriptField: string,
  recordName?: string
): LocalManifestRead {
  const manifestPath = path.join(projectDir, "sync.manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      error: `No sync.manifest.json in ${projectDir}; run \`syncrona refresh\` before diffing against the instance.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    return {
      ok: false,
      error: `Could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${manifestPath} is not a manifest object.` };
  }

  const root = asRecord(parsed);
  const tables = asRecord(root.tables);
  const tableEntry = asRecord(tables[table]);
  const records = asRecord(tableEntry.records);

  const local: DiffRecordInput[] = [];
  const missingLocalFiles: string[] = [];
  for (const key of Object.keys(records)) {
    const rec = asRecord(records[key]);
    const recName = toStringField(rec.name);
    if (!recName) {
      continue;
    }
    if (recordName && recName !== recordName) {
      continue;
    }

    // Only the field the instance side reads is compared. A record's files also
    // hold other script/html fields and the `.meta` sidecar (DX22); joining them
    // in made every record differ from the instance's single script column.
    const files = Array.isArray(rec.files) ? rec.files : [];
    const scriptFile = files
      .map((fileRaw) => asRecord(fileRaw))
      .find((file) => toStringField(file.name) === scriptField);
    const filePath = recordFieldFilePath(
      projectDir,
      layout,
      table,
      recName,
      scriptField,
      toStringField(scriptFile?.type) || "js"
    );
    let value = "";
    try {
      value = readFileSync(filePath, "utf-8");
    } catch (_) {
      missingLocalFiles.push(path.relative(projectDir, filePath));
    }

    local.push({
      name: recName,
      value,
      sysId: toStringField(rec.sys_id) || undefined,
      updatedOn: toStringField(rec.sys_updated_on) || toStringField(rec.updatedOn) || undefined,
    });
  }

  return { ok: true, records: local, missingLocalFiles };
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
        limit: 2,
      },
      context.timeoutMs
    );

    if (rows.length === 0) {
      return errorResponse(
        `Script Include not found for ${scriptIncludeSysId || scriptIncludeName}. Verify the name/sys_id and scope.`
      );
    }

    // A name is unique only within a scope; with the scope unresolved, picking
    // the first match would analyse another application's Script Include.
    if (rows.length > 1) {
      return errorResponse(
        `More than one Script Include is named ${scriptIncludeName}${scope && scope !== "unknown_scope" ? ` in ${scope}` : " on the instance"}; pass scope or scriptIncludeSysId.`
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
  // Without a scope the query would span every application on the instance, and
  // other scopes' records would read as instance-only against this workspace.
  if (!scope || scope === "unknown_scope") {
    return errorResponse(
      "Could not resolve the application scope from the instance session; pass `scope` to diff against it."
    );
  }

  const localRead = readLocalRecordsFromManifest(
    context.projectDir,
    context.layout,
    table,
    fieldConfig.scriptField,
    recordName
  );
  if (!localRead.ok) {
    return errorResponse(localRead.error);
  }

  const conditions: string[] = [`sys_scope.scope=${escapeQueryValue(scope)}`];
  if (recordName) {
    conditions.push(`${fieldConfig.nameField}=${escapeQueryValue(recordName)}`);
  }

  const rows = await context.tableGet(
    table,
    {
      query: `${conditions.join("^")}^ORDERBY${fieldConfig.nameField}^ORDERBYsys_id`,
      fields: ["sys_id", fieldConfig.nameField, fieldConfig.scriptField, "sys_updated_on"],
      limit: INSTANCE_DIFF_LIMIT + 1,
    },
    context.timeoutMs
  );
  // A capped read would report every local record past the cap as local-only.
  if (rows.length > INSTANCE_DIFF_LIMIT) {
    return errorResponse(
      `${table} holds more than ${INSTANCE_DIFF_LIMIT} records in ${scope}; pass recordName to diff a single record.`
    );
  }

  const instance: DiffRecordInput[] = rows.map((row) => ({
    name: toStringField(row[fieldConfig.nameField]),
    value: toStringField(row[fieldConfig.scriptField]),
    sysId: toStringField(row.sys_id) || undefined,
    updatedOn: toStringField(row.sys_updated_on) || undefined,
  }));

  const report = diffInstanceVsLocal({ local: localRead.records, instance });

  return textResponse({
    tool: "sync_diff_instance_vs_local",
    table,
    scope,
    recordName: recordName || null,
    missingLocalFiles: localRead.missingLocalFiles,
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
