#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isMutatingTool } from "./safetyPolicy";
import { checkAuditLogIntegrity } from "./audit";
import { logger } from "./logger";
import { loadMetricEvents } from "./metricsStore";
import { validateToolArguments } from "./inputValidation";
import {
  formatStructuredToolError,
  isDryRunRequested,
} from "./runtimeUtils";
import { McpError, normalizeMcpError } from "./errors";
import { MCP_TOOLS, getToolLifecycleMetadata } from "./toolSchemas";
import { dispatchToolPipeline } from "./toolDispatch";
import { buildToolHandlerPipeline } from "./toolModules";
import { evaluateToolPolicy } from "./policyConfig";
import {
  AUDIT_DIR,
  AUDIT_FILE,
  METRICS_FILE,
  SERVER_NAME,
  SERVER_VERSION,
} from "./runtimeConfig";
import { invalidateSemanticIndex } from "./semanticIndexState";
import {
  closeResource,
  createGracefulShutdownController,
  type CloseableResource,
  type GracefulShutdownController,
} from "./gracefulShutdown";
import {
  parseHealthHttpConfig,
  startHealthHttpServer,
} from "./healthServer";
import { asRecord } from "./recordUtils";
import { autoPullAllScopesAndData } from "./scopeBootstrap";
import {
  TOOL_METRICS,
  auditMutatingTool,
  auditToolCall,
  buildHealthHttpSnapshot,
  enforcePreflightForTool,
  loadGuardrailConfig,
  makeDryRunAuditResponse,
  normalizeTimeout,
  recordToolMetric,
  resolveCorrelationId,
  setAuditIntegrityStatus,
  shouldInvalidateSemanticIndex,
  withCorrelationIdInResponse,
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

    // The handler modules live in the TOOL_HANDLER_MODULES registry
    // (toolModules.ts); this orchestrator only binds them to the request.
    const handlerPipeline = buildToolHandlerPipeline({
      toolName,
      args,
      timeoutMs,
      dryRun,
      startedAt,
      guardrailConfig,
      makeDryRunAuditResponse: requestMakeDryRunAuditResponse,
      auditMutatingTool: requestAuditMutatingTool,
    });

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
  console.error("SyncroNow AI MCP server connected over stdio");

  // The network-heavy scope bootstrap runs after the stdio handshake so a
  // slow instance cannot time out the MCP client connection. It logs to
  // stderr only, so it is safe alongside the JSON-RPC stdout stream.
  void autoPullAllScopesAndData().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Auto scope pull failed: ${message}`);
  });
}

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}

/* node:coverage enable */

export { main };
