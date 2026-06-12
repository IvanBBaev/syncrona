import {
  analyzeArchitecture,
  analyzePerformance,
  analyzeSecurity,
  buildFullScriptAnalysisReport,
  runAutonomousRemediation,
} from "../analysis";
import { toJsonText } from "../runtimeUtils";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type ScriptAnalysisContext = {
  dryRun: boolean;
  startedAt: number;
  makeDryRunAuditResponse: (
    toolName: string,
    args: Record<string, unknown>,
    details: Record<string, unknown>
  ) => ToolResponse;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

export function handleScriptAnalysisTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ScriptAnalysisContext
): ToolResponse | null {
  const { dryRun, startedAt } = context;

  switch (toolName) {
    case "sn_analyze_script_architecture": {
      const script = typeof args.script === "string" ? args.script : "";
      return {
        isError: !script.trim(),
        content: [{ type: "text", text: toJsonText(analyzeArchitecture(script)) }],
      };
    }

    case "sn_analyze_script_security": {
      const script = typeof args.script === "string" ? args.script : "";
      return {
        isError: !script.trim(),
        content: [{ type: "text", text: toJsonText(analyzeSecurity(script)) }],
      };
    }

    case "sn_analyze_script_performance": {
      const script = typeof args.script === "string" ? args.script : "";
      return {
        isError: !script.trim(),
        content: [{ type: "text", text: toJsonText(analyzePerformance(script)) }],
      };
    }

    case "sn_analyze_script_full": {
      const script = typeof args.script === "string" ? args.script : "";
      const suppressedIds = Array.isArray(args.suppressedIds)
        ? args.suppressedIds.filter((item): item is string => typeof item === "string")
        : [];
      const nowIso = typeof args.nowIso === "string" ? args.nowIso : "";
      const report = buildFullScriptAnalysisReport(script, {
        suppressedIds,
        policy: args.policy,
        nowIso: nowIso || undefined,
      });
      return {
        isError: !script.trim(),
        content: [{ type: "text", text: toJsonText(report) }],
      };
    }

    case "sn_autonomous_remediation_workflow": {
      const script = typeof args.script === "string" ? args.script : "";
      const apply = args.apply === true;
      const confirmDestructive = args.confirmDestructive === true;
      if (apply && !confirmDestructive) {
        return {
          isError: true,
          content: [{ type: "text", text: "Apply mode requires confirmDestructive=true." }],
        };
      }

      const remediation = runAutonomousRemediation(script, { apply, dryRun });
      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          findingsCount: remediation.findingsCount,
          patchPlan: remediation.patchPlan,
        });
      }

      if (apply) {
        context.auditMutatingTool(toolName, args, remediation, Date.now() - startedAt);
      }
      return {
        isError: !script.trim(),
        content: [{ type: "text", text: toJsonText(remediation) }],
      };
    }

    default:
      return null;
  }
}
