import { existsSync, mkdirSync } from "fs";
import path from "path";
import { MCP_TOOLS } from "./toolSchemas";
import type { ToolHandlerInvocation, ToolHandlerResponse } from "./toolDispatch";
import { runBackgroundScript } from "./servicenowCore";
import { tableGet } from "./sessionContext";
import { getScopeDocsPaths, getScopeTableDocPath } from "./scopePaths";
import {
  classifyRelationVisibility,
  toGraphFromUnknown,
  hydrateScopeKnowledgeInputs,
} from "./analysis/scopeDiscovery";
import {
  getEffectiveAllowFullNodeAccess,
  type GuardrailConfig,
} from "./policyConfig";
import { isUnsafeWorkspaceCommand } from "./safetyPolicy";
import { getHealthEndpointStatus } from "./healthServer";
import { asRecord, toStringField } from "./recordUtils";
import { runCommand, runSyncroCliCommand } from "./processRunner";
import {
  GUARDRAIL_CONFIG_FILE,
  PROJECT_DIR,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_CONTRACT_VERSION,
} from "./runtimeConfig";
import { getSemanticIndex, setSemanticIndex } from "./semanticIndexState";
import { handleSessionTool } from "./handlers/sessionHandlers";
import { handleWorkspaceTool } from "./handlers/workspaceHandlers";
import { handleServiceNowCrudTool } from "./handlers/serviceNowCrudHandlers";
import { handleInsightTool } from "./handlers/insightToolHandlers";
import { handleMetadataAnalysisTool } from "./handlers/metadataAnalysisHandlers";
import { handleScriptAnalysisTool } from "./handlers/scriptAnalysisHandlers";
import { handleHealthPlanningTool } from "./handlers/healthPlanningHandlers";
import { handleScopeKnowledgeTool } from "./handlers/scopeKnowledgeHandlers";
import { handleRelationOnboardingTool } from "./handlers/relationOnboardingHandlers";
import { handleWorkflowTool } from "./handlers/workflowHandlers";
import { handleDeveloperTool } from "./handlers/developerToolHandlers";
import {
  getToolMetrics,
  buildPreflightReport,
  checkSyncronaCapabilities,
  createAndSyncScriptInclude,
  getSourceDirectory,
  isDeepAnalysisSatisfied,
  parseMetadataType,
  parseUnifiedTaskType,
  resolveScopeCode,
  safeGetSessionContext,
  writeFileWithStableBackup,
} from "./toolService";

/**
 * Per-request context handed to every tool handler module. Everything that is
 * request-scoped (args, timeout, dry-run, audit closures bound to the request
 * correlation id) lives here; process-wide collaborators are imported by the
 * modules directly.
 */
export type ToolModuleContext = {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  guardrailConfig: GuardrailConfig;
  makeDryRunAuditResponse: (
    toolName: string,
    args: Record<string, unknown>,
    details: Record<string, unknown>
  ) => ToolHandlerResponse;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

/**
 * One pluggable handler module of the MCP server. Modules are tried in
 * registry order; the first one returning a non-null response wins (a module
 * returns null for tool names it does not own).
 *
 * Adding a tool family = appending one entry to TOOL_HANDLER_MODULES.
 * Removing one = deleting its entry. The CallTool orchestration in index.ts
 * never changes for that (open/closed at the module level).
 */
export type ToolHandlerModule = {
  name: string;
  invoke: (
    ctx: ToolModuleContext
  ) => Promise<ToolHandlerResponse | null> | ToolHandlerResponse | null;
};

const writeJsonAndMarkdown = (
  paths: { dir: string; jsonPath: string; markdownPath: string },
  index: unknown,
  markdown: string
): void => {
  mkdirSync(paths.dir, { recursive: true });
  writeFileWithStableBackup(paths.jsonPath, `${JSON.stringify(index, null, 2)}\n`);
  writeFileWithStableBackup(paths.markdownPath, markdown);
};

export const TOOL_HANDLER_MODULES: ToolHandlerModule[] = [
  {
    name: "session",
    invoke: (ctx) =>
      handleSessionTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        dryRun: ctx.dryRun,
        startedAt: ctx.startedAt,
        buildPreflightReport,
        checkSyncronaCapabilities,
        makeDryRunAuditResponse: ctx.makeDryRunAuditResponse,
        auditMutatingTool: ctx.auditMutatingTool,
      }),
  },
  {
    name: "workspace",
    invoke: (ctx) =>
      handleWorkspaceTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        dryRun: ctx.dryRun,
        startedAt: ctx.startedAt,
        allowFullNodeAccess: getEffectiveAllowFullNodeAccess(ctx.guardrailConfig),
        runSyncroCliCommand,
        runCommand,
        isUnsafeWorkspaceCommand,
        makeDryRunAuditResponse: ctx.makeDryRunAuditResponse,
        auditMutatingTool: ctx.auditMutatingTool,
      }),
  },
  {
    name: "servicenow-crud",
    invoke: (ctx) =>
      handleServiceNowCrudTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        dryRun: ctx.dryRun,
        startedAt: ctx.startedAt,
        createAndSyncScriptInclude,
        makeDryRunAuditResponse: ctx.makeDryRunAuditResponse,
        auditMutatingTool: ctx.auditMutatingTool,
      }),
  },
  {
    name: "insight",
    invoke: (ctx) =>
      handleInsightTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
      }),
  },
  {
    name: "metadata-analysis",
    invoke: (ctx) =>
      handleMetadataAnalysisTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        dryRun: ctx.dryRun,
        startedAt: ctx.startedAt,
        projectDir: PROJECT_DIR,
        parseMetadataType,
        makeDryRunAuditResponse: ctx.makeDryRunAuditResponse,
        auditMutatingTool: ctx.auditMutatingTool,
        getLastSemanticIndex: () => getSemanticIndex(PROJECT_DIR),
        setLastSemanticIndex: (rows) => {
          setSemanticIndex(rows);
        },
      }),
  },
  {
    name: "script-analysis",
    invoke: (ctx) =>
      handleScriptAnalysisTool(ctx.toolName, ctx.args, {
        dryRun: ctx.dryRun,
        startedAt: ctx.startedAt,
        makeDryRunAuditResponse: ctx.makeDryRunAuditResponse,
        auditMutatingTool: ctx.auditMutatingTool,
      }),
  },
  {
    name: "health-planning",
    invoke: (ctx) =>
      handleHealthPlanningTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        contractVersion: TOOL_CONTRACT_VERSION,
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        getDeclaredToolNames: () =>
          MCP_TOOLS
            .map((item) => toStringField(asRecord(item).name))
            .filter((name) => name.length > 0),
        getDeclaredTools: () => MCP_TOOLS.map((item) => asRecord(item)),
        getToolMetrics: () => [...getToolMetrics()],
        getHealthEndpointStatus,
        checkSyncronaCapabilities,
        toGraphFromUnknown,
      }),
  },
  {
    name: "scope-knowledge",
    invoke: (ctx) =>
      handleScopeKnowledgeTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        dryRun: ctx.dryRun,
        resolveScopeCode,
        hydrateScopeKnowledgeInputs,
        safeGetSessionContext,
        asRecord,
        toGraphFromUnknown,
        writeJsonAndMarkdown,
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
      }),
  },
  {
    name: "relation-onboarding",
    invoke: (ctx) =>
      handleRelationOnboardingTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        projectDir: PROJECT_DIR,
        guardrailConfigFile: GUARDRAIL_CONFIG_FILE,
        resolveScopeCode,
        hydrateScopeKnowledgeInputs,
        toGraphFromUnknown,
        classifyRelationVisibility,
        existsSync,
        joinPath: path.join,
      }),
  },
  {
    name: "workflow",
    invoke: (ctx) =>
      handleWorkflowTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        startedAt: ctx.startedAt,
        parseUnifiedTaskType,
        isDeepAnalysisSatisfied,
        buildPreflightReport,
        asRecord,
        toGraphFromUnknown,
        safeGetSessionContext,
        toStringField,
        writeJsonAndMarkdown,
        runRemoteScript: (script, resolvedTimeoutMs, endpointPath) =>
          runBackgroundScript(script, resolvedTimeoutMs, endpointPath, PROJECT_DIR),
        auditMutatingTool: ctx.auditMutatingTool,
      }),
  },
  {
    name: "developer",
    invoke: (ctx) =>
      handleDeveloperTool(ctx.toolName, ctx.args, {
        timeoutMs: ctx.timeoutMs,
        projectDir: PROJECT_DIR,
        sourceDirectory: getSourceDirectory(PROJECT_DIR),
        resolveScope: (preferredScope) => resolveScopeCode(preferredScope, ctx.timeoutMs),
        tableGet,
      }),
  },
];

/** Binds the module registry to one request context for the dispatcher. */
export function buildToolHandlerPipeline(
  ctx: ToolModuleContext
): Array<ToolHandlerInvocation> {
  return TOOL_HANDLER_MODULES.map((module) => () => module.invoke(ctx));
}
