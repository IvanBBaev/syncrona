// SPDX-License-Identifier: GPL-3.0-or-later
import type { GraphNode, GraphEdge } from "../analysis/graph";
import { buildOnboardingPlan } from "../analysis";
import { normalizeScopeCode } from "../scopePaths";
import { toJsonText } from "../runtimeUtils";

import type { ToolResponse } from "../toolResponse";



// Edges read from instance metadata (sys_db_object inheritance, sys_dictionary
// references and attribute hints), as opposed to ones parsed from workspace files.
function isServiceNowMetadataEdge(why: string): boolean {
  const text = why.toLowerCase();
  return text.includes("dictionary") || text.includes("servicenow table inheritance");
}

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
          if (!includeServiceNow && isServiceNowMetadataEdge(String(row.why))) {
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

      // With a source excluded, its tables come only through the kept relations;
      // the graph's own table nodes would list the excluded source's tables too.
      const tableSet = new Set<string>();
      if (includeWorkspace && includeServiceNow) {
        for (const node of hydrated.graph.nodes) {
          if (node.kind === "table" && node.id.startsWith("table:")) {
            tableSet.add(node.id.replace(/^table:/, ""));
          }
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

      // Discovery skips the instance for an unresolved scope without recording a
      // failure, so workspace edges alone would otherwise read as the full picture.
      const scopeUnresolved = includeServiceNow && normalizeScopeCode(scope) === "unknown_scope";
      const payload = {
        scope: normalizeScopeCode(scope),
        includeWorkspace,
        includeServiceNow,
        ...(scopeUnresolved
          ? {
              scopeUnresolved: true,
              note: "Could not resolve the application scope from the instance session; ServiceNow relations were not read. Pass `scope` to include them.",
            }
          : {}),
        sourceSummary: hydrated.sourceSummary,
        tables: [...tableSet.values()].sort(),
        relationEvidence,
        relationCount: relations.length,
        relations,
      };

      // A failed instance read leaves the relation set partial, not complete;
      // workspace edges alone must not pass for the scope's full picture.
      const serviceNowFailed = includeServiceNow && hydrated.sourceSummary.serviceNowFailed === true;
      return {
        isError: relations.length === 0 || serviceNowFailed || scopeUnresolved,
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
