import {
  buildDependencyGraph,
  buildDriftReport,
  buildMetadataUpdatePayload,
  buildSemanticIndexFromWorkspace,
  buildSymbolCrossReference,
  detectGraphCycles,
  diffDependencyGraphs,
  getMetadataConfig,
  normalizeMetadataRow,
  rankImpact,
  searchSemanticIndex,
  summarizeBlastRadius,
  summarizeEdgeProvenance,
  summarizeGraphHotspots,
  validateChangePackage,
  type MetadataType,
  type SemanticSymbol,
} from "../analysis";
import { toJsonText } from "../runtimeUtils";
import { snRequest } from "../servicenowCore";
import { tableGet } from "../sessionContext";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type MetadataAnalysisContext = {
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  projectDir: string;
  parseMetadataType: (value: unknown) => MetadataType | null;
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
  getLastSemanticIndex: () => SemanticSymbol[];
  setLastSemanticIndex: (rows: SemanticSymbol[]) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function handleMetadataAnalysisTool(
  toolName: string,
  args: Record<string, unknown>,
  context: MetadataAnalysisContext
): Promise<ToolResponse | null> {
  const { timeoutMs, dryRun, startedAt } = context;

  switch (toolName) {
    case "sn_list_metadata_records": {
      const metadataType = context.parseMetadataType(args.recordType);
      if (!metadataType) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid recordType." }],
        };
      }

      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 500)
          : 100;
      const cfg = getMetadataConfig(metadataType);

      const rows = await tableGet(
        cfg.table,
        {
          query,
          limit,
        },
        timeoutMs
      );

      const normalized = rows.map((row) => normalizeMetadataRow(metadataType, row));
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ recordType: metadataType, count: normalized.length, rows: normalized }) }],
      };
    }

    case "sn_get_metadata_record": {
      const metadataType = context.parseMetadataType(args.recordType);
      const sysId = typeof args.sysId === "string" ? args.sysId.trim() : "";
      if (!metadataType || !sysId) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing or invalid recordType/sysId." }],
        };
      }

      const cfg = getMetadataConfig(metadataType);
      const rows = await tableGet(
        cfg.table,
        {
          query: `sys_id=${sysId}`,
          limit: 1,
        },
        timeoutMs
      );
      const row = rows.length > 0 ? normalizeMetadataRow(metadataType, rows[0]) : null;
      return {
        isError: row === null,
        content: [{ type: "text", text: toJsonText({ recordType: metadataType, row }) }],
      };
    }

    case "sn_update_metadata_record": {
      const metadataType = context.parseMetadataType(args.recordType);
      const sysId = typeof args.sysId === "string" ? args.sysId.trim() : "";
      const confirmDestructive = args.confirmDestructive === true;
      const updates = asRecord(args.updates);

      if (!metadataType || !sysId) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing or invalid recordType/sysId." }],
        };
      }

      if (!confirmDestructive) {
        return {
          isError: true,
          content: [{ type: "text", text: "Metadata update is destructive. Re-run with confirmDestructive=true." }],
        };
      }

      const payload = buildMetadataUpdatePayload(metadataType, updates);
      const cfg = getMetadataConfig(metadataType);

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          recordType: metadataType,
          table: cfg.table,
          sysId,
          payload,
        });
      }

      const response = await snRequest(
        "PATCH",
        `/api/now/table/${cfg.table}/${sysId}`,
        payload,
        timeoutMs
      );

      context.auditMutatingTool(toolName, args, { status: response.status, table: cfg.table, sysId }, Date.now() - startedAt);
      return {
        isError: response.status < 200 || response.status > 299,
        content: [{ type: "text", text: toJsonText({ status: response.status, table: cfg.table, sysId, result: response.data }) }],
      };
    }

    case "sn_build_dependency_graph": {
      const records = Array.isArray(args.records)
        ? args.records.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const graph = buildDependencyGraph(records);
      const cycles = detectGraphCycles(graph);
      const hotspots = summarizeGraphHotspots(graph, 10);
      const provenance = summarizeEdgeProvenance(graph);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ ...graph, cycles, hotspots, provenance, why: ["Edges are created from table/API/include references parsed from scripts and declared meta relations."] }) }],
      };
    }

    case "sn_analyze_impact": {
      const graph = asRecord(args.graph);
      const targetId = typeof args.targetId === "string" ? args.targetId.trim() : "";
      const nodes = Array.isArray(graph.nodes)
        ? graph.nodes.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const edges = Array.isArray(graph.edges)
        ? graph.edges.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];

      const impact = rankImpact(
        {
          nodes: nodes.map((n) => ({
            id: toStringField(n.id),
            kind: (toStringField(n.kind) || "record") as "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope",
            label: toStringField(n.label),
          })),
          edges: edges.map((e) => ({
            from: toStringField(e.from),
            to: toStringField(e.to),
            relation: (toStringField(e.relation) || "depends_on") as "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on",
            why: toStringField(e.why),
          })),
        },
        targetId
      );
      const blastRadius = summarizeBlastRadius(
        {
          nodes: nodes.map((n) => ({
            id: toStringField(n.id),
            kind: (toStringField(n.kind) || "record") as "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope",
            label: toStringField(n.label),
          })),
          edges: edges.map((e) => ({
            from: toStringField(e.from),
            to: toStringField(e.to),
            relation: (toStringField(e.relation) || "depends_on") as "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency",
            why: toStringField(e.why),
          })),
        },
        impact
      );
      return {
        isError: !targetId,
        content: [{ type: "text", text: toJsonText({ targetId, impact, blastRadius, why: ["Severity is ranked by graph distance from changed node."] }) }],
      };
    }

    case "sn_diff_dependency_graphs": {
      const beforeGraph = asRecord(args.beforeGraph);
      const afterGraph = asRecord(args.afterGraph);
      const toGraph = (value: Record<string, unknown>) => {
        const nodes = Array.isArray(value.nodes)
          ? value.nodes.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          : [];
        const edges = Array.isArray(value.edges)
          ? value.edges.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          : [];
        return {
          nodes: nodes.map((n) => ({
            id: toStringField(n.id),
            kind: (toStringField(n.kind) || "record") as "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope",
            label: toStringField(n.label),
          })),
          edges: edges.map((e) => ({
            from: toStringField(e.from),
            to: toStringField(e.to),
            relation: (toStringField(e.relation) || "depends_on") as "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency",
            why: toStringField(e.why),
          })),
        };
      };

      const diff = diffDependencyGraphs(toGraph(beforeGraph), toGraph(afterGraph));
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(diff) }],
      };
    }

    case "sync_detect_drift": {
      const localRecords = Array.isArray(args.localRecords)
        ? args.localRecords.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const instanceRecords = Array.isArray(args.instanceRecords)
        ? args.instanceRecords.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const updateSetSysId = typeof args.updateSetSysId === "string" ? args.updateSetSysId.trim() : "";

      const report = buildDriftReport(localRecords, instanceRecords, updateSetSysId);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(report) }],
      };
    }

    case "sync_validate_change_package": {
      const selectedIds = Array.isArray(args.selectedIds)
        ? args.selectedIds.filter((item): item is string => typeof item === "string")
        : [];
      const graph = asRecord(args.graph);
      const nodes = Array.isArray(graph.nodes)
        ? graph.nodes.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const edges = Array.isArray(graph.edges)
        ? graph.edges.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];

      const validation = validateChangePackage(
        selectedIds,
        {
          nodes: nodes.map((n) => ({ id: toStringField(n.id), kind: "record", label: toStringField(n.label) })),
          edges: edges.map((e) => ({
            from: toStringField(e.from),
            to: toStringField(e.to),
            relation: "depends_on",
            why: toStringField(e.why),
          })),
        }
      );

      return {
        isError: validation.valid !== true,
        content: [{ type: "text", text: toJsonText(validation) }],
      };
    }

    case "sync_build_semantic_index": {
      const nextIndex = buildSemanticIndexFromWorkspace(context.projectDir);
      context.setLastSemanticIndex(nextIndex);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ symbolCount: nextIndex.length }) }],
      };
    }

    case "sync_search_semantic_index": {
      const query = typeof args.query === "string" ? args.query : "";
      const matches = searchSemanticIndex(context.getLastSemanticIndex(), query);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ query, count: matches.length, matches }) }],
      };
    }

    case "sync_symbol_cross_reference": {
      const rows = buildSymbolCrossReference(context.getLastSemanticIndex());
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ count: rows.length, rows }) }],
      };
    }

    default:
      return null;
  }
}
