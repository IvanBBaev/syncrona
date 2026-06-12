/**
 * publicApi.ts — public re-export barrel for the MCP server package.
 *
 * This module centralizes the package's public surface so that `index.ts`
 * stays focused on runtime bootstrap (server wiring, request dispatch, and the
 * `main()` entry point). Consumers and the test suite import these symbols via
 * the package entry (`./index`), which re-exports this barrel with
 * `export * from "./publicApi"`.
 *
 * Keep this file declarative: only `export ... from "..."` statements belong
 * here. Add new public symbols to the appropriate block below.
 */

export {
  configureLogger,
  getLoggerConfig,
  logger,
  parseLogFormat,
  parseLogLevel,
} from "./logger";
export type { LogFields, LogFormat, LogLevel } from "./logger";

export {
  evaluateMinimalFootprint,
  getApprovalRequirements,
  isApprovalSatisfied,
  isMutatingTool,
  isUnsafeWorkspaceCommand,
  parseRiskLevel,
  riskLevelFromScore,
  validateRollbackEvidence,
} from "./safetyPolicy";
export type { RiskLevel } from "./safetyPolicy";
export {
  getScopeDocsPaths,
  getScopeKnowledgePaths,
  getScopeTableDocsPaths,
  getScopeTableDocPath,
  getWorkflowSimulationReportPaths,
  getTableDependencyReportPaths,
  normalizeScopeCode,
} from "./scopePaths";
export { sanitizeForAudit } from "./audit";
export { checkAuditLogIntegrity } from "./audit";
export {
  discoverWorkspaceScopeKnowledge,
  discoverWorkspaceScopeKnowledgeAsync,
} from "./analysis/scopeDiscovery";
export {
  getSemanticIndex,
  getSemanticIndexState,
  invalidateSemanticIndex,
} from "./semanticIndexState";
export { createGracefulShutdownController } from "./gracefulShutdown";
export {
  getHealthEndpointStatus,
  parseHealthHttpConfig,
  startHealthHttpServer,
} from "./healthServer";
export { asRecord } from "./recordUtils";
export { runCommand } from "./processRunner";
export {
  evaluateToolPolicy,
  getEffectiveAllowFullNodeAccess,
  parseGuardrailConfig,
  shouldEnforcePreflight,
} from "./policyConfig";
export {
  TABLE_NAME_REGEX,
  SYS_ID_REGEX,
  validateToolArguments,
} from "./inputValidation";
export {
  commandResultToText,
  formatToolError,
  formatStructuredToolError,
  isDryRunRequested,
  toJsonText,
  trimOutput,
} from "./runtimeUtils";
export { McpError, normalizeMcpError } from "./errors";
export {
  auditToolCall,
  buildPreflightReport,
  checkSyncronaCapabilities,
  executeMcpToolIntegration,
  findScriptIncludeLocalPaths,
  getSourceDirectory,
  loadGuardrailConfig,
  normalizeTimeout,
} from "./toolService";
export {
  cleanEnvValue,
  getServiceNowConfig,
  instanceToBaseUrl,
  parseDotEnv,
  resolveServiceNowSecrets,
  runBackgroundScript,
  snScopedApiRequest,
  shouldRetryStatus,
  snRequest,
  summarizeRows,
  toTableResultRows,
} from "./servicenowCore";
export {
  getSessionContext,
  listScopes,
  listUpdateSets,
  setCurrentScope,
  setCurrentUpdateSet,
} from "./sessionContext";
