import { buildOnboardingPlan } from "../analysis";
import { normalizeScopeCode } from "../scopePaths";
import { toJsonText } from "../runtimeUtils";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type GraphNode = {
  id: string;
  kind: "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope";
  label: string;
};

type GraphEdge = {
  from: string;
  to: string;
  relation: "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency";
  why: string;
};

type RelationOnboardingContext = {
  timeoutMs: number;
  projectDir: string;
  guardrailConfigFile: string;
  resolveScopeCode: (scopeArg: string, timeoutMs: number) => Promise<string>;
  hydrateScopeKnowledgeInputs: (
    entities: Array<Record<string, unknown>>,
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    scopeCode: string,
    timeoutMs: number
  ) => Promise<{ graph: { nodes: GraphNode[]; edges: GraphEdge[] }; sourceSummary: Record<string, unknown> }>;
  toGraphFromUnknown: (value: unknown) => { nodes: GraphNode[]; edges: GraphEdge[] };
  classifyRelationVisibility: (edge: GraphEdge) => "explicit" | "hidden" | "inferred";
  existsSync: (path: string) => boolean;
  joinPath: (...parts: string[]) => string;
};

export async function handleRelationOnboardingTool(
  toolName: string,
  args: Record<string, unknown>,
  context: RelationOnboardingContext
): Promise<ToolResponse | null> {
  const { timeoutMs } = context;

  switch (toolName) {
    case "sync_analyze_scope_relations": {
      const scopeArg = typeof args.scope === "string" ? args.scope.trim() : "";
      const scope = await context.resolveScopeCode(scopeArg, timeoutMs);
      const includeWorkspace = args.includeWorkspace !== false;
      const includeServiceNow = args.includeServiceNow !== false;

      const hydrated = await context.hydrateScopeKnowledgeInputs([], context.toGraphFromUnknown({}), scope, timeoutMs);
      const relations = hydrated.graph.edges
        .map((edge) => {
          const source = edge.from;
          const target = edge.to;
          return {
            source,
            target,
            relation: edge.relation,
            why: edge.why,
            visibility: context.classifyRelationVisibility(edge),
            sourceKind: source.startsWith("table:") ? "table" : source.startsWith("file:") ? "file" : "record",
            targetKind: target.startsWith("table:") ? "table" : target.startsWith("file:") ? "file" : "record",
          };
        })
        .filter((row) => {
          if (!includeWorkspace && (String(row.source).startsWith("file:") || String(row.target).startsWith("file:"))) {
            return false;
          }
          if (!includeServiceNow && String(row.why).toLowerCase().includes("dictionary")) {
            return false;
          }
          return true;
        });

      const relationEvidence = relations.reduce(
        (acc, row) => {
          const visibility = row.visibility;
          if (visibility === "explicit" || visibility === "hidden" || visibility === "inferred") {
            acc[visibility] += 1;
          }
          return acc;
        },
        { explicit: 0, hidden: 0, inferred: 0 }
      );

      const tableSet = new Set<string>();
      for (const node of hydrated.graph.nodes) {
        if (node.kind === "table" && node.id.startsWith("table:")) {
          tableSet.add(node.id.replace(/^table:/, ""));
        }
      }
      for (const row of relations) {
        if (row.sourceKind === "table") {
          tableSet.add(String(row.source).replace(/^table:/, ""));
        }
        if (row.targetKind === "table") {
          tableSet.add(String(row.target).replace(/^table:/, ""));
        }
      }

      const payload = {
        scope: normalizeScopeCode(scope),
        includeWorkspace,
        includeServiceNow,
        sourceSummary: hydrated.sourceSummary,
        tables: [...tableSet.values()].sort(),
        relationEvidence,
        relationCount: relations.length,
        relations,
      };

      return {
        isError: relations.length === 0,
        content: [{ type: "text", text: toJsonText(payload) }],
      };
    }

    case "sync_onboarding_bootstrap": {
      const hasEnv = context.existsSync(context.joinPath(context.projectDir, ".env"));
      const hasGuardrails = context.existsSync(context.guardrailConfigFile);
      const scopesDir = context.joinPath(context.projectDir, ".syncrona-mcp", "scopes");
      const hasScopeKnowledge = context.existsSync(scopesDir);
      const onboarding = buildOnboardingPlan({
        hasEnv,
        hasGuardrails,
        hasScopeKnowledge,
      });
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(onboarding) }],
      };
    }

    default:
      return null;
  }
}
