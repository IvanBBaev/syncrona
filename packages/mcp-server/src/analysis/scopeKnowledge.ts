import {
  type GraphEdge,
  type GraphNode,
  renderDependencyGraphMermaid,
  renderTableRelationshipMermaid,
  summarizeGraphHotspots,
} from "./graph";

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export const SCOPE_KNOWLEDGE_SCHEMA_VERSION = "1.0.0";

export function rankMinimalFootprintTargets(
  task: string,
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  limit: number = 5
): Array<Record<string, unknown>> {
  const queryTokens =
    task
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((v) => v.trim())
      .filter((v) => v.length > 1) || [];

  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) || 0) + 1);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) || 0) + 1);
  }

  const ranked = graph.nodes
    .filter((node) => node.kind === "script" || node.kind === "record")
    .map((node) => {
      const label = node.label.toLowerCase();
      const tokenHits = queryTokens.filter((token) => label.includes(token)).length;
      const inDegree = incomingCount.get(node.id) || 0;
      const outDegree = outgoingCount.get(node.id) || 0;
      const dependencyExpansion = inDegree + outDegree;
      const footprintScore = tokenHits * 10 - dependencyExpansion;
      const confidence = Math.max(0, Math.min(1, tokenHits === 0 ? 0.2 : 0.5 + (tokenHits * 0.15)));
      const risk = dependencyExpansion >= 6 ? "high" : dependencyExpansion >= 3 ? "medium" : "low";

      return {
        id: node.id,
        label: node.label,
        kind: node.kind,
        score: footprintScore,
        confidence,
        risk,
        impact: {
          incoming: inDegree,
          outgoing: outDegree,
          dependencyExpansion,
        },
        why: tokenHits > 0
          ? `Matched ${tokenHits} task keyword(s) with low expansion preference`
          : "No direct keyword match, candidate selected by low dependency expansion",
      };
    });

  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.impact.dependencyExpansion !== b.impact.dependencyExpansion) {
      return a.impact.dependencyExpansion - b.impact.dependencyExpansion;
    }
    return a.id.localeCompare(b.id);
  });

  return ranked.slice(0, Math.max(1, limit));
}

export function buildScopeKnowledgeIndex(input: {
  scope: string;
  entities: Array<Record<string, unknown>>;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  hotspots?: Array<Record<string, unknown>>;
  risks?: Array<Record<string, unknown>>;
  suppressions?: Array<Record<string, unknown>>;
  updateSetContext?: Record<string, unknown>;
  recommendedEditTargets?: Array<Record<string, unknown>>;
  sourceSummary?: Record<string, unknown>;
  tableImpactPaths?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const hotspots = input.hotspots || summarizeGraphHotspots(input.graph, 10);
  const tableImpactPaths = input.tableImpactPaths || summarizeTableImpactPaths(input.graph);
  const tableFields = new Map<string, Array<Record<string, unknown>>>();

  for (const rawEntity of input.entities) {
    const entity = asRecord(rawEntity);
    if (toStringField(entity.metadataType) !== "dictionary") {
      continue;
    }

    const tableName = toStringField(entity.tableName);
    const fieldName = toStringField(entity.fieldName) || toStringField(entity.name);
    if (!tableName || !fieldName) {
      continue;
    }

    const fields = tableFields.get(tableName) || [];
    fields.push({
      field: fieldName,
      label: toStringField(entity.columnLabel),
      type: toStringField(entity.internalType),
      maxLength: toStringField(entity.maxLength),
      required: entity.mandatory === true,
      reference: toStringField(entity.reference),
      defaultValue: toStringField(entity.defaultValue),
      attributes: toStringField(entity.attributes),
    });
    tableFields.set(tableName, fields);
  }

  const groupedTableFields = [...tableFields.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tableName, fields]) => ({
      tableName,
      fields: fields.sort((a, b) =>
        toStringField(a.field).localeCompare(toStringField(b.field))
      ),
    }));

  const scopedTables = new Set<string>();
  for (const row of groupedTableFields) {
    const tableName = toStringField(asRecord(row).tableName);
    if (tableName) {
      scopedTables.add(tableName);
    }
  }
  for (const rawEntity of input.entities) {
    const entity = asRecord(rawEntity);
    if (toStringField(entity.metadataType) !== "table") {
      continue;
    }
    const tableName = toStringField(entity.tableName) || toStringField(entity.name);
    if (tableName) {
      scopedTables.add(tableName);
    }
  }

  const referencedTableMap = new Map<string, {
    targetTable: string;
    sourceTables: Set<string>;
    fieldCount: number;
    relationCount: number;
    inScope: boolean;
  }>();

  for (const row of groupedTableFields) {
    const rowRecord = asRecord(row);
    const sourceTable = toStringField(rowRecord.tableName);
    const fields = Array.isArray(rowRecord.fields) ? rowRecord.fields : [];
    for (const rawField of fields) {
      const field = asRecord(rawField);
      const targetTable = toStringField(field.reference);
      if (!targetTable) {
        continue;
      }
      const current = referencedTableMap.get(targetTable) || {
        targetTable,
        sourceTables: new Set<string>(),
        fieldCount: 0,
        relationCount: 0,
        inScope: scopedTables.has(targetTable),
      };
      if (sourceTable) {
        current.sourceTables.add(sourceTable);
      }
      current.fieldCount += 1;
      current.inScope = current.inScope || scopedTables.has(targetTable);
      referencedTableMap.set(targetTable, current);
    }
  }

  for (const edge of input.graph.edges) {
    const from = toStringField(edge.from);
    const to = toStringField(edge.to);
    if (!from.startsWith("table:") || !to.startsWith("table:")) {
      continue;
    }
    const sourceTable = from.slice("table:".length);
    const targetTable = to.slice("table:".length);
    if (!sourceTable || !targetTable || sourceTable === targetTable) {
      continue;
    }
    const current = referencedTableMap.get(targetTable) || {
      targetTable,
      sourceTables: new Set<string>(),
      fieldCount: 0,
      relationCount: 0,
      inScope: scopedTables.has(targetTable),
    };
    current.sourceTables.add(sourceTable);
    current.relationCount += 1;
    current.inScope = current.inScope || scopedTables.has(targetTable);
    referencedTableMap.set(targetTable, current);
  }

  const referencedTables = [...referencedTableMap.values()]
    .map((row) => ({
      targetTable: row.targetTable,
      sourceTables: [...row.sourceTables.values()].sort((a, b) => a.localeCompare(b)),
      sourceCount: row.sourceTables.size,
      fieldCount: row.fieldCount,
      relationCount: row.relationCount,
      inScope: row.inScope,
    }))
    .sort((a, b) => {
      if (a.inScope !== b.inScope) {
        return a.inScope ? 1 : -1;
      }
      if (b.sourceCount !== a.sourceCount) {
        return b.sourceCount - a.sourceCount;
      }
      if (b.fieldCount !== a.fieldCount) {
        return b.fieldCount - a.fieldCount;
      }
      return a.targetTable.localeCompare(b.targetTable);
    });

  return {
    schemaVersion: SCOPE_KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scope: input.scope,
    entities: input.entities,
      dependencyNodes: input.graph.nodes,
    dependencies: input.graph.edges,
    hotspots,
    risks: input.risks || [],
    suppressions: input.suppressions || [],
    updateSetContext: input.updateSetContext || {},
    recommendedEditTargets: input.recommendedEditTargets || [],
    sourceSummary: input.sourceSummary || {},
    tableImpactPaths,
    tableFields: groupedTableFields,
    referencedTables,
  };
}

export function summarizeTableImpactPaths(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  limit: number = 20
): Array<Record<string, unknown>> {
  const toTableEdges = graph.edges
    .map((edge) => ({
      from: toStringField(edge.from),
      to: toStringField(edge.to),
      relation: toStringField(edge.relation),
      why: toStringField(edge.why),
    }))
    .filter((edge) => edge.from.length > 0 && edge.to.startsWith("table:"));

  const tableFromByProducer = new Map<string, string[]>();
  for (const edge of toTableEdges) {
    if (!edge.to.startsWith("table:")) {
      continue;
    }
    const producer = edge.from;
    const targetTable = edge.to.slice("table:".length);
    if (!targetTable) {
      continue;
    }
    const existing = tableFromByProducer.get(producer) || [];
    if (!existing.includes(targetTable)) {
      existing.push(targetTable);
      tableFromByProducer.set(producer, existing);
    }
  }

  const aggregates = new Map<string, {
    sourceTable: string;
    targetTable: string;
    via: string[];
    evidences: string[];
    hasDirectTableLink: boolean;
    hasServiceNowEvidence: boolean;
  }>();

  const upsertPath = (
    sourceTable: string,
    targetTable: string,
    via: string,
    evidence: string,
    directTableLink: boolean
  ) => {
    if (!sourceTable || !targetTable || sourceTable === targetTable) {
      return;
    }
    const key = `${sourceTable}|${targetTable}`;
    const existing = aggregates.get(key) || {
      sourceTable,
      targetTable,
      via: [],
      evidences: [],
      hasDirectTableLink: false,
      hasServiceNowEvidence: false,
    };
    if (via && !existing.via.includes(via)) {
      existing.via.push(via);
    }
    if (evidence && !existing.evidences.includes(evidence)) {
      existing.evidences.push(evidence);
    }
    if (directTableLink) {
      existing.hasDirectTableLink = true;
    }
    if (/service\s*now|sys_/i.test(evidence)) {
      existing.hasServiceNowEvidence = true;
    }
    aggregates.set(key, existing);
  };

  for (const edge of toTableEdges) {
    const targetTable = edge.to.slice("table:".length);
    if (!targetTable) {
      continue;
    }

    if (edge.from.startsWith("table:")) {
      const sourceTable = edge.from.slice("table:".length);
      upsertPath(sourceTable, targetTable, edge.from, edge.why, true);
      continue;
    }

    const producerTables = tableFromByProducer.get(edge.from) || [];
    for (const sourceTable of producerTables) {
      upsertPath(sourceTable, targetTable, edge.from, edge.why, false);
    }
  }

  const out = [...aggregates.values()]
    .map((row) => {
      const evidenceCount = row.evidences.length;
      const viaCount = row.via.length;
      const confidenceRaw =
        0.45 +
        Math.min(evidenceCount, 4) * 0.1 +
        Math.min(viaCount, 3) * 0.05 +
        (row.hasDirectTableLink ? 0.2 : 0) +
        (row.hasServiceNowEvidence ? 0.1 : 0);
      const confidence = Math.max(0, Math.min(1, Math.round(confidenceRaw * 100) / 100));

      return {
        sourceTable: row.sourceTable,
        targetTable: row.targetTable,
        confidence,
        evidenceCount,
        via: row.via.sort((a, b) => a.localeCompare(b)),
        evidences: row.evidences.sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      if (b.evidenceCount !== a.evidenceCount) {
        return b.evidenceCount - a.evidenceCount;
      }
      if (a.sourceTable !== b.sourceTable) {
        return a.sourceTable.localeCompare(b.sourceTable);
      }
      return a.targetTable.localeCompare(b.targetTable);
    });

  return out.slice(0, Math.max(1, limit));
}

export function validateScopeKnowledgeIndex(index: Record<string, unknown>): {
  valid: boolean;
  missingFields: string[];
} {
  const required = [
    "schemaVersion",
    "generatedAt",
    "scope",
    "entities",
    "dependencies",
    "hotspots",
    "risks",
    "suppressions",
    "updateSetContext",
    "recommendedEditTargets",
  ];

  const missingFields = required.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(index, key)) {
      return true;
    }
    const value = index[key];
    if (typeof value === "string") {
      return value.trim().length === 0;
    }
    if (Array.isArray(value)) {
      return false;
    }
    if (value && typeof value === "object") {
      return false;
    }
    return value === undefined || value === null;
  });

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/\|/g, "/")
    .replace(/[\[\]{}()]/g, "")
    .replace(/"/g, "'")
    .trim();
}

function renderObjectImpactMermaid(
  sourceId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeLimit: number = 16
): string {
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const fromNeighbors = adjacency.get(edge.from) || new Set<string>();
    fromNeighbors.add(edge.to);
    adjacency.set(edge.from, fromNeighbors);

    const toNeighbors = adjacency.get(edge.to) || new Set<string>();
    toNeighbors.add(edge.from);
    adjacency.set(edge.to, toNeighbors);
  }

  const selected = new Set<string>([sourceId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: sourceId, depth: 0 }];

  while (queue.length > 0 && selected.size < nodeLimit) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.depth >= 2) {
      continue;
    }
    const neighbors = adjacency.get(current.id);
    if (!neighbors) {
      continue;
    }
    const orderedNeighbors = [...neighbors.values()].sort((a, b) => a.localeCompare(b));
    for (const neighbor of orderedNeighbors) {
      if (selected.size >= nodeLimit) {
        break;
      }
      if (!selected.has(neighbor)) {
        selected.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  const includedEdges = edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .slice(0, 24);
  const orderedNodeIds = [
    sourceId,
    ...[...selected.values()]
      .filter((id) => id !== sourceId)
      .sort((a, b) => a.localeCompare(b)),
  ];
  const nodeAlias = new Map<string, string>();
  orderedNodeIds.forEach((id, idx) => {
    nodeAlias.set(id, `N${idx}`);
  });

  const lines: string[] = ["flowchart LR"];
  for (const id of orderedNodeIds) {
    const alias = nodeAlias.get(id) || "N0";
    const node = nodeById.get(id);
    const label = escapeMermaidLabel(node?.label || id);
    lines.push(`  ${alias}[${label}]`);
  }

  for (const edge of includedEdges) {
    const fromAlias = nodeAlias.get(edge.from);
    const toAlias = nodeAlias.get(edge.to);
    if (!fromAlias || !toAlias) {
      continue;
    }
    lines.push(`  ${fromAlias} -->|${escapeMermaidLabel(edge.relation)}| ${toAlias}`);
  }

  const sourceAlias = nodeAlias.get(sourceId);
  if (sourceAlias) {
    lines.push("  classDef impactSource fill:#ffe8b6,stroke:#c98b00,stroke-width:2px");
    lines.push(`  class ${sourceAlias} impactSource`);
  }

  return lines.join("\n");
}

export function renderScopeKnowledgeMarkdown(index: Record<string, unknown>): string {
  const scope = toStringField(index.scope) || "unknown_scope";
  const entities = Array.isArray(index.entities) ? index.entities : [];
  const dependencies = Array.isArray(index.dependencies) ? index.dependencies : [];
  const hotspots = Array.isArray(index.hotspots) ? index.hotspots : [];
  const risks = Array.isArray(index.risks) ? index.risks : [];
  const suppressions = Array.isArray(index.suppressions) ? index.suppressions : [];
  const recommended = Array.isArray(index.recommendedEditTargets)
    ? index.recommendedEditTargets
    : [];
  const dependencyNodesRaw = Array.isArray(index.dependencyNodes) ? index.dependencyNodes : [];
  const graphNodes: GraphNode[] = dependencyNodesRaw
    .map((item) => asRecord(item))
    .map((item) => ({
      id: toStringField(item.id),
      kind: (toStringField(item.kind) || "record") as GraphNode["kind"],
      label: toStringField(item.label),
    }))
    .filter((item) => item.id.length > 0);
  const graphEdges: GraphEdge[] = dependencies
    .map((item) => asRecord(item))
    .map((item) => ({
      from: toStringField(item.from),
      to: toStringField(item.to),
      relation: (toStringField(item.relation) || "depends_on") as GraphEdge["relation"],
      why: toStringField(item.why),
    }))
    .filter((item) => item.from.length > 0 && item.to.length > 0);
  const sourceSummary = asRecord(index.sourceSummary);
  const tableImpactPaths = Array.isArray(index.tableImpactPaths)
    ? index.tableImpactPaths
    : [];
  const tableFields = Array.isArray(index.tableFields)
    ? index.tableFields
    : [];
  const referencedTables = Array.isArray(index.referencedTables)
    ? index.referencedTables
    : [];
  const scheduledJobs = entities
    .map((item) => asRecord(item))
    .filter((item) => toStringField(item.metadataType) === "scheduled_job");
  const impactObjectTypes = new Set<string>(["business_rule", "script_include"]);
  const impactObjects = entities
    .map((item) => asRecord(item))
    .filter((item) => impactObjectTypes.has(toStringField(item.metadataType)))
    .map((item) => ({
      id: toStringField(item.id),
      name: toStringField(item.name),
      metadataType: toStringField(item.metadataType),
    }))
    .filter((item) => item.id.length > 0)
    .sort((a, b) => {
      if (a.metadataType !== b.metadataType) {
        return a.metadataType.localeCompare(b.metadataType);
      }
      if (a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, 10);

  const affectedTablesBySource = new Map<string, string[]>();
  for (const raw of dependencies) {
    const edge = asRecord(raw);
    const from = toStringField(edge.from);
    const to = toStringField(edge.to);
    const relation = toStringField(edge.relation);
    if (!from || !to.startsWith("table:")) {
      continue;
    }
    if (!["reads", "writes", "affects"].includes(relation)) {
      continue;
    }
    const table = to.slice("table:".length);
    if (!table) {
      continue;
    }
    const current = affectedTablesBySource.get(from) || [];
    if (!current.includes(table)) {
      current.push(table);
      affectedTablesBySource.set(from, current);
    }
  }

  const tableDependencyCounts = new Map<string, number>();
  const externalDependencyCounts = new Map<string, number>();
  let globalDependencyCount = 0;
  for (const raw of dependencies) {
    const edge = asRecord(raw);
    const relation = toStringField(edge.relation);
    const target = toStringField(edge.to);
    if (relation === "cross_scope_dependency" && target.startsWith("external_scope:")) {
      const scopeCode = target.slice("external_scope:".length);
      if (scopeCode && scopeCode !== "global") {
        externalDependencyCounts.set(scopeCode, (externalDependencyCounts.get(scopeCode) || 0) + 1);
      }
    }
    if (relation === "global_dependency") {
      globalDependencyCount += 1;
    }

    if (!target.startsWith("table:")) {
      continue;
    }
    const table = target.slice("table:".length);
    if (!table) {
      continue;
    }
    tableDependencyCounts.set(table, (tableDependencyCounts.get(table) || 0) + 1);
  }

  const lines: string[] = [];
  lines.push(`# Scope Knowledge: ${scope}`);
  lines.push("");
  lines.push("## Scope Overview");
  lines.push(`- Scope: ${scope}`);
  lines.push(`- Schema version: ${toStringField(index.schemaVersion)}`);
  lines.push(`- Generated at: ${toStringField(index.generatedAt)}`);
  lines.push("");
  lines.push("## Object Inventory");
  lines.push(`- Entity count: ${entities.length}`);
  lines.push("");
  lines.push("## Dependency Graph + Hotspots");
  lines.push(`- Dependency edges: ${dependencies.length}`);
  lines.push(`- Hotspots: ${hotspots.length}`);
  lines.push("```mermaid");
  lines.push(renderDependencyGraphMermaid({ nodes: graphNodes, edges: graphEdges }, 30));
  lines.push("```");
  lines.push("");
  lines.push("## Impact Mini-Diagrams");
  lines.push("- Coverage: direct + 1-hop dependencies for major objects (Business Rules and Script Includes).");
  if (impactObjects.length === 0) {
    lines.push("- No Business Rules or Script Includes discovered for impact mini-diagrams.");
  } else {
    for (const item of impactObjects) {
      lines.push(`### ${item.name || item.id}`);
      lines.push("```mermaid");
      lines.push(renderObjectImpactMermaid(item.id, graphNodes, graphEdges, 16));
      lines.push("```");
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Table Dependencies");
  if (tableDependencyCounts.size === 0) {
    lines.push("- No table dependency edges detected.");
  } else {
    const rankedTables = [...tableDependencyCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 25);
    for (const [table, count] of rankedTables) {
      lines.push(`- ${table} (${count})`);
    }
  }
  lines.push("");
  lines.push("## Table Relationship Diagram");
  lines.push("```mermaid");
  lines.push(renderTableRelationshipMermaid({ nodes: graphNodes, edges: graphEdges }, 40));
  lines.push("```");
  lines.push("");
  lines.push("## Table-to-Table Impact Paths (with confidence)");
  if (tableImpactPaths.length === 0) {
    lines.push("- No inferred table-to-table impact paths available.");
  } else {
    for (const rawPath of tableImpactPaths.slice(0, 20)) {
      const row = asRecord(rawPath);
      const sourceTable = toStringField(row.sourceTable);
      const targetTable = toStringField(row.targetTable);
      const confidence = Number(row.confidence);
      if (!sourceTable || !targetTable) {
        continue;
      }
      lines.push(`- ${sourceTable} -> ${targetTable} (confidence=${Number.isFinite(confidence) ? confidence.toFixed(2) : "0.00"})`);
    }
  }
  lines.push("");
  lines.push("## Dictionary Field Inventory");
  if (tableFields.length === 0) {
    lines.push("- No scoped dictionary fields discovered.");
  } else {
    for (const rawTableFields of tableFields.slice(0, 40)) {
      const tableEntry = asRecord(rawTableFields);
      const tableName = toStringField(tableEntry.tableName);
      const fields = Array.isArray(tableEntry.fields) ? tableEntry.fields : [];
      if (!tableName) {
        continue;
      }
      lines.push(`### ${tableName}`);
      lines.push("| Field | Label | Type | Required | Reference |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const rawField of fields.slice(0, 200)) {
        const field = asRecord(rawField);
        const fieldName = toStringField(field.field);
        if (!fieldName) {
          continue;
        }
        const label = toStringField(field.label) || "-";
        const type = toStringField(field.type) || "-";
        const maxLength = toStringField(field.maxLength);
        const typeWithLength = maxLength ? `${type}(${maxLength})` : type;
        const required = field.required === true ? "yes" : "no";
        const reference = toStringField(field.reference) || "-";
        lines.push(`| ${fieldName} | ${label} | ${typeWithLength} | ${required} | ${reference} |`);
      }
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Referenced Tables Index");
  if (referencedTables.length === 0) {
    lines.push("- No referenced target tables detected from scoped dictionary fields.");
  } else {
    lines.push("| Target Table | Scope Ownership | Sources | Fields | Relations |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const rawEntry of referencedTables.slice(0, 200)) {
      const entry = asRecord(rawEntry);
      const targetTable = toStringField(entry.targetTable);
      if (!targetTable) {
        continue;
      }
      const ownership = entry.inScope === true ? "in-scope" : "external";
      const sourceCount = Number(entry.sourceCount) || 0;
      const fieldCount = Number(entry.fieldCount) || 0;
      const relationCount = Number(entry.relationCount) || 0;
      lines.push(`| ${targetTable} | ${ownership} | ${sourceCount} | ${fieldCount} | ${relationCount} |`);
    }
  }
  lines.push("");
  lines.push("## External Dependencies");
  if (externalDependencyCounts.size === 0 && globalDependencyCount === 0) {
    lines.push("- No external scope or global dependencies detected.");
  } else {
    const rankedExternal = [...externalDependencyCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
      });
    for (const [scopeCode, count] of rankedExternal) {
      lines.push(`- External scope ${scopeCode}: ${count} dependency edge(s) [risk: medium]`);
    }
    if (globalDependencyCount > 0) {
      lines.push(`- Global scope dependencies: ${globalDependencyCount} edge(s) [risk: medium]`);
    }
  }
  lines.push("");
  lines.push("## Risks + Suppressions");
  lines.push(`- Risks: ${risks.length}`);
  lines.push(`- Suppressions: ${suppressions.length}`);
  lines.push("");
  lines.push("## Scheduled Jobs");
  if (scheduledJobs.length === 0) {
    lines.push("- No scheduled jobs discovered.");
  } else {
    for (const row of scheduledJobs) {
      const id = toStringField(row.id) || "record:unknown";
      const name = toStringField(row.name) || id;
      const runType = toStringField(row.runType) || "n/a";
      const runPeriod = toStringField(row.runPeriod) || "n/a";
      const runTime = toStringField(row.runTime) || "n/a";
      const affected = (affectedTablesBySource.get(id) || []).sort((a, b) => a.localeCompare(b));
      const script = toStringField(row.script).trim();
      const excerpt = script.length > 140 ? `${script.slice(0, 140)}...` : script;

      lines.push(`### ${name}`);
      lines.push(`- Schedule: run_type=${runType}, run_period=${runPeriod}, run_time=${runTime}`);
      lines.push(`- Affected tables: ${affected.length > 0 ? affected.join(", ") : "none detected"}`);
      lines.push(`- Script excerpt: ${excerpt || "n/a"}`);
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Dependency Evidence Provenance");
  lines.push(`- Input entities: ${Number(sourceSummary.inputEntityCount) || 0}`);
  lines.push(`- Input dependencies: ${Number(sourceSummary.inputDependencyCount) || 0}`);
  lines.push(`- ServiceNow entities: ${Number(sourceSummary.serviceNowEntityCount) || 0}`);
  lines.push(`- ServiceNow dependencies: ${Number(sourceSummary.serviceNowDependencyCount) || 0}`);
  lines.push(`- Local entities: ${Number(sourceSummary.localEntityCount) || 0}`);
  lines.push(`- Local dependencies: ${Number(sourceSummary.localDependencyCount) || 0}`);
  lines.push("");
  lines.push("## Update Set Context");
  lines.push(`- Context keys: ${Object.keys(asRecord(index.updateSetContext)).length}`);
  lines.push("");
  lines.push("## Change Playbook");
  lines.push("1. Run preflight and deep analysis before any mutation.");
  lines.push("2. Use dry-run and validate impact/risk output.");
  lines.push("3. Require approval and rollback evidence for high-risk changes.");
  lines.push("");
  lines.push("## Where To Modify");
  if (recommended.length === 0) {
    lines.push("- No recommended targets available yet.");
  } else {
    for (const item of recommended.slice(0, 10)) {
      const row = asRecord(item);
      lines.push(`- ${toStringField(row.id)} | ${toStringField(row.label)} | risk=${toStringField(row.risk)}`);
    }
  }
  lines.push("");
  lines.push("## Diagrams");
  lines.push("```mermaid");
  lines.push("graph LR");
  lines.push(`  SCOPE[${scope}] --> HOTSPOTS[Hotspots: ${hotspots.length}]`);
  lines.push("```");

  return `${lines.join("\n")}\n`;
}

export function buildOnboardingPlan(input: {
  hasEnv: boolean;
  hasGuardrails: boolean;
  hasScopeKnowledge: boolean;
}): Record<string, unknown> {
  const steps = [
    {
      id: "check-env",
      title: "Validate environment credentials",
      done: input.hasEnv,
      action: "Set SN_INSTANCE, SN_USER, SN_PASSWORD in .env",
    },
    {
      id: "check-guardrails",
      title: "Enable guardrails",
      done: input.hasGuardrails,
      action: "Create or update sync.mcp.guardrails.json",
    },
    {
      id: "check-scope-knowledge",
      title: "Generate scope knowledge",
      done: input.hasScopeKnowledge,
      action: "Run scope knowledge generator for active scope",
    },
    {
      id: "first-safe-change",
      title: "Execute first safe change flow",
      done: false,
      action: "Run unified workflow with dry-run first",
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  return {
    completed,
    total: steps.length,
    readyForFirstChange: completed >= 3,
    steps,
  };
}

export function buildTableFieldMarkdownDocs(index: Record<string, unknown>): Array<{
  tableName: string;
  markdown: string;
}> {
  const tableFields = Array.isArray(index.tableFields) ? index.tableFields : [];
  const docs: Array<{ tableName: string; markdown: string }> = [];

  for (const rawTable of tableFields) {
    const tableEntry = asRecord(rawTable);
    const tableName = toStringField(tableEntry.tableName);
    const fields = Array.isArray(tableEntry.fields) ? tableEntry.fields : [];
    if (!tableName) {
      continue;
    }

    const lines: string[] = [];
    lines.push(`# Table: ${tableName}`);
    lines.push("");
    lines.push("## Fields");
    lines.push("| Field | Label | Type | Required | Reference | Default |");
    lines.push("| --- | --- | --- | --- | --- | --- |");

    for (const rawField of fields) {
      const field = asRecord(rawField);
      const fieldName = toStringField(field.field);
      if (!fieldName) {
        continue;
      }
      const label = toStringField(field.label) || "-";
      const type = toStringField(field.type) || "-";
      const maxLength = toStringField(field.maxLength);
      const typeWithLength = maxLength ? `${type}(${maxLength})` : type;
      const required = field.required === true ? "yes" : "no";
      const reference = toStringField(field.reference) || "-";
      const defaultValue = toStringField(field.defaultValue) || "-";
      lines.push(`| ${fieldName} | ${label} | ${typeWithLength} | ${required} | ${reference} | ${defaultValue} |`);
    }

    lines.push("");
    docs.push({
      tableName,
      markdown: `${lines.join("\n")}\n`,
    });
  }

  docs.sort((a, b) => a.tableName.localeCompare(b.tableName));
  return docs;
}
