import { existsSync, readFileSync, writeFileSync } from "fs";
export {
  computeMetricTrend,
  pruneMetricsOlderThan,
  summarizeMetrics,
  summarizeMetricsWindows,
  type ToolMetricEvent,
} from "./analysis/metrics";
export {
  buildSemanticIndexFromWorkspace,
  buildSymbolCrossReference,
  extractSymbolsFromCode,
  searchSemanticIndex,
  type SemanticSymbol,
} from "./analysis/semantic";
export {
  analyzeArchitecture,
  analyzePerformance,
  analyzeSecurity,
  applyFindingSuppressions,
  buildFullScriptAnalysisReport,
  buildRiskSummary,
  buildRiskSummaryWithPolicy,
  formatWhyLines,
  parseAnalysisPolicy,
  renderFullAnalysisMarkdown,
  resolveActiveSuppressions,
  runAutonomousRemediation,
  type AnalysisPolicy,
} from "./analysis/scriptAnalysis";
export {
  buildDependencyGraph,
  detectGraphCycles,
  diffDependencyGraphs,
  extractReferencesFromScript,
  renderDependencyGraphMermaid,
  renderTableRelationshipMermaid,
  rankImpact,
  summarizeBlastRadius,
  summarizeEdgeProvenance,
  summarizeGraphHotspots,
  validateChangePackage,
  type GraphEdge,
  type GraphNode,
} from "./analysis/graph";
export {
  SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  buildTableFieldMarkdownDocs,
  buildOnboardingPlan,
  buildScopeKnowledgeIndex,
  rankMinimalFootprintTargets,
  renderScopeKnowledgeMarkdown,
  summarizeTableImpactPaths,
  validateScopeKnowledgeIndex,
} from "./analysis/scopeKnowledge";
export {
  suggestAtfTest,
  type AtfTestMethod,
  type AtfTestSuggestion,
} from "./analysis/testGeneration";
export {
  diffInstanceVsLocal,
  type DiffRecordInput,
  type InstanceDiffReport,
  type RecordDiffEntry,
} from "./analysis/instanceDiff";

export type MetadataType =
  | "business_rule"
  | "client_script"
  | "ui_script"
  | "ui_action"
  | "ui_formatter"
  | "acl"
  | "dictionary"
  | "ui_policy"
  | "scripted_rest"
  | "scheduled_job";

export type MetadataConfig = {
  table: string;
  displayField: string;
  scriptField?: string;
  tableField?: string;
};

const METADATA_CONFIG: Record<MetadataType, MetadataConfig> = {
  business_rule: {
    table: "sys_script",
    displayField: "name",
    scriptField: "script",
    tableField: "collection",
  },
  client_script: {
    table: "sys_script_client",
    displayField: "name",
    scriptField: "script",
    tableField: "table",
  },
  ui_script: {
    table: "sys_ui_script",
    displayField: "name",
    scriptField: "script",
  },
  ui_action: {
    table: "sys_ui_action",
    displayField: "name",
    scriptField: "script",
    tableField: "table",
  },
  ui_formatter: {
    table: "sys_ui_formatter",
    displayField: "name",
    tableField: "table",
  },
  acl: {
    table: "sys_security_acl",
    displayField: "name",
    scriptField: "script",
    tableField: "name",
  },
  dictionary: {
    table: "sys_dictionary",
    displayField: "element",
    tableField: "name",
  },
  ui_policy: {
    table: "sys_ui_policy",
    displayField: "short_description",
    scriptField: "script_true",
    tableField: "table",
  },
  scripted_rest: {
    table: "sys_ws_operation",
    displayField: "name",
    scriptField: "script",
  },
  scheduled_job: {
    table: "sys_trigger",
    displayField: "name",
    scriptField: "script",
  },
};

export function getMetadataConfig(type: MetadataType): MetadataConfig {
  return METADATA_CONFIG[type];
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeMetadataRow(
  type: MetadataType,
  row: Record<string, unknown>
): Record<string, unknown> {
  const cfg = getMetadataConfig(type);
  const scriptField = cfg.scriptField || "";
  const tableField = cfg.tableField || "";
  return {
    type,
    table: cfg.table,
    sysId: toStringField(row.sys_id),
    name: toStringField(row[cfg.displayField]),
    active: row.active === true || toStringField(row.active) === "true",
    tableName: tableField ? toStringField(row[tableField]) : "",
    script: scriptField ? toStringField(row[scriptField]) : "",
    raw: row,
  };
}

export function buildMetadataUpdatePayload(
  type: MetadataType,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const cfg = getMetadataConfig(type);
  const allowed = new Set([
    "active",
    "description",
    "order",
    "condition",
    cfg.displayField,
    cfg.scriptField || "",
    cfg.tableField || "",
  ]);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function buildDriftReport(
  localRecords: Array<Record<string, unknown>>,
  instanceRecords: Array<Record<string, unknown>>,
  updateSetSysId: string
): Record<string, unknown> {
  const toMap = (arr: Array<Record<string, unknown>>) => {
    const map = new Map<string, Record<string, unknown>>();
    for (const rec of arr) {
      const key = toStringField(rec.key) || toStringField(rec.sys_id) || toStringField(rec.name);
      if (key) {
        map.set(key, rec);
      }
    }
    return map;
  };

  const local = toMap(localRecords);
  const remote = toMap(instanceRecords);

  const missingRemote: string[] = [];
  const missingLocal: string[] = [];
  const changed: string[] = [];

  for (const [key, localRec] of local.entries()) {
    const remoteRec = remote.get(key);
    if (!remoteRec) {
      missingRemote.push(key);
      continue;
    }
    const localHash = toStringField(localRec.hash);
    const remoteHash = toStringField(remoteRec.hash);
    if (localHash && remoteHash && localHash !== remoteHash) {
      changed.push(key);
    }
  }

  for (const key of remote.keys()) {
    if (!local.has(key)) {
      missingLocal.push(key);
    }
  }

  return {
    updateSetSysId,
    summary: {
      missingRemote: missingRemote.length,
      missingLocal: missingLocal.length,
      changed: changed.length,
      driftScore: missingRemote.length + missingLocal.length + changed.length,
    },
    missingRemote,
    missingLocal,
    changed,
    candidateActions: [
      "Run sync_refresh to align local state",
      "Review update set content and include missing records",
      "Run impact analysis before applying remote drift fixes",
    ],
    why: [
      "Missing remote means local artifact has no matching instance record",
      "Missing local means instance has unmanaged artifact",
      "Changed means both sides exist but content hash differs",
    ].sort((a, b) => a.localeCompare(b)),
  };
}

export function hashToolContract(toolNames: string[]): string {
  const sorted = [...toolNames].sort((a, b) => a.localeCompare(b));
  const text = sorted.join("|");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildTableApiCoverageMatrix(): Array<Record<string, unknown>> {
  const baseOps = ["list", "get", "update"];
  const rows = (Object.keys(METADATA_CONFIG) as MetadataType[]).map((type) => {
    const cfg = getMetadataConfig(type);
    return {
      recordType: type,
      table: cfg.table,
      supportedOperations: baseOps,
      missingOperations: ["delete"],
      via: "table_api",
    };
  });

  rows.sort((a, b) => a.recordType.localeCompare(b.recordType));
  return rows;
}

export function rotateAuditLogByLines(
  filePath: string,
  maxLines: number = 5000,
  keepLines: number = 2000
): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {
      rotated: false,
      beforeLines: 0,
      afterLines: 0,
    };
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const beforeLines = lines.length;

  if (beforeLines <= maxLines) {
    return {
      rotated: false,
      beforeLines,
      afterLines: beforeLines,
    };
  }

  const trimmed = lines.slice(-Math.max(keepLines, 1));
  writeFileSync(filePath, `${trimmed.join("\n")}\n`, "utf-8");

  return {
    rotated: true,
    beforeLines,
    afterLines: trimmed.length,
  };
}
