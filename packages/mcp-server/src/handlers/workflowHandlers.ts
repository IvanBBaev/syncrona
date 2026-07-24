// SPDX-License-Identifier: GPL-3.0-or-later
import type { UnifiedTaskType } from "../toolService";
import type { GraphNode, GraphEdge } from "../analysis/graph";
import {
  buildDependencyGraph,
  buildFullScriptAnalysisReport,
  buildScopeKnowledgeIndex,
  rankMinimalFootprintTargets,
  renderFullAnalysisMarkdown,
  renderScopeKnowledgeMarkdown,
  runAutonomousRemediation,
  validateScopeKnowledgeIndex,
} from "../analysis";
import {
  evaluateMinimalFootprint,
  getApprovalRequirements,
  isApprovalSatisfied,
  maxRiskLevel,
  parseRiskLevel,
  riskLevelFromScore,
  validateRollbackEvidence,
} from "../safetyPolicy";
import type { RiskLevel } from "../safetyPolicy";
import { getScopeKnowledgePaths, getWorkflowSimulationReportPaths } from "../scopePaths";
import { toJsonText } from "../runtimeUtils";
import { isSafeRemoteEndpoint } from "../endpointPolicy";

import type { ToolResponse } from "../toolResponse";




type WorkflowContext = {
  timeoutMs: number;
  startedAt: number;
  parseUnifiedTaskType: (value: unknown) => UnifiedTaskType;
  isDeepAnalysisSatisfied: (taskType: UnifiedTaskType, hasScript: boolean, hasMetadata: boolean) => boolean;
  buildPreflightReport: (timeoutMs: number) => Promise<Record<string, unknown>>;
  asRecord: (value: unknown) => Record<string, unknown>;
  toGraphFromUnknown: (value: unknown) => { nodes: GraphNode[]; edges: GraphEdge[] };
  safeGetSessionContext: (timeoutMs: number) => Promise<Record<string, unknown> | null>;
  toStringField: (value: unknown) => string;
  writeJsonAndMarkdown: (paths: { dir: string; jsonPath: string; markdownPath: string }, index: unknown, markdown: string) => void;
  runRemoteScript: (
    script: string,
    timeoutMs: number,
    endpointPath?: string
  ) => Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }>;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

function toRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

/** REV-88 (SEC-7): outcome of verifying an approval against the instance. */
export type ApprovalVerificationStatus = "not-required" | "verified" | "unverifiable";

export type ApprovalVerification = {
  status: ApprovalVerificationStatus;
  reason: string;
};

/**
 * REV-88 (SEC-7): approval verification seam.
 *
 * The workflow's approval gate (`approvalOk`, from `isApprovalSatisfied`) is
 * computed purely from the caller-supplied `approval` object — a self-attestation.
 * A caller can fabricate `{ approvalId, approvers: [...] }` and satisfy the gate
 * without any real approval record existing on the instance. This function is the
 * seam where a genuine approval would be confirmed against ServiceNow (e.g.
 * sysapproval_approver / a change_request in an approved state) before a mutation
 * is applied.
 *
 * Only the OFFLINE half is implemented here. With no transport wired in, an
 * approval that is *required* for the risk level cannot be confirmed, so it is
 * reported as "unverifiable" and the apply path refuses rather than trusting the
 * self-attestation. When approval is not required (low risk), the status is
 * "not-required" and apply may proceed. The live lookup that would return
 * "verified" is intentionally out of scope here (it is live-gated) and left as the
 * seam for the transport implementation.
 */
export function verifyApprovalAgainstInstance(
  approval: Record<string, unknown>,
  riskLevel: RiskLevel
): ApprovalVerification {
  const requirements = getApprovalRequirements(riskLevel);
  const required = (requirements as { required?: unknown }).required === true;
  if (!required) {
    return {
      status: "not-required",
      reason: `Risk level "${riskLevel}" does not require approval.`,
    };
  }

  // Approval is required for this risk level. The provided approval is
  // self-attested; offline there is no transport to confirm it corresponds to a
  // real, approved record on the instance, so it is unverifiable.
  const approvalId = typeof approval.approvalId === "string" ? approval.approvalId.trim() : "";
  return {
    status: "unverifiable",
    reason:
      `Approval is required for risk level "${riskLevel}" but could not be verified ` +
      `against the instance offline. The provided approval` +
      (approvalId ? ` "${approvalId}"` : "") +
      ` is self-attested; a live approval lookup is required before applying this change.`,
  };
}

function slugifyText(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function buildUnifiedSimulationMarkdown(report: Record<string, unknown>): string {
  const workflow = (report.workflow && typeof report.workflow === "object")
    ? (report.workflow as Record<string, unknown>)
    : {};
  const gates = (report.gates && typeof report.gates === "object")
    ? (report.gates as Record<string, unknown>)
    : {};
  const risk = (report.risk && typeof report.risk === "object")
    ? (report.risk as Record<string, unknown>)
    : {};
  const approval = (report.approval && typeof report.approval === "object")
    ? (report.approval as Record<string, unknown>)
    : {};
  const minimalFootprint = (report.minimalFootprint && typeof report.minimalFootprint === "object")
    ? (report.minimalFootprint as Record<string, unknown>)
    : {};
  const rollback = (report.rollback && typeof report.rollback === "object")
    ? (report.rollback as Record<string, unknown>)
    : {};

  return [
    "# Unified Workflow Simulation Report",
    "",
    `- reportVersion: ${String(report.reportVersion || "1.0.0")}`,
    `- generatedAt: ${String(report.generatedAt || "")}`,
    `- simulationId: ${String(report.simulationId || "")}`,
    "",
    "## Workflow",
    `- task: ${String(workflow.task || "")}`,
    `- taskType: ${String(workflow.taskType || "")}`,
    `- executionMode: ${String(workflow.executionMode || "")}`,
    `- applyRequested: ${String(workflow.applyRequested === true)}`,
    "",
    "## Gates",
    `- preflightOk: ${String(gates.preflightOk === true)}`,
    `- deepAnalysisOk: ${String(gates.deepAnalysisOk === true)}`,
    `- approvalOk: ${String(gates.approvalOk === true)}`,
    `- footprintOk: ${String(gates.footprintOk === true)}`,
    `- rollbackOk: ${String(gates.rollbackOk === true)}`,
    `- readyForApply: ${String(gates.readyForApply === true)}`,
    "",
    "## Risk",
    `- level: ${String(risk.level || "")}`,
    `- score: ${String(risk.score ?? 0)}`,
    "",
    "## Approval",
    `- satisfied: ${String(approval.satisfied === true)}`,
    "",
    "## Minimal Footprint",
    `- withinBudget: ${String(minimalFootprint.withinBudget === true)}`,
    `- fileCount: ${String(minimalFootprint.fileCount ?? 0)}`,
    `- estimatedLines: ${String(minimalFootprint.estimatedLines ?? 0)}`,
    "",
    "## Rollback",
    `- ok: ${String(rollback.ok === true)}`,
  ].join("\n");
}

export async function handleWorkflowTool(
  toolName: string,
  args: Record<string, unknown>,
  context: WorkflowContext
): Promise<ToolResponse | null> {
  const { timeoutMs, startedAt } = context;

  switch (toolName) {
    case "sn_render_analysis_markdown": {
      const report = context.asRecord(args.report);
      const markdown = renderFullAnalysisMarkdown(report);
      return {
        isError: false,
        content: [{ type: "text", text: markdown }],
      };
    }

    case "sync_unified_change_workflow": {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const script = typeof args.script === "string" ? args.script : "";
      const taskType = context.parseUnifiedTaskType(args.taskType);
      const executionMode = args.executionMode === "remote" ? "remote" : "mocked";
      const allowRemoteApply = args.allowRemoteApply === true;
      const remoteScript = typeof args.remoteScript === "string" ? args.remoteScript : script;
      // SEC-7 (REV-122): in remote mode the executed script is remoteScript, not script.
      // Analyze whatever will actually run, so a malicious remoteScript cannot pass
      // analysis by hiding behind a benign `script`.
      const effectiveScript =
        executionMode === "remote" ? remoteScript : script;
      const remoteEndpoint = typeof args.remoteEndpoint === "string" ? args.remoteEndpoint.trim() : "";
      const apply = args.apply === true;
      const confirmDestructive = args.confirmDestructive === true;
      const nowIso = typeof args.nowIso === "string" ? args.nowIso : "";
      const writeSimulationReport = args.writeSimulationReport === true;
      const requestedSimulationId = typeof args.simulationId === "string" ? args.simulationId.trim() : "";

      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: task" }],
        };
      }

      if (apply && !confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Apply mode requires confirmDestructive=true.",
            },
          ],
        };
      }

      const preflight = await context.buildPreflightReport(timeoutMs);
      const preflightChecks = context.asRecord(preflight.checks);
      const preflightOk = preflightChecks.allOk === true;

      const workflowGraph = context.toGraphFromUnknown(args.graph);

      const analysis = effectiveScript.trim()
        ? buildFullScriptAnalysisReport(effectiveScript, {
            policy: args.policy,
            nowIso: nowIso || undefined,
          })
        : {
            findings: { active: [], suppressed: [] },
            risk: {
              active: { score: 0, distribution: { high: 0, medium: 0, low: 0 } },
              total: { score: 0, distribution: { high: 0, medium: 0, low: 0 } },
            },
            why: ["No script provided for deep analysis."],
          };

      const activeRisk = context.asRecord(context.asRecord(analysis).risk).active;
      const activeRiskObj = context.asRecord(activeRisk);
      const callerPolicyRiskScore =
        typeof activeRiskObj.score === "number" && Number.isFinite(activeRiskObj.score)
          ? activeRiskObj.score
          : 0;

      // SEC-7 follow-up (REV-125): the `analysis` above honors the caller-supplied
      // `args.policy` (custom weights / suppressions) for presentation, but the score
      // that GATES approval must not be caller-tunable. A payload of
      // `policy.weights = { high: 0, medium: 0, low: 0 }` (or blanket suppressions)
      // zeros the score, drops the risk to "low", and disables both the approval gate
      // and the REV-88 self-attestation refusal. Recompute a TRUSTED analysis of the
      // same effective script with NO caller policy — default weights (5/3/1), no
      // suppressions — and gate on the higher of the two scores. A caller may still
      // RAISE the risk (weights above default), never lower it below the trusted floor.
      const trustedAnalysis = effectiveScript.trim()
        ? buildFullScriptAnalysisReport(effectiveScript, {
            nowIso: nowIso || undefined,
          })
        : null;
      const trustedActiveRisk = context.asRecord(
        context.asRecord(context.asRecord(trustedAnalysis).risk).active
      );
      const trustedRiskScore =
        typeof trustedActiveRisk.score === "number" &&
        Number.isFinite(trustedActiveRisk.score)
          ? trustedActiveRisk.score
          : 0;
      const riskScore = Math.max(callerPolicyRiskScore, trustedRiskScore);

      const explicitRiskLevel = parseRiskLevel(args.riskLevel);
      // SEC-7 (REV-122/125): a caller may RAISE the risk but must never LOWER it below
      // the analyzer-computed score — otherwise `riskLevel:"low"` (or a zeroed policy)
      // disables the approval gate.
      const riskLevel = maxRiskLevel(
        explicitRiskLevel,
        riskLevelFromScore(riskScore)
      );
      const approval = context.asRecord(args.approval);
      const approvalRequirements = getApprovalRequirements(riskLevel);
      const approvalOk = isApprovalSatisfied(approval, riskLevel);

      const proposedChanges = toRecordArray(args.proposedChanges);
      const hasScript = effectiveScript.trim().length > 0;
      const hasMetadata =
        proposedChanges.length > 0 ||
        workflowGraph.nodes.length > 0 ||
        workflowGraph.edges.length > 0;
      const footprintBudget = context.asRecord(args.footprintBudget);
      const footprint = evaluateMinimalFootprint(proposedChanges, {
        maxFiles:
          typeof footprintBudget.maxFiles === "number" ? footprintBudget.maxFiles : undefined,
        maxLines:
          typeof footprintBudget.maxLines === "number" ? footprintBudget.maxLines : undefined,
        maxObjects:
          typeof footprintBudget.maxObjects === "number" ? footprintBudget.maxObjects : undefined,
      });

      const rollbackEvidence = context.asRecord(args.rollbackEvidence);
      const rollbackCheck = validateRollbackEvidence(rollbackEvidence, riskLevel);
      const deepAnalysisOk = context.isDeepAnalysisSatisfied(taskType, hasScript, hasMetadata);
      const footprintOk = footprint.withinBudget === true;
      const readyForApply =
        preflightOk && deepAnalysisOk && approvalOk && footprintOk && rollbackCheck.ok;

      const payload: Record<string, unknown> = {
        task,
        taskType,
        executionMode,
        gates: {
          preflightOk,
          deepAnalysisOk,
          approvalOk,
          footprintOk,
          rollbackOk: rollbackCheck.ok,
          readyForApply,
        },
        preflight,
        analysis,
        risk: {
          score: riskScore,
          level: riskLevel,
        },
        approval: {
          requirements: approvalRequirements,
          provided: approval,
        },
        minimalFootprint: footprint,
        rollback: {
          evidenceProvided: rollbackEvidence,
          validation: rollbackCheck,
        },
        analysisInputs: {
          hasScript,
          hasMetadata,
        },
        nextAction: readyForApply
          ? apply
            ? "apply"
            : "set apply=true and confirmDestructive=true to execute"
          : "fix failed gates and re-run workflow",
      };

      const generatedAt = nowIso || new Date(startedAt).toISOString();
      const simulationId = requestedSimulationId || `${taskType}-${slugifyText(task, "workflow-task")}`;
      const simulationReport = {
        reportVersion: "1.0.0",
        generatedAt,
        simulationId,
        workflow: {
          task,
          taskType,
          executionMode,
          applyRequested: apply,
        },
        gates: context.asRecord(payload.gates),
        risk: context.asRecord(payload.risk),
        approval: {
          satisfied: approvalOk,
          requirements: approvalRequirements,
        },
        minimalFootprint: footprint,
        rollback: {
          ok: rollbackCheck.ok,
          missing: rollbackCheck.missing,
        },
      };

      let simulationArtifact: Record<string, unknown> = {
        written: false,
      };

      if (writeSimulationReport) {
        const explicitScope = typeof args.scope === "string" ? args.scope.trim() : "";
        const sessionContext = await context.safeGetSessionContext(timeoutMs);
        const sessionScope = sessionContext
          ? context.toStringField(context.asRecord(sessionContext.scope).scope)
          : "";
        const scopeCode = explicitScope || sessionScope || "unknown_scope";
        const paths = getWorkflowSimulationReportPaths(scopeCode, simulationId);
        const markdown = buildUnifiedSimulationMarkdown(simulationReport as unknown as Record<string, unknown>);
        context.writeJsonAndMarkdown(paths, simulationReport, markdown);
        simulationArtifact = {
          written: true,
          scope: scopeCode,
          paths,
        };
      }

      payload.simulationReport = simulationReport;
      payload.simulationArtifact = simulationArtifact;

      if (!apply) {
        return {
          isError: false,
          content: [{ type: "text", text: toJsonText(payload) }],
        };
      }

      if (!readyForApply) {
        return {
          isError: true,
          content: [{ type: "text", text: toJsonText(payload) }],
        };
      }

      // REV-88 (SEC-7): the approval gate above (`approvalOk`) is satisfied purely
      // from the caller-supplied `approval` object — a self-attestation a caller can
      // fabricate. Before any mutation is applied, confirm the approval against the
      // instance. Offline this cannot be confirmed for a risk level that requires
      // approval, so refuse rather than trust the self-attestation. Low-risk changes
      // (no approval required) return "not-required" and proceed unchanged.
      const approvalVerification = verifyApprovalAgainstInstance(approval, riskLevel);
      payload.approvalVerification = approvalVerification;
      if (approvalVerification.status === "unverifiable") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toJsonText({
                ...payload,
                error:
                  "Refusing to apply: approval is self-attested and could not be verified " +
                  "against the instance. Workflow approval gates are not a substitute for a " +
                  "real approval record.",
                nextAction:
                  "verify the approval against the instance (live approval lookup) before applying",
              }),
            },
          ],
        };
      }

      if (executionMode === "remote") {
        if (!allowRemoteApply) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: toJsonText({
                  ...payload,
                  error: "Remote apply requires allowRemoteApply=true.",
                  nextAction: "set allowRemoteApply=true after operator validation",
                }),
              },
            ],
          };
        }

        if (!remoteScript.trim()) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: toJsonText({
                  ...payload,
                  error: "Remote apply requires script or remoteScript.",
                  nextAction: "provide script content for remote execution",
                }),
              },
            ],
          };
        }

        if (remoteEndpoint && !isSafeRemoteEndpoint(remoteEndpoint)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: toJsonText({
                  ...payload,
                  error: "remoteEndpoint must be a relative ServiceNow path like /api/x_scope/endpoint.",
                  nextAction: "use a relative endpoint path without protocol or querystring",
                }),
              },
            ],
          };
        }

        const remoteExecution = await context.runRemoteScript(
          remoteScript,
          timeoutMs,
          remoteEndpoint || undefined
        );
        const remoteOk = remoteExecution.status >= 200 && remoteExecution.status < 300;
        const result = {
          ...payload,
          executionMode,
          mutationApplied: remoteOk,
          remoteExecution: {
            status: remoteExecution.status,
            usedEndpoint: remoteExecution.usedEndpoint,
            textPreview: context.toStringField(remoteExecution.text).slice(0, 400),
          },
          nextAction: remoteOk
            ? "remote execution completed"
            : "inspect remote execution response and retry after fixing the issue",
        };
        context.auditMutatingTool(toolName, args, result, Date.now() - startedAt);
        return {
          isError: !remoteOk,
          content: [{ type: "text", text: toJsonText(result) }],
        };
      }

      const execution = runAutonomousRemediation(script, {
        apply: true,
        dryRun: false,
      });

      const updateScopeKnowledge = args.updateScopeKnowledge !== false;
      let scopeKnowledgeUpdate: Record<string, unknown> = {
        skipped: !updateScopeKnowledge,
      };

      if (updateScopeKnowledge) {
        const sessionContext = await context.safeGetSessionContext(timeoutMs);
        const contextScope = sessionContext
          ? context.toStringField(context.asRecord(sessionContext.scope).scope) || "unknown_scope"
          : "unknown_scope";
        const graphFromArgs = context.toGraphFromUnknown(args.graph);
        const generatedGraph =
          graphFromArgs.nodes.length > 0 || graphFromArgs.edges.length > 0
            ? graphFromArgs
            : buildDependencyGraph(
                proposedChanges.map((change, idx) => ({
                  id: context.toStringField(change.objectId) || `record:${idx + 1}`,
                  name: context.toStringField(change.objectId) || `record-${idx + 1}`,
                  script,
                  table: context.toStringField(change.tableName),
                }))
              );
        const recommendedEditTargets = rankMinimalFootprintTargets(task, generatedGraph, 8);
        const scopeIndex = buildScopeKnowledgeIndex({
          scope: contextScope,
          entities: proposedChanges,
          graph: generatedGraph,
          updateSetContext: context.asRecord(sessionContext ? sessionContext.updateSet : args.updateSetContext),
          recommendedEditTargets,
        });
        const scopeValidation = validateScopeKnowledgeIndex(scopeIndex);
        const scopeMarkdown = renderScopeKnowledgeMarkdown(scopeIndex);
        const paths = getScopeKnowledgePaths(contextScope);
        context.writeJsonAndMarkdown(paths, scopeIndex, scopeMarkdown);

        scopeKnowledgeUpdate = {
          trigger: "successful_change",
          paths,
          validation: scopeValidation,
          recommendedEditTargetsCount: recommendedEditTargets.length,
        };
      }

      const result = {
        ...payload,
        executionMode,
        execution,
        mutationApplied: executionMode === "mocked",
        scopeKnowledgeUpdate,
      };
      context.auditMutatingTool(toolName, args, result, Date.now() - startedAt);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(result) }],
      };
    }

    default:
      return null;
  }
}
