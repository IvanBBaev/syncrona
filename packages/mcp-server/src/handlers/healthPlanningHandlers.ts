import {
  buildTableApiCoverageMatrix,
  computeMetricTrend,
  hashToolContract,
  rankMinimalFootprintTargets,
  summarizeMetrics,
  summarizeMetricsWindows,
  type ToolMetricEvent,
} from "../analysis";
import { toJsonText } from "../runtimeUtils";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type HealthPlanningContext = {
  timeoutMs: number;
  contractVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  getDeclaredToolNames: () => string[];
  getDeclaredTools?: () => Array<Record<string, unknown>>;
  getToolMetrics: () => ToolMetricEvent[];
  getHealthEndpointStatus?: () => Record<string, unknown>;
  checkSyncronaCapabilities: (timeoutMs: number) => Promise<Record<string, unknown>>;
  toGraphFromUnknown: (value: unknown) => {
    nodes: Array<{ id: string; kind: "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope"; label: string }>;
    edges: Array<{
      from: string;
      to: string;
      relation: "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency";
      why: string;
    }>;
  };
};

type AiActionTemplate = {
  id: string;
  title: string;
  tool: string;
  reason: string;
  dryRunFirst?: boolean;
  args: Record<string, unknown>;
  triggerKeywords: string[];
  baseScore: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeToolLifecycleMetadata(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  const version = typeof raw.version === "string" && raw.version.trim()
    ? raw.version.trim()
    : "1.0.0";
  const deprecated = raw.deprecated === true;
  const out: Record<string, unknown> = {
    version,
    deprecated,
  };

  const replacedBy = typeof raw.replacedBy === "string" ? raw.replacedBy.trim() : "";
  if (replacedBy) {
    out.replacedBy = replacedBy;
  }
  const deprecationReason = typeof raw.deprecationReason === "string" ? raw.deprecationReason.trim() : "";
  if (deprecationReason) {
    out.deprecationReason = deprecationReason;
  }
  const sunsetDate = typeof raw.sunsetDate === "string" ? raw.sunsetDate.trim() : "";
  if (sunsetDate) {
    out.sunsetDate = sunsetDate;
  }

  return out;
}

function tokenizeForPlanning(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u0400-\u04ff_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function scoreActionTemplate(template: AiActionTemplate, objectiveTokens: Set<string>): number {
  const matchCount = template.triggerKeywords.reduce((count, keyword) => {
    return count + (objectiveTokens.has(keyword) ? 1 : 0);
  }, 0);
  return template.baseScore + matchCount;
}

function buildAiActionTemplates(objective: string): AiActionTemplate[] {
  const isPushLike = /\b(push|deploy|apply|release|промени|деплой|публикувай)\b/i.test(objective);
  return [
    {
      id: "tool-contract",
      title: "Inspect tool contract and capabilities",
      tool: "sync_tool_contract_info",
      reason: "Aligns AI orchestration with current MCP tool surface and versions.",
      args: {},
      triggerKeywords: ["tool", "contract", "capabilities", "capability", "versions", "възможности"],
      baseScore: 2,
    },
    {
      id: "session-prepare",
      title: "Prepare scope and update-set context",
      tool: "sync_prepare_session",
      reason: "Reduces session drift before analysis or mutation flows.",
      args: {
        expectedScope: "",
        expectedUpdateSetName: "",
        createUpdateSetIfMissing: true,
      },
      triggerKeywords: ["scope", "session", "update", "set", "context", "контекст", "скоуп", "ъпдейт"],
      baseScore: 3,
    },
    {
      id: "capability-check",
      title: "Check instance endpoint readiness",
      tool: "sync_check_instance_capabilities",
      reason: "Validates scoped endpoint support before advanced automation.",
      args: {},
      triggerKeywords: ["endpoint", "instance", "capabilities", "readiness", "готовност", "инстанс"],
      baseScore: 3,
    },
    {
      id: "dependency-graph",
      title: "Build dependency graph for impact-aware planning",
      tool: "sn_build_dependency_graph",
      reason: "Creates structural context so AI can minimize blast radius.",
      args: {
        includeWorkspace: true,
      },
      triggerKeywords: ["dependency", "graph", "impact", "dependencies", "връзки", "зависимости"],
      baseScore: 2,
    },
    {
      id: "minimal-footprint",
      title: "Rank minimal-footprint implementation targets",
      tool: "sync_plan_minimal_footprint",
      reason: "Prioritizes low-risk, high-confidence change points.",
      args: {
        task: objective,
        graph: {},
        limit: 5,
      },
      triggerKeywords: ["plan", "target", "minimal", "footprint", "task", "план", "минимален"],
      baseScore: 4,
    },
    {
      id: "preflight",
      title: "Run preflight guardrails before mutation",
      tool: "sync_preflight_check",
      reason: "Prevents unsafe writes when scope/update-set drift is present.",
      args: {},
      triggerKeywords: ["push", "deploy", "apply", "mutate", "write", "пуш", "деплой", "промени"],
      baseScore: isPushLike ? 5 : 1,
    },
    {
      id: "health",
      title: "Collect runtime health telemetry",
      tool: "sync_health_check",
      reason: "Captures baseline reliability state before long workflows.",
      args: {},
      triggerKeywords: ["health", "reliability", "metrics", "стабилност", "метрики"],
      baseScore: 1,
    },
  ];
}

function buildAiNextActions(
  objective: string,
  maxSteps: number,
  declaredToolNames: string[]
): Array<Record<string, unknown>> {
  const objectiveTokens = new Set(tokenizeForPlanning(objective));
  const declared = new Set(declaredToolNames);

  const ranked = buildAiActionTemplates(objective)
    .filter((template) => declared.has(template.tool))
    .map((template) => ({
      template,
      score: scoreActionTemplate(template, objectiveTokens),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.template.title.localeCompare(b.template.title);
    })
    .slice(0, maxSteps);

  return ranked.map((entry, index) => ({
    step: index + 1,
    id: entry.template.id,
    title: entry.template.title,
    tool: entry.template.tool,
    reason: entry.template.reason,
    recommendedArgs: entry.template.args,
    dryRunFirst: entry.template.dryRunFirst === true || entry.template.tool === "sync_preflight_check",
    confidence: Math.min(0.99, 0.55 + entry.score * 0.08),
  }));
}

export async function handleHealthPlanningTool(
  toolName: string,
  args: Record<string, unknown>,
  context: HealthPlanningContext
): Promise<ToolResponse | null> {
  const { timeoutMs } = context;

  switch (toolName) {
    case "sync_health_check": {
      const capabilities = await context.checkSyncronaCapabilities(timeoutMs);
      const metrics = summarizeMetrics(context.getToolMetrics());
      const httpEndpoint = context.getHealthEndpointStatus
        ? context.getHealthEndpointStatus()
        : { enabled: false };
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: toJsonText({
              status: "ok",
              metrics,
              httpEndpoint,
              diagnosticsTimeline: Object.entries(capabilities).map(([k, v]) => ({ check: k, ...(asRecord(v)) })),
            }),
          },
        ],
      };
    }

    case "sync_metrics_trend": {
      const windows = summarizeMetricsWindows(context.getToolMetrics().slice(-200), 20);
      const previous = windows.length >= 2
        ? asRecord(windows[windows.length - 2])
        : { failureRatio: 0, avgLatencyMs: 0 };
      const current = windows.length >= 1
        ? asRecord(windows[windows.length - 1])
        : { failureRatio: 0, avgLatencyMs: 0 };
      const trend = computeMetricTrend(previous, current);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ previous, current, trend }) }],
      };
    }

    case "sync_tool_contract_info": {
      const declaredTools = context.getDeclaredTools
        ? context.getDeclaredTools()
        : context.getDeclaredToolNames().map((name) => ({ name }));
      const lifecycleByTool = new Map<string, Record<string, unknown>>();
      for (const item of declaredTools) {
        const record = asRecord(item);
        const name = typeof record.name === "string" ? record.name : "";
        if (!name) {
          continue;
        }
        lifecycleByTool.set(name, normalizeToolLifecycleMetadata(record.metadata));
      }
      const toolNames = [...new Set(context.getDeclaredToolNames())]
        .filter((name) => name.length > 0)
        .sort((a, b) => a.localeCompare(b));
      const lifecycle: Array<Record<string, unknown>> = toolNames.map((name) => ({
        name,
        ...normalizeToolLifecycleMetadata(lifecycleByTool.get(name)),
      }));
      const deprecatedTools = lifecycle
        .filter((item) => asRecord(item).deprecated === true)
        .map((item) => String(asRecord(item).name || ""))
        .filter((name) => name.length > 0);
      return {
        isError: false,
        content: [{
          type: "text",
          text: toJsonText({
            contractVersion: context.contractVersion,
            server: context.serverInfo,
            tools: {
              count: toolNames.length,
              hash: hashToolContract(toolNames),
              names: toolNames,
              lifecycle,
              deprecatedCount: deprecatedTools.length,
              deprecatedTools,
            },
          }),
        }],
      };
    }

    case "sync_table_api_coverage_matrix": {
      const rows = buildTableApiCoverageMatrix();
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ count: rows.length, rows }) }],
      };
    }

    case "sync_plan_minimal_footprint": {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: task" }],
        };
      }

      const graph = context.toGraphFromUnknown(args.graph);
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 20)
          : 5;
      const options = rankMinimalFootprintTargets(task, graph, limit);
      return {
        isError: options.length === 0,
        content: [{ type: "text", text: toJsonText({ task, count: options.length, options }) }],
      };
    }

    case "sync_ai_next_actions": {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: objective" }],
        };
      }

      const maxSteps = typeof args.maxSteps === "number" && Number.isFinite(args.maxSteps)
        ? Math.min(Math.max(Math.floor(args.maxSteps), 1), 10)
        : 5;
      const nextActions = buildAiNextActions(objective, maxSteps, context.getDeclaredToolNames());

      return {
        isError: nextActions.length === 0,
        content: [{
          type: "text",
          text: toJsonText({
            objective,
            maxSteps,
            count: nextActions.length,
            nextActions,
          }),
        }],
      };
    }

    default:
      return null;
  }
}
