function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export type GraphNode = {
  id: string;
  kind: "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope";
  label: string;
  meta?: Record<string, unknown>;
};

export type GraphEdge = {
  from: string;
  to: string;
  relation: "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency";
  why: string;
};

function toNormalizedScopeCode(value: unknown): string {
  const raw = toStringField(value).trim().toLowerCase();
  return raw.replace(/[^a-z0-9_]/g, "");
}

function extractScopeCodeFromTableName(table: string): string {
  const normalized = table.trim().toLowerCase();
  const match = normalized.match(/^(x_[a-z0-9]+_[a-z0-9]+)_[a-z0-9_]+$/);
  return match ? match[1] : "";
}

function extractScopeCodeFromIncludeName(include: string): string {
  const normalized = include.trim();
  if (!normalized.includes(".")) {
    return "";
  }
  const [prefix] = normalized.split(".");
  const asScopedName = prefix.toLowerCase();
  if (asScopedName.startsWith("x_")) {
    return asScopedName;
  }
  if (/^[a-z][a-z0-9_]*$/i.test(prefix)) {
    return prefix.toLowerCase();
  }
  return "";
}

function pushUniqueEdge(edges: GraphEdge[], edge: GraphEdge): void {
  const key = `${edge.from}|${edge.to}|${edge.relation}|${edge.why}`;
  const has = edges.some((e) => `${e.from}|${e.to}|${e.relation}|${e.why}` === key);
  if (!has) {
    edges.push(edge);
  }
}

function extractMetaRelationsFromRecord(rec: Record<string, unknown>): {
  tables: string[];
  includes: string[];
} {
  const tables: string[] = [];
  const includes: string[] = [];

  const affectsTables = Array.isArray(rec.affectsTables)
    ? rec.affectsTables.filter((v): v is string => typeof v === "string")
    : [];
  tables.push(...affectsTables.map((v) => v.trim()).filter((v) => v.length > 0));

  const callsIncludes = Array.isArray(rec.callsIncludes)
    ? rec.callsIncludes.filter((v): v is string => typeof v === "string")
    : [];
  includes.push(...callsIncludes.map((v) => v.trim()).filter((v) => v.length > 0));

  const metaRelations = Array.isArray(rec.metaRelations)
    ? rec.metaRelations
    : [];

  for (const raw of metaRelations) {
    if (typeof raw === "string") {
      const normalized = raw.trim();
      if (normalized.startsWith("table:")) {
        const table = normalized.slice("table:".length).trim();
        if (table) {
          tables.push(table);
        }
      } else if (normalized.startsWith("include:")) {
        const include = normalized.slice("include:".length).trim();
        if (include) {
          includes.push(include);
        }
      }
      continue;
    }

    const rel = asRecord(raw);
    const relType = toStringField(rel.type).trim().toLowerCase();
    const target = toStringField(rel.target).trim();
    if (!target) {
      continue;
    }
    if (relType === "table") {
      tables.push(target);
    }
    if (relType === "include") {
      includes.push(target);
    }
  }

  return {
    tables: [...new Set(tables)],
    includes: [...new Set(includes)],
  };
}

export function extractReferencesFromScript(script: string): {
  tables: string[];
  apis: string[];
  includes: string[];
} {
  const tableMatches = [...script.matchAll(/GlideRecord(?:Secure)?\(['\"]([a-z0-9_]+)['\"]\)/gi)];
  const apiMatches = [...script.matchAll(/sn_ws\.RESTMessageV2\(['\"]([^'\"]+)['\"]/gi)];
  const includeMatches = [...script.matchAll(/new\s+([A-Z][A-Za-z0-9_]+)\s*\(/g)];
  const glideAjaxMatches = [...script.matchAll(/new\s+GlideAjax\s*\(\s*['\"]([A-Za-z0-9_$.]+)['\"]\s*\)/g)];

  const dedupe = (values: string[]) => [...new Set(values.filter((v) => v.length > 0))];
  const blockedIncludes = new Set(["GlideRecord", "GlideRecordSecure", "RESTMessageV2", "GlideAjax"]);

  return {
    tables: dedupe(tableMatches.map((m) => m[1] || "")),
    apis: dedupe(apiMatches.map((m) => m[1] || "")),
    includes: dedupe([
      ...includeMatches.map((m) => m[1] || ""),
      ...glideAjaxMatches.map((m) => m[1] || ""),
    ]).filter((item) => !blockedIncludes.has(item)),
  };
}

export function buildDependencyGraph(records: Array<Record<string, unknown>>): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  const upsertNode = (node: GraphNode) => {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  };

  for (const raw of records) {
    const rec = asRecord(raw);
    const id = toStringField(rec.id) || toStringField(rec.sys_id) || `record:${nodes.length + 1}`;
    const name = toStringField(rec.name) || id;
    const script = toStringField(rec.script);
    const table = toStringField(rec.table) || toStringField(rec.tableName);
    const updateSet = toStringField(rec.updateSet);
    const metadataType = toStringField(rec.metadataType);
    const ownScopeCode = toNormalizedScopeCode(
      rec.scopeCode || rec.scope || rec.sysScope || rec.applicationScope
    );
    const nodeKind: GraphNode["kind"] = metadataType === "scheduled_job" ? "scheduled_job" : "script";

    upsertNode({ id, kind: nodeKind, label: name, meta: rec });

    if (table) {
      const tableId = `table:${table}`;
      upsertNode({ id: tableId, kind: "table", label: table });
      const tableRelation: GraphEdge["relation"] = metadataType === "ui_action" ? "affects" : "belongs_to";
      const tableWhy = metadataType === "ui_action"
        ? "UI Action targets table"
        : "Record targets table";
      pushUniqueEdge(edges, {
        from: id,
        to: tableId,
        relation: tableRelation,
        why: tableWhy,
      });
    }

    if (updateSet) {
      const usId = `update_set:${updateSet}`;
      upsertNode({ id: usId, kind: "update_set", label: updateSet });
      pushUniqueEdge(edges, {
        from: id,
        to: usId,
        relation: "contains",
        why: "Record included in update set",
      });
    }

    const refs = extractReferencesFromScript(script);
    for (const t of refs.tables) {
      const tableId = `table:${t}`;
      upsertNode({ id: tableId, kind: "table", label: t });
      pushUniqueEdge(edges, {
        from: id,
        to: tableId,
        relation: "reads",
        why: "GlideRecord reference",
      });

      const tableScopeCode = extractScopeCodeFromTableName(t);
      if (tableScopeCode && ownScopeCode && tableScopeCode !== ownScopeCode) {
        const externalScopeId = `external_scope:${tableScopeCode}`;
        upsertNode({ id: externalScopeId, kind: "external_scope", label: tableScopeCode });
        pushUniqueEdge(edges, {
          from: id,
          to: externalScopeId,
          relation: "cross_scope_dependency",
          why: `GlideRecord cross-scope table reference (${t})`,
        });
      }
    }

    for (const api of refs.apis) {
      const apiId = `api:${api}`;
      upsertNode({ id: apiId, kind: "api", label: api });
      pushUniqueEdge(edges, {
        from: id,
        to: apiId,
        relation: "calls",
        why: "REST message reference",
      });
    }

    for (const include of refs.includes) {
      const includeId = `script:${include}`;
      upsertNode({ id: includeId, kind: "script", label: include });
      const relation: GraphEdge["relation"] = (metadataType === "ui_script" || metadataType === "ui_action")
        ? "calls"
        : "depends_on";
      const why = metadataType === "ui_script"
        ? "UI Script GlideAjax/Script include invocation"
        : metadataType === "ui_action"
          ? "UI Action script include invocation"
        : "Script include instantiation";
      pushUniqueEdge(edges, {
        from: id,
        to: includeId,
        relation,
        why,
      });

      const includeScopeCode = extractScopeCodeFromIncludeName(include);
      if (includeScopeCode && ownScopeCode && includeScopeCode !== ownScopeCode) {
        const externalScopeId = `external_scope:${includeScopeCode}`;
        upsertNode({ id: externalScopeId, kind: "external_scope", label: includeScopeCode });
        pushUniqueEdge(edges, {
          from: id,
          to: externalScopeId,
          relation: "cross_scope_dependency",
          why: `Cross-scope script include call (${include})`,
        });
      }

      const isGlobalInclude = !include.includes(".") && !include.toLowerCase().startsWith("x_");
      if (isGlobalInclude) {
        const globalId = "external_scope:global";
        upsertNode({ id: globalId, kind: "external_scope", label: "global" });
        pushUniqueEdge(edges, {
          from: id,
          to: globalId,
          relation: "global_dependency",
          why: `Global script include dependency (${include})`,
        });
      }
    }

    const meta = extractMetaRelationsFromRecord(rec);
    for (const t of meta.tables) {
      const tableId = `table:${t}`;
      upsertNode({ id: tableId, kind: "table", label: t });
      pushUniqueEdge(edges, {
        from: id,
        to: tableId,
        relation: "affects",
        why: "Meta relation declared by record",
      });
    }

    for (const include of meta.includes) {
      const includeId = `script:${include}`;
      upsertNode({ id: includeId, kind: "script", label: include });
      pushUniqueEdge(edges, {
        from: id,
        to: includeId,
        relation: "depends_on",
        why: "Meta include dependency declared by record",
      });
    }
  }

  return { nodes, edges };
}

export function detectGraphCycles(graph: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): Array<Record<string, unknown>> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const cycles = new Set<string>();
  const stack: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string) => {
    visiting.add(node);
    stack.push(node);
    const next = adjacency.get(node) || [];

    for (const child of next) {
      if (!visited.has(child) && !visiting.has(child)) {
        dfs(child);
        continue;
      }
      if (visiting.has(child)) {
        const idx = stack.indexOf(child);
        if (idx >= 0) {
          const cyclePath = [...stack.slice(idx), child];
          cycles.add(cyclePath.join(" -> "));
        }
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id);
    }
  }

  return [...cycles]
    .sort((a, b) => a.localeCompare(b))
    .map((line) => {
      const path = line.split(" -> ");
      return {
        path,
        length: path.length,
      };
    });
}

export function summarizeGraphHotspots(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  limit: number = 5
): Array<Record<string, unknown>> {
  const outDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
  }

  const rows = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    outDegree: outDegree.get(node.id) || 0,
  }));

  rows.sort((a, b) => {
    if (b.outDegree !== a.outDegree) {
      return b.outDegree - a.outDegree;
    }
    return a.id.localeCompare(b.id);
  });

  return rows.slice(0, Math.max(limit, 1));
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/\r?\n/g, " ").trim();
}

function toMermaidEntityName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  if (!normalized) {
    return "TABLE_UNKNOWN";
  }
  const prefixed = /^[0-9]/.test(normalized) ? `T_${normalized}` : normalized;
  return prefixed.toUpperCase();
}

export function renderTableRelationshipMermaid(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  limit: number = 40
): string {
  const tableNodes = graph.nodes
    .filter((node) => node.id.startsWith("table:"))
    .slice(0, Math.max(1, limit));
  const tableIds = new Set(tableNodes.map((node) => node.id));

  const relationRows = graph.edges
    .filter((edge) => edge.from.startsWith("table:") && edge.to.startsWith("table:"))
    .filter((edge) => tableIds.has(edge.from) && tableIds.has(edge.to))
    .map((edge) => {
      const source = edge.from.slice("table:".length);
      const target = edge.to.slice("table:".length);
      const why = edge.why.toLowerCase();
      const label = why.includes("inheritance")
        ? "inherits"
        : why.includes("dictionary") || why.includes("reference")
          ? "references"
          : "depends_on";
      const connector = label === "inherits" ? "||--||" : "}o--||";
      return {
        source,
        target,
        label,
        connector,
      };
    })
    .filter((row) => row.source.length > 0 && row.target.length > 0)
    .sort((a, b) => {
      if (a.source !== b.source) {
        return a.source.localeCompare(b.source);
      }
      if (a.target !== b.target) {
        return a.target.localeCompare(b.target);
      }
      return a.label.localeCompare(b.label);
    });

  const lines: string[] = ["erDiagram"];
  if (relationRows.length === 0) {
    lines.push("  TABLE_UNKNOWN {");
    lines.push("    string no_relationships_detected");
    lines.push("  }");
    return lines.join("\n");
  }

  for (const row of relationRows) {
    lines.push(
      `  ${toMermaidEntityName(row.source)} ${row.connector} ${toMermaidEntityName(row.target)} : ${row.label}`
    );
  }

  return lines.join("\n");
}

export function renderDependencyGraphMermaid(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  limit: number = 30
): string {
  const maxNodes = Math.max(1, limit);
  const inbound = new Map<string, number>();
  for (const edge of graph.edges) {
    inbound.set(edge.to, (inbound.get(edge.to) || 0) + 1);
  }

  const ranked = [...graph.nodes]
    .sort((a, b) => {
      const left = inbound.get(a.id) || 0;
      const right = inbound.get(b.id) || 0;
      if (right !== left) {
        return right - left;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxNodes);

  const selected = new Map<string, GraphNode>();
  for (const node of ranked) {
    selected.set(node.id, node);
  }

  const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));
  const orderedNodes = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
  const aliasById = new Map<string, string>();
  orderedNodes.forEach((node, idx) => aliasById.set(node.id, `n${idx}`));

  const lines: string[] = ["flowchart TD"];
  for (const node of orderedNodes) {
    const alias = aliasById.get(node.id) || "n0";
    lines.push(`  ${alias}[\"${escapeMermaidLabel(node.label || node.id)}\"]`);
  }

  for (const edge of edges) {
    const from = aliasById.get(edge.from);
    const to = aliasById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    lines.push(`  ${from} -->|${escapeMermaidLabel(edge.relation)}| ${to}`);
  }

  lines.push("  classDef script fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;");
  lines.push("  classDef table fill:#dcfce7,stroke:#15803d,color:#14532d;");
  lines.push("  classDef api fill:#fed7aa,stroke:#c2410c,color:#7c2d12;");
  lines.push("  classDef update_set fill:#f3f4f6,stroke:#4b5563,color:#111827;");
  lines.push("  classDef record fill:#f3f4f6,stroke:#4b5563,color:#111827;");
  lines.push("  classDef scheduled_job fill:#ede9fe,stroke:#6d28d9,color:#4c1d95;");
  lines.push("  classDef external_scope fill:#fecaca,stroke:#b91c1c,color:#7f1d1d;");

  const aliasesByKind = new Map<GraphNode["kind"], string[]>();
  for (const node of orderedNodes) {
    const alias = aliasById.get(node.id);
    if (!alias) {
      continue;
    }
    const list = aliasesByKind.get(node.kind) || [];
    list.push(alias);
    aliasesByKind.set(node.kind, list);
  }

  for (const [kind, aliases] of aliasesByKind.entries()) {
    if (aliases.length === 0) {
      continue;
    }
    lines.push(`  class ${aliases.join(",")} ${kind}`);
  }

  return lines.join("\n");
}

export function rankImpact(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  targetId: string
): Array<Record<string, unknown>> {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }

  const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
  const seen = new Set<string>([targetId]);
  const impacted: Array<Record<string, unknown>> = [];

  while (queue.length > 0) {
    const current = queue.shift() as { id: string; depth: number };
    const out = adjacency.get(current.id) || [];
    for (const edge of out) {
      if (seen.has(edge.to)) {
        continue;
      }
      seen.add(edge.to);
      const depth = current.depth + 1;
      queue.push({ id: edge.to, depth });

      const severity = depth === 1 ? "high" : depth === 2 ? "medium" : "low";
      impacted.push({
        id: edge.to,
        severity,
        depth,
        relation: edge.relation,
        why: edge.why,
      });
    }
  }

  const severityScore: Record<string, number> = { high: 3, medium: 2, low: 1 };
  impacted.sort((a, b) => {
    const sa = severityScore[toStringField(a.severity)] || 0;
    const sb = severityScore[toStringField(b.severity)] || 0;
    if (sa !== sb) {
      return sb - sa;
    }
    return (a.depth as number) - (b.depth as number);
  });

  return impacted;
}

export function summarizeBlastRadius(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  impact: Array<Record<string, unknown>>
): Record<string, unknown> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const item of impact) {
    const id = toStringField(item.id);
    const severity = toStringField(item.severity) || "unknown";
    const kind = nodeById.get(id)?.kind || "record";
    byKind[kind] = (byKind[kind] || 0) + 1;
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }

  return {
    totalImpacted: impact.length,
    byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => a[0].localeCompare(b[0]))),
    bySeverity: Object.fromEntries(Object.entries(bySeverity).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

export function validateChangePackage(
  selectedIds: string[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
): Record<string, unknown> {
  const selected = new Set(selectedIds);
  const missing: Array<Record<string, unknown>> = [];

  for (const edge of graph.edges) {
    if (!selected.has(edge.from)) {
      continue;
    }
    if (selected.has(edge.to)) {
      continue;
    }

    missing.push({
      requiredId: edge.to,
      requiredBy: edge.from,
      relation: edge.relation,
      why: edge.why,
    });
  }

  return {
    valid: missing.length === 0,
    missingDependencies: missing,
    why: missing.map((m) => `Missing ${toStringField(m.requiredId)} for ${toStringField(m.requiredBy)}`),
  };
}

export function diffDependencyGraphs(
  before: { nodes: GraphNode[]; edges: GraphEdge[] },
  after: { nodes: GraphNode[]; edges: GraphEdge[] }
): Record<string, unknown> {
  const beforeNodes = new Set(before.nodes.map((n) => n.id));
  const afterNodes = new Set(after.nodes.map((n) => n.id));

  const toEdgeKey = (e: GraphEdge) => `${e.from}|${e.to}|${e.relation}|${e.why}`;
  const beforeEdges = new Set(before.edges.map(toEdgeKey));
  const afterEdges = new Set(after.edges.map(toEdgeKey));

  const addedNodes = [...afterNodes].filter((n) => !beforeNodes.has(n)).sort((a, b) => a.localeCompare(b));
  const removedNodes = [...beforeNodes].filter((n) => !afterNodes.has(n)).sort((a, b) => a.localeCompare(b));
  const addedEdges = [...afterEdges].filter((e) => !beforeEdges.has(e)).sort((a, b) => a.localeCompare(b));
  const removedEdges = [...beforeEdges].filter((e) => !afterEdges.has(e)).sort((a, b) => a.localeCompare(b));

  return {
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
  };
}

export function summarizeEdgeProvenance(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
): Array<Record<string, unknown>> {
  const counts = new Map<string, number>();

  for (const edge of graph.edges) {
    const key = `${edge.relation}|${edge.why}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const rows = [...counts.entries()].map(([key, count]) => {
    const [relation, why] = key.split("|");
    return { relation, why, count };
  });

  rows.sort((a, b) => {
    if (a.relation !== b.relation) {
      return a.relation.localeCompare(b.relation);
    }
    return a.why.localeCompare(b.why);
  });

  return rows;
}
