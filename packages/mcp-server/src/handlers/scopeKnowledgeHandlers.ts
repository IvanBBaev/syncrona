import { buildScopeKnowledgeIndex, buildTableFieldMarkdownDocs, rankMinimalFootprintTargets, renderScopeKnowledgeMarkdown, renderTableRelationshipMermaid, validateScopeKnowledgeIndex } from "../analysis";
import { getScopeDocsPaths, getScopeKnowledgePaths, getTableDependencyReportPaths, normalizeScopeCode } from "../scopePaths";
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

type ScopeKnowledgeHydrated = {
  entities: Array<Record<string, unknown>>;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  sourceSummary: Record<string, unknown>;
  autodiscovered: boolean;
  serviceNowDiscovered: boolean;
};

type ScopeKnowledgeContext = {
  timeoutMs: number;
  dryRun: boolean;
  resolveScopeCode: (scopeArg: string, timeoutMs: number) => Promise<string>;
  hydrateScopeKnowledgeInputs: (
    entities: Array<Record<string, unknown>>,
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    scopeCode: string,
    timeoutMs: number
  ) => Promise<ScopeKnowledgeHydrated>;
  safeGetSessionContext: (timeoutMs: number) => Promise<Record<string, unknown> | null>;
  asRecord: (value: unknown) => Record<string, unknown>;
  toGraphFromUnknown: (value: unknown) => { nodes: GraphNode[]; edges: GraphEdge[] };
  writeJsonAndMarkdown: (paths: { dir: string; jsonPath: string; markdownPath: string }, index: unknown, markdown: string) => void;
  writeTableDocs: (scopeCode: string, docs: Array<{ tableName: string; markdown: string }>) => string[];
  writeScopeDocsBundle: (scopeCode: string, files: Array<{ relativePath: string; content: string }>) => string[];
};

function toRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeGraphFromIndex(index: Record<string, unknown>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const dependencyNodesRaw = Array.isArray(index.dependencyNodes) ? index.dependencyNodes : [];
  const dependencies = Array.isArray(index.dependencies) ? index.dependencies : [];

  return {
    nodes: dependencyNodesRaw
      .map((item) => ({
        id: toStringField((item as Record<string, unknown>).id),
        kind: (toStringField((item as Record<string, unknown>).kind) || "record") as GraphNode["kind"],
        label: toStringField((item as Record<string, unknown>).label),
      }))
      .filter((item) => item.id.length > 0),
    edges: dependencies
      .map((item) => ({
        from: toStringField((item as Record<string, unknown>).from),
        to: toStringField((item as Record<string, unknown>).to),
        relation: (toStringField((item as Record<string, unknown>).relation) || "depends_on") as GraphEdge["relation"],
        why: toStringField((item as Record<string, unknown>).why),
      }))
      .filter((item) => item.from.length > 0 && item.to.length > 0),
  };
}

function renderScopeDocsReadme(index: Record<string, unknown>): string {
  const scope = toStringField(index.scope) || "unknown_scope";
  const entities = Array.isArray(index.entities) ? index.entities : [];
  const dependencies = Array.isArray(index.dependencies) ? index.dependencies : [];
  const risks = Array.isArray(index.risks) ? index.risks : [];
  const referencedTables = Array.isArray(index.referencedTables) ? index.referencedTables : [];

  const lines: string[] = [];
  lines.push(`# Scope Docs: ${scope}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Entities: ${entities.length}`);
  lines.push(`- Dependencies: ${dependencies.length}`);
  lines.push(`- Risks: ${risks.length}`);
  lines.push(`- Referenced tables: ${referencedTables.length}`);
  lines.push("");
  lines.push("## Contents");
  lines.push("- dependencies.md");
  lines.push("- table-relationships.md");
  lines.push("- cross-scope-dependencies.md");
  lines.push("- tables/");
  lines.push("- business-rules/");
  lines.push("- script-includes/");
  lines.push("- client-scripts/");
  lines.push("- ui-actions/");
  lines.push("- ui-scripts/");
  lines.push("- scheduled-jobs/");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function renderCrossScopeDependenciesMarkdown(index: Record<string, unknown>): string {
  const dependencies = Array.isArray(index.dependencies) ? index.dependencies : [];
  const referencedTables = Array.isArray(index.referencedTables) ? index.referencedTables : [];
  const lines: string[] = [];
  lines.push("# Cross-scope Dependencies");
  lines.push("");
  lines.push("## External Scopes and Global");

  const cross = dependencies
    .map((item) => item as Record<string, unknown>)
    .filter((item) => {
      const relation = toStringField(item.relation);
      return relation === "cross_scope_dependency" || relation === "global_dependency";
    });
  if (cross.length === 0) {
    lines.push("- No external scope/global dependency edges detected.");
  } else {
    for (const row of cross) {
      lines.push(`- ${toStringField(row.from)} -> ${toStringField(row.to)} (${toStringField(row.relation)})`);
    }
  }
  lines.push("");
  lines.push("## External Referenced Tables");
  const externalTables = referencedTables
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.inScope !== true);
  if (externalTables.length === 0) {
    lines.push("- No external referenced tables.");
  } else {
    for (const row of externalTables) {
      lines.push(`- ${toStringField(row.targetTable)} (sources=${Number(row.sourceCount) || 0})`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function renderEntityDoc(entity: Record<string, unknown>, dependencies: GraphEdge[]): string {
  const id = toStringField(entity.id);
  const name = toStringField(entity.name) || id;
  const metadataType = toStringField(entity.metadataType) || "record";
  const tableName = toStringField(entity.tableName) || "-";
  const script = toStringField(entity.script).trim();
  const excerpt = script.length > 220 ? `${script.slice(0, 220)}...` : script;
  const outgoing = dependencies.filter((edge) => edge.from === id).slice(0, 40);

  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push("");
  lines.push("## Metadata");
  lines.push(`- id: ${id}`);
  lines.push(`- type: ${metadataType}`);
  lines.push(`- table: ${tableName}`);
  lines.push("");
  lines.push("## Script Excerpt");
  lines.push(excerpt ? excerpt : "n/a");
  lines.push("");
  lines.push("## Dependencies");
  if (outgoing.length === 0) {
    lines.push("- none");
  } else {
    for (const edge of outgoing) {
      lines.push(`- ${edge.relation}: ${edge.to} (${edge.why})`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export async function handleScopeKnowledgeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ScopeKnowledgeContext
): Promise<ToolResponse | null> {
  const { timeoutMs, dryRun } = context;

  switch (toolName) {
    case "sync_generate_scope_knowledge": {
      const scopeArg = typeof args.scope === "string" ? args.scope.trim() : "";
      const scope = await context.resolveScopeCode(scopeArg, timeoutMs);
      const entities = toRecordArray(args.entities);
      const graph = context.toGraphFromUnknown(args.graph);
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const risks = toRecordArray(args.risks);
      const suppressions = toRecordArray(args.suppressions);
      const updateSetContext = context.asRecord(args.updateSetContext);
      const trigger = typeof args.trigger === "string" ? args.trigger : "manual";
      const writeFiles = args.writeFiles === true;

      const hydrated = await context.hydrateScopeKnowledgeInputs(entities, graph, scope, timeoutMs);
      const recommendedEditTargets = task
        ? rankMinimalFootprintTargets(task, hydrated.graph, 10)
        : rankMinimalFootprintTargets(scope, hydrated.graph, 5);
      const index = buildScopeKnowledgeIndex({
        scope,
        entities: hydrated.entities,
        graph: hydrated.graph,
        risks,
        suppressions,
        updateSetContext,
        sourceSummary: hydrated.sourceSummary,
        recommendedEditTargets,
      });
      const markdown = renderScopeKnowledgeMarkdown(index);
      const validation = validateScopeKnowledgeIndex(index);
      const paths = getScopeKnowledgePaths(scope);

      const payload: Record<string, unknown> = {
        autodiscovered: hydrated.autodiscovered,
        serviceNowDiscovered: hydrated.serviceNowDiscovered,
        sourceSummary: hydrated.sourceSummary,
        entityCount: hydrated.entities.length,
        dependencyCount: hydrated.graph.edges.length,
        trigger,
        scope: normalizeScopeCode(scope),
        validation,
        paths,
        index,
        markdown,
      };

      if (dryRun || !writeFiles) {
        return {
          isError: validation.valid !== true,
          content: [{ type: "text", text: toJsonText(payload) }],
        };
      }

      context.writeJsonAndMarkdown(paths, index, markdown);
      const tableDocs = buildTableFieldMarkdownDocs(index);
      const tableDocPaths = context.writeTableDocs(scope, tableDocs);

      return {
        isError: validation.valid !== true,
        content: [{
          type: "text",
          text: toJsonText({
            ...payload,
            written: true,
            tableDocs: {
              count: tableDocPaths.length,
              paths: tableDocPaths,
            },
          }),
        }],
      };
    }

    case "sync_validate_scope_knowledge": {
      const index = context.asRecord(args.index);
      const validation = validateScopeKnowledgeIndex(index);
      return {
        isError: validation.valid !== true,
        content: [{ type: "text", text: toJsonText(validation) }],
      };
    }

    case "sync_generate_scope_docs": {
      const scopeArg = typeof args.scope === "string" ? args.scope.trim() : "";
      const scope = await context.resolveScopeCode(scopeArg, timeoutMs);
      const entities = toRecordArray(args.entities);
      const graph = context.toGraphFromUnknown(args.graph);
      const task = typeof args.task === "string" ? args.task.trim() : "scope docs";
      const writeFiles = args.writeFiles === true;
      const includeFields = args.includeFields !== false;
      const includeDiagrams = args.includeDiagrams !== false;
      const includeScheduledJobs = args.includeScheduledJobs !== false;
      const includeCrossScope = args.includeCrossScope !== false;

      const hydrated = await context.hydrateScopeKnowledgeInputs(entities, graph, scope, timeoutMs);
      const recommendedEditTargets = rankMinimalFootprintTargets(task, hydrated.graph, 10);
      const index = buildScopeKnowledgeIndex({
        scope,
        entities: hydrated.entities,
        graph: hydrated.graph,
        sourceSummary: hydrated.sourceSummary,
        recommendedEditTargets,
      });
      const validation = validateScopeKnowledgeIndex(index);
      const dependenciesMarkdown = renderScopeKnowledgeMarkdown(index);
      const graphData = normalizeGraphFromIndex(index);
      const tableRelationshipMarkdown = [
        "# Table Relationships",
        "",
        "```mermaid",
        includeDiagrams
          ? renderTableRelationshipMermaid(graphData, 60)
          : "erDiagram\n  NOTE ||--|| NOTE : disabled",
        "```",
        "",
      ].join("\n");
      const readmeMarkdown = renderScopeDocsReadme(index);
      const crossScopeMarkdown = includeCrossScope
        ? renderCrossScopeDependenciesMarkdown(index)
        : "# Cross-scope Dependencies\n\n- disabled by includeCrossScope=false\n";
      const tableDocs = includeFields ? buildTableFieldMarkdownDocs(index) : [];
      const docsRoot = getScopeDocsPaths(scope);
      const normalizedScope = normalizeScopeCode(scope);
      const dependenciesPath = `${docsRoot.dir}/dependencies.md`;
      const tableRelationshipsPath = `${docsRoot.dir}/table-relationships.md`;
      const crossScopePath = `${docsRoot.dir}/cross-scope-dependencies.md`;

      const byType = (type: string) =>
        hydrated.entities
          .map((item) => context.asRecord(item))
          .filter((item) => toStringField(item.metadataType) === type)
          .slice(0, 200);

      const buildEntityFiles = (entitiesByType: Record<string, Record<string, unknown>[]>) => {
        const files: Array<{ relativePath: string; content: string }> = [];
        for (const [folder, rows] of Object.entries(entitiesByType)) {
          for (const row of rows) {
            const fileNameBase = normalizeScopeCode(toStringField(row.name) || toStringField(row.id) || "item");
            files.push({
              relativePath: `${folder}/${fileNameBase}.md`,
              content: renderEntityDoc(row, graphData.edges),
            });
          }
        }
        return files;
      };

      const files: Array<{ relativePath: string; content: string }> = [
        { relativePath: "README.md", content: readmeMarkdown },
        { relativePath: "dependencies.md", content: dependenciesMarkdown },
        { relativePath: "table-relationships.md", content: tableRelationshipMarkdown },
        { relativePath: "cross-scope-dependencies.md", content: crossScopeMarkdown },
      ];

      for (const tableDoc of tableDocs) {
        files.push({
          relativePath: `tables/${normalizeScopeCode(tableDoc.tableName)}.md`,
          content: tableDoc.markdown,
        });
      }

      files.push(
        ...buildEntityFiles({
          "business-rules": byType("business_rule"),
          "script-includes": byType("script_include"),
          "client-scripts": byType("client_script"),
          "ui-actions": byType("ui_action"),
          "ui-scripts": byType("ui_script"),
          "scheduled-jobs": includeScheduledJobs ? byType("scheduled_job") : [],
        })
      );

      const payload: Record<string, unknown> = {
        scope: normalizedScope,
        validation,
        includeFields,
        includeDiagrams,
        includeScheduledJobs,
        includeCrossScope,
        serviceNowDiscovered: hydrated.serviceNowDiscovered,
        autodiscovered: hydrated.autodiscovered,
        sourceSummary: hydrated.sourceSummary,
        entityCount: hydrated.entities.length,
        dependencyCount: hydrated.graph.edges.length,
        paths: {
          dir: docsRoot.dir,
          readmePath: docsRoot.readmePath,
          dependenciesPath,
          tableRelationshipsPath,
          crossScopePath,
        },
        files: files.map((file) => `${docsRoot.dir}/${file.relativePath}`),
      };

      if (dryRun || !writeFiles) {
        return {
          isError: validation.valid !== true,
          content: [{ type: "text", text: toJsonText(payload) }],
        };
      }

      const writtenPaths = context.writeScopeDocsBundle(scope, files);
      return {
        isError: validation.valid !== true,
        content: [{ type: "text", text: toJsonText({ ...payload, written: true, writtenPaths }) }],
      };
    }

    case "sync_scope_knowledge_auto_update": {
      const trigger = typeof args.trigger === "string" ? args.trigger : "";
      if (!trigger) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: trigger" }],
        };
      }

      const delegatedArgs: Record<string, unknown> = {
        ...args,
        trigger,
        writeFiles: args.writeFiles === true,
      };

      const scopeArg = typeof delegatedArgs.scope === "string" ? delegatedArgs.scope : "";
      const scope = await context.resolveScopeCode(scopeArg, timeoutMs);
      const entities = toRecordArray(delegatedArgs.entities);
      const graph = context.toGraphFromUnknown(delegatedArgs.graph);
      const task = typeof delegatedArgs.task === "string" ? delegatedArgs.task : trigger;
      const hydrated = await context.hydrateScopeKnowledgeInputs(entities, graph, scope, timeoutMs);
      const recommendedEditTargets = rankMinimalFootprintTargets(task, hydrated.graph, 8);
      const sessionContext = (await context.safeGetSessionContext(timeoutMs)) || {
        updateSet: delegatedArgs.updateSetContext,
      };
      const index = buildScopeKnowledgeIndex({
        scope,
        entities: hydrated.entities,
        graph: hydrated.graph,
        updateSetContext: context.asRecord(context.asRecord(sessionContext).updateSet),
        sourceSummary: hydrated.sourceSummary,
        recommendedEditTargets,
      });
      const markdown = renderScopeKnowledgeMarkdown(index);
      const validation = validateScopeKnowledgeIndex(index);
      const paths = getScopeKnowledgePaths(scope);

      if (!dryRun && delegatedArgs.writeFiles === true) {
        context.writeJsonAndMarkdown(paths, index, markdown);
        const tableDocs = buildTableFieldMarkdownDocs(index);
        context.writeTableDocs(scope, tableDocs);
      }

      return {
        isError: validation.valid !== true,
        content: [
          {
            type: "text",
            text: toJsonText({
              trigger,
              dryRun,
              autodiscovered: hydrated.autodiscovered,
              serviceNowDiscovered: hydrated.serviceNowDiscovered,
              sourceSummary: hydrated.sourceSummary,
              wroteFiles: !dryRun && delegatedArgs.writeFiles === true,
              paths,
              validation,
              recommendedEditTargetsCount: recommendedEditTargets.length,
            }),
          },
        ],
      };
    }

    case "sync_generate_table_dependency_report": {
      const scopeArg = typeof args.scope === "string" ? args.scope.trim() : "";
      const scope = await context.resolveScopeCode(scopeArg, timeoutMs);
      const task = typeof args.task === "string" && args.task.trim()
        ? args.task.trim()
        : "table dependencies report";
      const writeFiles = args.writeFiles === true;

      const hydrated = await context.hydrateScopeKnowledgeInputs([], context.toGraphFromUnknown({}), scope, timeoutMs);
      const recommendedEditTargets = rankMinimalFootprintTargets(task, hydrated.graph, 8);
      const index = buildScopeKnowledgeIndex({
        scope,
        entities: hydrated.entities,
        graph: hydrated.graph,
        sourceSummary: hydrated.sourceSummary,
        recommendedEditTargets,
      });
      const markdown = renderScopeKnowledgeMarkdown(index);
      const validation = validateScopeKnowledgeIndex(index);
      const paths = getTableDependencyReportPaths(scope);

      if (!dryRun && writeFiles) {
        context.writeJsonAndMarkdown(paths, index, markdown);
      }

      return {
        isError: validation.valid !== true,
        content: [
          {
            type: "text",
            text: toJsonText({
              scope: normalizeScopeCode(scope),
              task,
              sourceSummary: hydrated.sourceSummary,
              serviceNowDiscovered: hydrated.serviceNowDiscovered,
              autodiscovered: hydrated.autodiscovered,
              dependencyCount: hydrated.graph.edges.length,
              wroteFiles: !dryRun && writeFiles,
              paths,
              validation,
            }),
          },
        ],
      };
    }

    default:
      return null;
  }
}
