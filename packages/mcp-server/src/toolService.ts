import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  summarizeMetrics,
  type MetadataType,
  type ToolMetricEvent,
} from "./analysis";
import { isMutatingTool } from "./safetyPolicy";
import { sanitizeForAudit, writeAuditEvent } from "./audit";
import { appendMetricEvent } from "./metricsStore";
import {
  commandResultToText,
  toJsonText,
} from "./runtimeUtils";
import {
  getCurrentScopeWithFallback,
  runBackgroundScript,
  snScopedApiRequest,
  snRequest,
} from "./servicenowCore";
import { getSessionContext } from "./sessionContext";
import { MCP_TOOLS } from "./toolSchemas";
import { getScopeDocsPaths, getScopeTableDocPath } from "./scopePaths";
import {
  classifyRelationVisibility,
  toGraphFromUnknown,
  hydrateScopeKnowledgeInputs,
} from "./analysis/scopeDiscovery";
import {
  DEFAULT_GUARDRAIL_CONFIG,
  parseGuardrailConfig,
  shouldEnforcePreflight,
  type GuardrailConfig,
} from "./policyConfig";
import {
  AUDIT_DIR,
  AUDIT_FILE,
  DEFAULT_TIMEOUT_MS,
  GUARDRAIL_CONFIG_FILE,
  METRICS_FILE,
  PROJECT_DIR,
  SERVER_NAME,
  SERVER_VERSION,
} from "./runtimeConfig";
import { asRecord, toStringField } from "./recordUtils";
import {
  runSyncroCliCommand,
  type CmdResult,
} from "./processRunner";
import { handleScopeKnowledgeTool } from "./handlers/scopeKnowledgeHandlers";
import { handleRelationOnboardingTool } from "./handlers/relationOnboardingHandlers";
import { handleWorkflowTool } from "./handlers/workflowHandlers";

export type UnifiedTaskType = "script" | "metadata" | "hybrid";

let LAST_AUDIT_INTEGRITY_STATUS = "unknown";

export function setAuditIntegrityStatus(status: string): void {
  LAST_AUDIT_INTEGRITY_STATUS = status;
}

export const TOOL_METRICS: ToolMetricEvent[] = [];

export function normalizeTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(timeoutMs, 1000), 900000);
}

export function loadGuardrailConfig(projectDir: string = PROJECT_DIR): GuardrailConfig {
  const cfgPath = path.join(projectDir, "sync.mcp.guardrails.json");
  if (!existsSync(cfgPath)) {
    return { ...DEFAULT_GUARDRAIL_CONFIG };
  }

  try {
    const raw = readFileSync(cfgPath, "utf-8");
    return parseGuardrailConfig(JSON.parse(raw));
  } catch (_) {
    return { ...DEFAULT_GUARDRAIL_CONFIG };
  }
}

export function makeDryRunResponse(toolName: string, details: Record<string, unknown>) {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: toJsonText({
          dryRun: true,
          tool: toolName,
          planned: details,
        }),
      },
    ],
  };
}

export function buildHealthHttpSnapshot(): Record<string, unknown> {
  const metricsSummary = summarizeMetrics(TOOL_METRICS);
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    metrics: {
      tools: asRecord(metricsSummary.tools),
      windows: Array.isArray(metricsSummary.windows) ? metricsSummary.windows : [],
    },
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "stdio",
      toolCount: MCP_TOOLS.length,
    },
    audit: {
      integrity: LAST_AUDIT_INTEGRITY_STATUS,
    },
  };
}

export function makeDryRunAuditResponse(
  toolName: string,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  correlationId?: string
) {
  auditMutatingTool(toolName, args, {
    dryRun: true,
    planned: details,
  }, undefined, correlationId);
  return makeDryRunResponse(toolName, details);
}

export function generateCorrelationId(seedMs: number = Date.now()): string {
  const tsPart = Math.max(seedMs, 0).toString(36);
  const randPart = Math.random().toString(36).slice(2, 10);
  return `corr_${tsPart}_${randPart}`;
}

export function resolveCorrelationId(args: Record<string, unknown>, seedMs: number = Date.now()): string {
  const explicit = typeof args.correlationId === "string" ? args.correlationId.trim() : "";
  if (explicit) {
    return explicit.replace(/[^a-z0-9._-]/gi, "_").slice(0, 120);
  }
  return generateCorrelationId(seedMs);
}

export function withCorrelationIdInResponse(
  response: { isError: boolean; content: Array<{ type: string; text: string }> },
  correlationId: string
): { isError: boolean; content: Array<{ type: string; text: string }> } {
  if (!Array.isArray(response.content) || response.content.length === 0) {
    return response;
  }

  const first = asRecord(response.content[0]);
  const text = toStringField(first.text);
  if (!text.trim()) {
    return response;
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response;
    }
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.correlationId === "string" && payload.correlationId.trim()) {
      return response;
    }
    payload.correlationId = correlationId;
    return {
      ...response,
      content: [{ type: "text", text: toJsonText(payload) }, ...response.content.slice(1)],
    };
  } catch (_) {
    return response;
  }
}


export function writeFileWithStableBackup(filePath: string, content: string): void {
  const backupPath = `${filePath}.bak`;
  if (existsSync(filePath)) {
    try {
      const previous = readFileSync(filePath, "utf-8");
      writeFileSync(backupPath, previous, "utf-8");
    } catch (_) {
      // Keep best-effort backup behavior.
    }
  }

  writeFileSync(filePath, content, "utf-8");
}

export function parseUnifiedTaskType(value: unknown): UnifiedTaskType {
  if (value === "script" || value === "metadata" || value === "hybrid") {
    return value;
  }
  return "hybrid";
}

export function isDeepAnalysisSatisfied(
  taskType: UnifiedTaskType,
  hasScript: boolean,
  hasMetadata: boolean
): boolean {
  if (taskType === "script") {
    return hasScript;
  }
  if (taskType === "metadata") {
    return hasMetadata;
  }
  return hasScript || hasMetadata;
}

export async function safeGetSessionContext(timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    return await getSessionContext(timeoutMs);
  } catch (_) {
    return null;
  }
}

export async function resolveScopeCode(preferredScope: string, timeoutMs: number): Promise<string> {
  if (preferredScope.trim().length > 0) {
    return preferredScope.trim();
  }

  const context = await safeGetSessionContext(timeoutMs);
  if (!context) {
    return "unknown_scope";
  }
  return toStringField(asRecord(context.scope).scope) || "unknown_scope";
}

export function auditMutatingTool(
  toolName: string,
  args: Record<string, unknown>,
  outcome: Record<string, unknown>,
  durationMs?: number,
  correlationId?: string
): void {
  if (!isMutatingTool(toolName)) {
    return;
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    args: sanitizeForAudit(args),
    outcome: sanitizeForAudit(outcome),
    durationMs: typeof durationMs === "number" ? Math.max(durationMs, 0) : 0,
    dryRun: args.dryRun === true,
  };
  if (typeof correlationId === "string" && correlationId.trim()) {
    entry.correlationId = correlationId.trim();
  }
  writeAuditEvent(AUDIT_DIR, AUDIT_FILE, entry);
}

export function auditToolCall(
  toolName: string,
  args: Record<string, unknown>,
  outcome: {
    isError: boolean;
    error?: string;
  },
  durationMs: number,
  auditDir: string = AUDIT_DIR,
  auditFile: string = AUDIT_FILE,
  correlationId?: string
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: "tool.call",
    tool: toolName,
    mutating: isMutatingTool(toolName),
    dryRun: args.dryRun === true,
    args: sanitizeForAudit(args),
    ok: !outcome.isError,
    error: outcome.error ? sanitizeForAudit(outcome.error) : "",
    durationMs: Math.max(durationMs, 0),
  };
  if (typeof correlationId === "string" && correlationId.trim()) {
    entry.correlationId = correlationId.trim();
  }
  writeAuditEvent(auditDir, auditFile, entry);
}

export function shouldInvalidateSemanticIndex(toolName: string, args: Record<string, unknown>): boolean {
  if (args.dryRun === true) {
    return false;
  }

  const toolsThatCanChangeWorkspace = new Set([
    "run_syncro_command",
    "run_workspace_command",
    "run_node_code",
    "sync_create_script_include",
    "sync_create_script_include_and_sync",
  ]);

  return toolsThatCanChangeWorkspace.has(toolName);
}

export function parseMetadataType(value: unknown): MetadataType | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  const allowed: MetadataType[] = [
    "business_rule",
    "client_script",
    "ui_script",
    "ui_action",
    "ui_formatter",
    "acl",
    "dictionary",
    "ui_policy",
    "scripted_rest",
    "scheduled_job",
  ];
  return allowed.includes(normalized as MetadataType)
    ? (normalized as MetadataType)
    : null;
}

export function recordToolMetric(
  tool: string,
  isError: boolean,
  startedAt: number,
  correlationId?: string
): void {
  const event = {
    tool,
    ok: !isError,
    latencyMs: Math.max(Date.now() - startedAt, 0),
    timestamp: new Date().toISOString(),
    correlationId:
      typeof correlationId === "string" && correlationId.trim()
        ? correlationId.trim()
        : undefined,
  };

  TOOL_METRICS.push(event);

  if (TOOL_METRICS.length > 500) {
    TOOL_METRICS.splice(0, TOOL_METRICS.length - 500);
  }

  appendMetricEvent(AUDIT_DIR, METRICS_FILE, event);
}

export async function checkSyncronaCapabilities(
  timeoutMs: number,
  scopeCode?: string
): Promise<
  Record<string, unknown>
> {
  let resolvedScope = scopeCode || "unknown_scope";
  if (!scopeCode) {
    try {
      // Resolve only the current scope; the full session context drags in
      // user/update-set lookups that are irrelevant to capability probing
      // and fail the whole resolution when any of them is unavailable.
      const res = await getCurrentScopeWithFallback(timeoutMs, PROJECT_DIR);
      const scopeObj = asRecord(asRecord(res.data).result);
      const currentScope = toStringField(scopeObj.scope);
      if (currentScope) {
        resolvedScope = currentScope;
      }
    } catch (_) {}
  }

  const checks = {
    getCurrentScope: { method: "GET", route: "sinc/getCurrentScope", body: undefined },
    getAppList: { method: "GET", route: "sinc/getAppList", body: undefined },
    getManifestSample: {
      method: "POST",
      route: `sinc/getManifest/${resolvedScope}`,
      body: { includes: {}, excludes: {}, tableOptions: {}, withFiles: false },
    },
    runBackgroundScript: {
      method: "POST",
      route: "sinc/runBackgroundScript",
      body: { script: "" },
    },
  };

  const results: Record<string, unknown> = {};
  for (const [name, check] of Object.entries(checks)) {
    try {
      // NOTE: preferredPrefixes expects an API namespace (x_nuvo_sinc/_sync),
      // not a target scope code — passing scopeCode here probed bogus
      // /api/<scope>/… endpoints.
      const response = await snScopedApiRequest(
        check.method,
        check.route,
        check.body,
        timeoutMs,
        PROJECT_DIR
      );
      results[name] = {
        endpoint: response.usedEndpoint,
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
      };
    } catch (error) {
      results[name] = {
        endpoint: check.route,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return results;
}

export async function buildPreflightReport(
  timeoutMs: number,
  overrideConfig?: Partial<GuardrailConfig>
): Promise<Record<string, unknown>> {
  const cfg = {
    ...loadGuardrailConfig(),
    ...(overrideConfig || {}),
  };
  const context = await getSessionContext(timeoutMs);
  const scopeObj = asRecord(context.scope);
  const updateObj = asRecord(context.updateSet);

  const currentScope = toStringField(scopeObj.scope);
  const currentUpdateSetName = toStringField(updateObj.name);
  const currentUpdateSetSysId = toStringField(updateObj.sysId);

  const scopeOk = !cfg.expectedScope || cfg.expectedScope === currentScope;
  const updateSetOkBySysId =
    !cfg.expectedUpdateSetSysId || cfg.expectedUpdateSetSysId === currentUpdateSetSysId;
  const updateSetOkByName =
    !cfg.expectedUpdateSetName || cfg.expectedUpdateSetName === currentUpdateSetName;
  const updateSetOk = updateSetOkBySysId && updateSetOkByName;

  return {
    expected: {
      scope: cfg.expectedScope,
      updateSetName: cfg.expectedUpdateSetName,
      updateSetSysId: cfg.expectedUpdateSetSysId,
    },
    current: {
      scope: currentScope,
      updateSetName: currentUpdateSetName,
      updateSetSysId: currentUpdateSetSysId,
    },
    checks: {
      scopeOk,
      updateSetOk,
      allOk: scopeOk && updateSetOk,
    },
    context,
  };
}

export async function enforcePreflightForTool(toolName: string, timeoutMs: number): Promise<void> {
  if (!isMutatingTool(toolName)) {
    return;
  }

  const cfg = loadGuardrailConfig();
  if (!shouldEnforcePreflight(cfg, toolName)) {
    return;
  }

  const report = await buildPreflightReport(timeoutMs, cfg);
  const checks = asRecord(report.checks);
  if (checks.allOk !== true) {
    throw new Error(
      `Preflight failed for mutating tool ${toolName}. Run sync_prepare_session or fix guardrails in sync.mcp.guardrails.json.`
    );
  }
}

export async function createAndSyncScriptInclude(
  params: {
    name: string;
    apiName?: string;
    script?: string;
    active?: boolean;
    clientCallable?: boolean;
    refreshAfterCreate?: boolean;
  },
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const name = params.name.trim();
  const apiName = toStringField(params.apiName).trim();
  const script = toStringField(params.script);
  const active = params.active !== false;
  const clientCallable = params.clientCallable === true;
  const refreshAfterCreate = params.refreshAfterCreate !== false;

  const createPayload: Record<string, unknown> = {
    name,
    script,
    active,
    client_callable: clientCallable,
  };

  if (apiName.length > 0) {
    createPayload.api_name = apiName;
  }

  const createRes = await snRequest(
    "POST",
    "/api/now/table/sys_script_include",
    createPayload,
    timeoutMs
  );
  const created = asRecord(asRecord(createRes.data).result);

  let refreshResult: CmdResult | null = null;
  if (createRes.status >= 200 && createRes.status < 300 && refreshAfterCreate) {
    refreshResult = await runSyncroCliCommand("refresh", ["--logLevel", "warn"], timeoutMs);
  }

  const localPaths = findScriptIncludeLocalPaths(name);

  return {
    createStatus: createRes.status,
    created,
    refreshTriggered: refreshAfterCreate,
    refreshResult:
      refreshResult === null ? null : commandResultToText(refreshResult),
    localPaths,
    nextStep:
      localPaths.length > 0
        ? "Ask AI to edit one of the localPaths directly."
        : "No local path found in manifest yet. Run syncro-now-ai refresh again and retry.",
    isFailure:
      createRes.status < 200 ||
      createRes.status > 299 ||
      (refreshResult !== null && refreshResult.exitCode !== 0),
  };
}

export function getSourceDirectory(projectDir: string = PROJECT_DIR): string {
  const configPath = path.join(projectDir, "sync.config.js");
  if (!existsSync(configPath)) {
    return "src";
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(configPath);
    const cfg = loaded?.default || loaded;
    if (
      cfg &&
      typeof cfg === "object" &&
      typeof cfg.sourceDirectory === "string" &&
      cfg.sourceDirectory.trim().length > 0
    ) {
      return cfg.sourceDirectory;
    }
    return "src";
  } catch (_) {
    return "src";
  }
}

export function findScriptIncludeLocalPaths(
  recordName: string,
  projectDir: string = PROJECT_DIR
): string[] {
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
  const sysScriptInclude = asRecord(tables.sys_script_include);
  const records = asRecord(sysScriptInclude.records);
  const sourceDir = getSourceDirectory(projectDir);

  const paths: string[] = [];
  for (const key of Object.keys(records)) {
    const rec = asRecord(records[key]);
    const recName = typeof rec.name === "string" ? rec.name : "";
    if (recName !== recordName) {
      continue;
    }

    const files = Array.isArray(rec.files) ? rec.files : [];
    for (const fileRaw of files) {
      const file = asRecord(fileRaw);
      const fileName = typeof file.name === "string" ? file.name : "script";
      const fileType = typeof file.type === "string" ? file.type : "js";
      const filePath = path.join(
        projectDir,
        sourceDir,
        "sys_script_include",
        recName,
        `${fileName}.${fileType}`
      );
      paths.push(filePath);
    }
  }

  return paths;
}

export async function executeMcpToolIntegration(
  toolName: string,
  args: Record<string, unknown>,
  opts?: {
    timeoutMs?: number;
    dryRun?: boolean;
    correlationId?: string;
    preflight?: Record<string, unknown>;
    sessionContext?: Record<string, unknown>;
    remoteExecutor?: (
      script: string,
      timeoutMs: number,
      endpointPath?: string
    ) => Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }>;
  }
): Promise<Record<string, unknown>> {
  const dryRun = opts?.dryRun === true;
  const timeoutMs = normalizeTimeout(opts?.timeoutMs);
  const startedAt = Date.now();
  const correlationId =
    typeof opts?.correlationId === "string" && opts.correlationId.trim()
      ? opts.correlationId.trim()
      : resolveCorrelationId(args, startedAt);

  const toIntegrationResult = (response: {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  }): Record<string, unknown> => {
    const text = Array.isArray(response.content) && response.content.length > 0
      ? String(asRecord(response.content[0]).text || "")
      : "";

    if (!text.trim()) {
      return {
        isError: response.isError,
        payload: {},
      };
    }

    try {
      const parsedRaw = JSON.parse(text);
      if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
        return {
          isError: response.isError,
          payload: {
            value: parsedRaw,
            correlationId,
          },
        };
      }
      const parsed = parsedRaw as Record<string, unknown>;
      if (!(typeof parsed.correlationId === "string" && parsed.correlationId.trim())) {
        parsed.correlationId = correlationId;
      }
      return {
        isError: response.isError,
        payload: parsed,
      };
    } catch (_) {
      return {
        isError: response.isError,
        payload: { message: text, correlationId },
      };
    }
  };

  const integrationResolveScopeCode = async (scopeArg: string): Promise<string> => {
    if (scopeArg.trim().length > 0) {
      return scopeArg.trim();
    }
    return "unknown_scope";
  };

  const scopeKnowledgeToolResponse = await handleScopeKnowledgeTool(toolName, args, {
    timeoutMs,
    dryRun,
    resolveScopeCode: (scopeArg) => integrationResolveScopeCode(scopeArg),
    hydrateScopeKnowledgeInputs,
    safeGetSessionContext: async () => opts?.sessionContext || safeGetSessionContext(timeoutMs),
    asRecord,
    toGraphFromUnknown,
    writeJsonAndMarkdown: (paths, index, markdown) => {
      mkdirSync(paths.dir, { recursive: true });
      writeFileWithStableBackup(paths.jsonPath, `${JSON.stringify(index, null, 2)}\n`);
      writeFileWithStableBackup(paths.markdownPath, markdown);
    },
    writeTableDocs: (scopeCode, docs) => {
      const writtenPaths: string[] = [];
      for (const doc of docs) {
        const targetPath = getScopeTableDocPath(scopeCode, doc.tableName);
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileWithStableBackup(targetPath, doc.markdown);
        writtenPaths.push(targetPath);
      }
      return writtenPaths.sort((a, b) => a.localeCompare(b));
    },
    writeScopeDocsBundle: (scopeCode, files) => {
      const docsRoot = getScopeDocsPaths(scopeCode);
      const writtenPaths: string[] = [];
      for (const file of files) {
        const targetPath = path.join(docsRoot.dir, file.relativePath);
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileWithStableBackup(targetPath, file.content);
        writtenPaths.push(targetPath);
      }
      return writtenPaths.sort((a, b) => a.localeCompare(b));
    },
  });
  if (scopeKnowledgeToolResponse) {
    return toIntegrationResult(scopeKnowledgeToolResponse);
  }

  const relationOnboardingToolResponse = await handleRelationOnboardingTool(toolName, args, {
    timeoutMs,
    projectDir: PROJECT_DIR,
    guardrailConfigFile: GUARDRAIL_CONFIG_FILE,
    resolveScopeCode: (scopeArg) => integrationResolveScopeCode(scopeArg),
    hydrateScopeKnowledgeInputs,
    toGraphFromUnknown,
    classifyRelationVisibility,
    existsSync,
    joinPath: path.join,
  });
  if (relationOnboardingToolResponse) {
    return toIntegrationResult(relationOnboardingToolResponse);
  }

  const workflowToolResponse = await handleWorkflowTool(toolName, args, {
    timeoutMs,
    startedAt: Date.now(),
    parseUnifiedTaskType,
    isDeepAnalysisSatisfied,
    buildPreflightReport: async (resolvedTimeoutMs) => {
      if (opts?.preflight) {
        return opts.preflight;
      }
      return buildPreflightReport(resolvedTimeoutMs);
    },
    asRecord,
    toGraphFromUnknown,
    safeGetSessionContext: async () => opts?.sessionContext || safeGetSessionContext(timeoutMs),
    toStringField,
    writeJsonAndMarkdown: (paths, index, markdown) => {
      mkdirSync(paths.dir, { recursive: true });
      writeFileWithStableBackup(paths.jsonPath, `${JSON.stringify(index, null, 2)}\n`);
      writeFileWithStableBackup(paths.markdownPath, markdown);
    },
    runRemoteScript: (script, resolvedTimeoutMs, endpointPath) =>
      opts?.remoteExecutor
        ? opts.remoteExecutor(script, resolvedTimeoutMs, endpointPath)
        : runBackgroundScript(script, resolvedTimeoutMs, endpointPath, PROJECT_DIR),
    auditMutatingTool: (innerToolName, innerArgs, outcome, durationMs) =>
      auditMutatingTool(innerToolName, innerArgs, outcome, durationMs, correlationId),
  });
  if (workflowToolResponse) {
    return toIntegrationResult(workflowToolResponse);
  }

  return {
    isError: true,
    payload: {
      error: `Unsupported tool in integration helper: ${toolName}`,
      correlationId,
    },
  };
}
