#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
} from "fs";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isMutatingTool,
  isUnsafeWorkspaceCommand,
} from "./safetyPolicy";
import { checkAuditLogIntegrity } from "./audit";
import { logger } from "./logger";
import { loadMetricEvents } from "./metricsStore";
import { validateToolArguments } from "./inputValidation";
import {
  formatStructuredToolError,
  isDryRunRequested,
} from "./runtimeUtils";
import { McpError, normalizeMcpError } from "./errors";
import { runBackgroundScript } from "./servicenowCore";
import { tableGet } from "./sessionContext";
import { MCP_TOOLS, getToolLifecycleMetadata } from "./toolSchemas";
import { dispatchToolPipeline, type ToolHandlerInvocation } from "./toolDispatch";
import { getScopeDocsPaths, getScopeTableDocPath } from "./scopePaths";
import {
  classifyRelationVisibility,
  toGraphFromUnknown,
  hydrateScopeKnowledgeInputs,
} from "./analysis/scopeDiscovery";
import {
  evaluateToolPolicy,
  getEffectiveAllowFullNodeAccess,
} from "./policyConfig";
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
  AUDIT_DIR,
  AUDIT_FILE,
  GUARDRAIL_CONFIG_FILE,
  METRICS_FILE,
  PROJECT_DIR,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_CONTRACT_VERSION,
} from "./runtimeConfig";
import {
  getSemanticIndex,
  invalidateSemanticIndex,
  setSemanticIndex,
} from "./semanticIndexState";
import {
  closeResource,
  createGracefulShutdownController,
  type CloseableResource,
  type GracefulShutdownController,
} from "./gracefulShutdown";
import {
  getHealthEndpointStatus,
  parseHealthHttpConfig,
  startHealthHttpServer,
} from "./healthServer";
import { asRecord, toStringField } from "./recordUtils";
import {
  runCommand,
  runSyncroCliCommand,
} from "./processRunner";
import { autoPullAllScopesAndData } from "./scopeBootstrap";import {
  TOOL_METRICS,
  auditMutatingTool,
  auditToolCall,
  buildHealthHttpSnapshot,
  buildPreflightReport,
  checkSyncronaCapabilities,
  createAndSyncScriptInclude,
  enforcePreflightForTool,
  getSourceDirectory,
  isDeepAnalysisSatisfied,
  loadGuardrailConfig,
  makeDryRunAuditResponse,
  normalizeTimeout,
  parseMetadataType,
  parseUnifiedTaskType,
  recordToolMetric,
  resolveCorrelationId,
  resolveScopeCode,
  safeGetSessionContext,
  setAuditIntegrityStatus,
  shouldInvalidateSemanticIndex,
  withCorrelationIdInResponse,
  writeFileWithStableBackup,
} from "./toolService";
export * from "./publicApi";

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const shutdownController = createGracefulShutdownController({
  serverResource: server as CloseableResource,
  drainTimeoutMs: 5000,
  pollIntervalMs: 50,
  auditDir: AUDIT_DIR,
  auditFile: AUDIT_FILE,
});

/* node:coverage disable */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: MCP_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const rawArgs = asRecord(request.params.arguments);
  const requestStartedAt = Date.now();
  const correlationId = resolveCorrelationId(rawArgs, requestStartedAt);
  const timeoutMs = normalizeTimeout(rawArgs.timeoutMs);
  const toolName = request.params.name;
  logger.debug("tool.start", { correlationId, tool: toolName });
  const toolLifecycle = getToolLifecycleMetadata(toolName);
  if (toolLifecycle?.deprecated) {
    logger.warn("tool.deprecated", {
      correlationId,
      tool: toolName,
      version: toolLifecycle.version,
      replacedBy: toolLifecycle.replacedBy,
      sunsetDate: toolLifecycle.sunsetDate,
      reason: toolLifecycle.deprecationReason,
    });
  }
  const validation = validateToolArguments(toolName, rawArgs);
  if (!validation.valid) {
    const err = new McpError(`Invalid arguments for ${toolName}: ${validation.error}`, {
      code: "INVALID_ARGUMENTS",
      details: {
        toolName,
        correlationId,
      },
    });
    recordToolMetric(toolName, true, requestStartedAt, correlationId);
    return formatStructuredToolError(err.message, {
      code: err.code,
      details: err.details,
    });
  }

  const args = validation.normalizedArgs;
  const dryRun = isDryRunRequested(args);
  const startedAt = requestStartedAt;
  const requestMakeDryRunAuditResponse = (
    dryRunToolName: string,
    dryRunArgs: Record<string, unknown>,
    details: Record<string, unknown>
  ) => makeDryRunAuditResponse(dryRunToolName, dryRunArgs, details, correlationId);
  const requestAuditMutatingTool = (
    innerToolName: string,
    innerArgs: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => auditMutatingTool(innerToolName, innerArgs, outcome, durationMs, correlationId);
  const guardrailConfig = loadGuardrailConfig();
  const policyCheck = evaluateToolPolicy(guardrailConfig, toolName, args, dryRun);
  if (!policyCheck.allowed) {
    const err = new McpError(policyCheck.reason, {
      code: "POLICY_VIOLATION",
      details: {
        toolName,
        correlationId,
      },
    });
    recordToolMetric(toolName, true, startedAt, correlationId);
    return formatStructuredToolError(err.message, {
      code: err.code,
      details: err.details,
    });
  }

  if (!shutdownController.beginRequest()) {
    const err = new McpError("Server is shutting down and cannot accept new requests.", {
      code: "SHUTTING_DOWN",
      details: {
        toolName,
        correlationId,
      },
    });
    recordToolMetric(toolName, true, startedAt, correlationId);
    return formatStructuredToolError(err.message, {
      code: err.code,
      details: err.details,
    });
  }

  try {
    const isUnifiedPlanningCall =
      toolName === "sync_unified_change_workflow" && args.apply !== true;

    if (isMutatingTool(toolName) && !dryRun && !isUnifiedPlanningCall) {
      await enforcePreflightForTool(toolName, timeoutMs);
    }

    const handlerPipeline: Array<ToolHandlerInvocation> = [
      () => handleSessionTool(toolName, args, {
        timeoutMs,
        dryRun,
        startedAt,
        buildPreflightReport,
        checkSyncronaCapabilities,
        makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
        auditMutatingTool: requestAuditMutatingTool,
      }),
      () => handleWorkspaceTool(toolName, args, {
        timeoutMs,
        dryRun,
        startedAt,
        allowFullNodeAccess: getEffectiveAllowFullNodeAccess(guardrailConfig),
        runSyncroCliCommand,
        runCommand,
        isUnsafeWorkspaceCommand,
        makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
        auditMutatingTool: requestAuditMutatingTool,
      }),
      () => handleServiceNowCrudTool(toolName, args, {
        timeoutMs,
        dryRun,
        startedAt,
        createAndSyncScriptInclude,
        makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
        auditMutatingTool: requestAuditMutatingTool,
      }),
      () => handleInsightTool(toolName, args, {
        timeoutMs,
      }),
      () => handleMetadataAnalysisTool(toolName, args, {
        timeoutMs,
        dryRun,
        startedAt,
        projectDir: PROJECT_DIR,
        parseMetadataType,
        makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
        auditMutatingTool: requestAuditMutatingTool,
        getLastSemanticIndex: () => getSemanticIndex(PROJECT_DIR),
        setLastSemanticIndex: (rows) => {
          setSemanticIndex(rows);
        },
      }),
      () => handleScriptAnalysisTool(toolName, args, {
        dryRun,
        startedAt,
        makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
        auditMutatingTool: requestAuditMutatingTool,
      }),
      () => handleHealthPlanningTool(toolName, args, {
        timeoutMs,
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
        getToolMetrics: () => TOOL_METRICS,
        getHealthEndpointStatus,
        checkSyncronaCapabilities,
        toGraphFromUnknown,
      }),
      () => handleScopeKnowledgeTool(toolName, args, {
        timeoutMs,
        dryRun,
        resolveScopeCode,
        hydrateScopeKnowledgeInputs,
        safeGetSessionContext,
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
      }),
      () => handleRelationOnboardingTool(toolName, args, {
        timeoutMs,
        projectDir: PROJECT_DIR,
        guardrailConfigFile: GUARDRAIL_CONFIG_FILE,
        resolveScopeCode,
        hydrateScopeKnowledgeInputs,
        toGraphFromUnknown,
        classifyRelationVisibility,
        existsSync,
        joinPath: path.join,
      }),
      () => handleWorkflowTool(toolName, args, {
        timeoutMs,
        startedAt,
        parseUnifiedTaskType,
        isDeepAnalysisSatisfied,
        buildPreflightReport,
        asRecord,
        toGraphFromUnknown,
        safeGetSessionContext,
        toStringField,
        writeJsonAndMarkdown: (paths, index, markdown) => {
          mkdirSync(paths.dir, { recursive: true });
          writeFileWithStableBackup(paths.jsonPath, `${JSON.stringify(index, null, 2)}\n`);
          writeFileWithStableBackup(paths.markdownPath, markdown);
        },
        runRemoteScript: (script, resolvedTimeoutMs, endpointPath) =>
          runBackgroundScript(script, resolvedTimeoutMs, endpointPath, PROJECT_DIR),
        auditMutatingTool: requestAuditMutatingTool,
      }),
      () => handleDeveloperTool(toolName, args, {
        timeoutMs,
        projectDir: PROJECT_DIR,
        sourceDirectory: getSourceDirectory(PROJECT_DIR),
        resolveScope: (preferredScope) => resolveScopeCode(preferredScope, timeoutMs),
        tableGet,
      }),
    ];

    const response = await dispatchToolPipeline(handlerPipeline, () => ({
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    }));

    const responseWithCorrelation = withCorrelationIdInResponse(response, correlationId);
    const responseError =
      responseWithCorrelation.isError === true &&
      Array.isArray(responseWithCorrelation.content) &&
      responseWithCorrelation.content.length > 0
        ? String(asRecord(responseWithCorrelation.content[0]).text || "")
        : "";
    auditToolCall(
      toolName,
      args,
      { isError: responseWithCorrelation.isError === true, error: responseError },
      Date.now() - startedAt,
      AUDIT_DIR,
      AUDIT_FILE,
      correlationId
    );
    if (responseWithCorrelation.isError !== true && shouldInvalidateSemanticIndex(toolName, args)) {
      invalidateSemanticIndex(`tool:${toolName}`);
    }
    recordToolMetric(toolName, responseWithCorrelation.isError === true, startedAt, correlationId);
    logger.debug("tool.complete", {
      correlationId,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      isError: responseWithCorrelation.isError === true,
    });
    return responseWithCorrelation;
  } catch (error) {
    const normalized = normalizeMcpError(error);
    logger.error("tool.error", {
      correlationId,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      code: normalized.code,
      error: normalized.message,
    });
    auditToolCall(
      toolName,
      args,
      { isError: true, error: normalized.message },
      Date.now() - startedAt,
      AUDIT_DIR,
      AUDIT_FILE,
      correlationId
    );
    recordToolMetric(toolName, true, startedAt, correlationId);
    return formatStructuredToolError(normalized.message, {
      code: normalized.code,
      details: {
        ...normalized.details,
        toolName,
        correlationId,
      },
    });
  } finally {
    shutdownController.endRequest();
  }
});

function registerGracefulShutdownSignals(controller: GracefulShutdownController): void {
  const onSignal = (signal: string) => {
    void controller.shutdown(signal);
  };

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

async function main() {
  const persistedMetrics = loadMetricEvents(AUDIT_DIR, METRICS_FILE, 500);
  if (persistedMetrics.length > 0) {
    TOOL_METRICS.splice(0, TOOL_METRICS.length, ...persistedMetrics);
  }

  const integrity = checkAuditLogIntegrity(AUDIT_DIR, AUDIT_FILE);
  setAuditIntegrityStatus(integrity.status);
  if (integrity.status === "quarantined") {
    console.error(
      `Audit log integrity recovery applied; quarantined=${integrity.quarantinedFile}, malformedLines=${integrity.malformedLines}`
    );
  } else if (integrity.status === "error") {
    console.error("Audit log integrity check failed; continuing with best-effort audit mode");
  }

  await autoPullAllScopesAndData();

  const transport = new StdioServerTransport();
  const healthHttpConfig = parseHealthHttpConfig();
  const healthServer = await startHealthHttpServer(healthHttpConfig, buildHealthHttpSnapshot);
  shutdownController.setTransportResource({
    close: async () => {
      await closeResource(transport as CloseableResource);
      await closeResource(healthServer as CloseableResource);
    },
  });
  registerGracefulShutdownSignals(shutdownController);
  await server.connect(transport);
  console.error("Syncrona MCP server connected over stdio");
}

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}

/* node:coverage enable */

export { main };
