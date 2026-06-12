import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  promises as fsPromises,
} from "fs";
import path from "path";
import {
  buildDependencyGraph,
  getMetadataConfig,
  normalizeMetadataRow,
  type MetadataType,
} from "../analysis";
import { tableGet } from "../sessionContext";

export type ScopeKnowledgeGraph = {
  nodes: Array<{
    id: string;
    kind:
      | "script"
      | "table"
      | "api"
      | "update_set"
      | "record"
      | "scheduled_job"
      | "external_scope";
    label: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relation:
      | "reads"
      | "writes"
      | "calls"
      | "contains"
      | "belongs_to"
      | "depends_on"
      | "affects"
      | "cross_scope_dependency"
      | "global_dependency";
    why: string;
  }>;
};

export function parseReferenceTargetsFromAttributes(attributesRaw: string): string[] {
  const attributes = attributesRaw.trim();
  if (!attributes) {
    return [];
  }

  const targets = new Set<string>();
  const keyValuePattern = /(?:^|,|\s)(?:table|ref_table|reference)\s*=\s*([a-z0-9_]+)/gi;
  for (const match of attributes.matchAll(keyValuePattern)) {
    const target = (match[1] || "").trim().toLowerCase();
    if (target) {
      targets.add(target);
    }
  }

  return [...targets.values()].sort();
}

export function classifyRelationVisibility(
  edge: ScopeKnowledgeGraph["edges"][number]
): "explicit" | "hidden" | "inferred" {
  const why = edge.why.toLowerCase();
  if (why.includes("dictionary reference") || why.includes("table inheritance")) {
    return "explicit";
  }
  if (why.includes("dictionary attribute hint")) {
    return "hidden";
  }
  return "inferred";
}

export function mergeScopeKnowledgeGraph(
  base: ScopeKnowledgeGraph,
  discovered: ScopeKnowledgeGraph
): ScopeKnowledgeGraph {
  const nodes = new Map<string, ScopeKnowledgeGraph["nodes"][number]>();
  for (const node of [...base.nodes, ...discovered.nodes]) {
    if (node.id) {
      nodes.set(node.id, node);
    }
  }

  const edges = new Map<string, ScopeKnowledgeGraph["edges"][number]>();
  for (const edge of [...base.edges, ...discovered.edges]) {
    if (edge.from && edge.to) {
      edges.set(`${edge.from}|${edge.to}|${edge.relation}|${edge.why}`, edge);
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => {
      const left = `${a.from}|${a.to}|${a.relation}|${a.why}`;
      const right = `${b.from}|${b.to}|${b.relation}|${b.why}`;
      return left.localeCompare(right);
    }),
  };
}

const PROJECT_DIR = process.cwd();

const RETRYABLE_FILE_IO_ERROR_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
]);
const MAX_FILE_IO_ATTEMPTS = 3;
const BASE_FILE_IO_RETRY_DELAY_MS = 20;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type WorkspaceScopeKnowledge = {
  entities: Array<Record<string, unknown>>;
  graph: ScopeKnowledgeGraph;
};

export type WorkspaceDiscoveryOptions = {
  concurrency?: number;
};

export function toGraphFromUnknown(value: unknown): {
  nodes: Array<{ id: string; kind: "script" | "table" | "api" | "update_set" | "record" | "scheduled_job" | "external_scope"; label: string }>;
  edges: Array<{ from: string; to: string; relation: "reads" | "writes" | "calls" | "contains" | "belongs_to" | "depends_on" | "affects" | "cross_scope_dependency" | "global_dependency"; why: string }>;
} {
  const graph = asRecord(value);
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
  const edges = Array.isArray(graph.edges)
    ? graph.edges.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
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
}

async function discoverServiceNowScopeKnowledge(
  scope: string,
  timeoutMs: number
): Promise<{
  entities: Array<Record<string, unknown>>;
  graph: ScopeKnowledgeGraph;
  relationEvidence: {
    explicit: number;
    hidden: number;
    inferred: number;
  };
}> {
  const normalizedScope = scope.trim();
  if (!normalizedScope || normalizedScope === "unknown_scope") {
    return {
      entities: [],
      graph: { nodes: [], edges: [] },
      relationEvidence: {
        explicit: 0,
        hidden: 0,
        inferred: 0,
      },
    };
  }

  const metadataTypes: MetadataType[] = [
    "business_rule",
    "client_script",
    "ui_script",
    "ui_action",
    "ui_formatter",
    "acl",
    "dictionary",
    "ui_policy",
    "scripted_rest",
    "scheduled_job",
  ];
  const entities: Array<Record<string, unknown>> = [];
  const graphRecords: Array<Record<string, unknown>> = [];
  const directNodes = new Map<string, ScopeKnowledgeGraph["nodes"][number]>();
  const directEdges: ScopeKnowledgeGraph["edges"] = [];

  const safeTableGet = async (
    table: string,
    fields: string[],
    query: string
  ): Promise<Array<Record<string, unknown>>> => {
    try {
      return await tableGet(
        table,
        {
          query,
          fields,
          limit: 500,
        },
        timeoutMs
      );
    } catch (_) {
      return [];
    }
  };

  for (const metadataType of metadataTypes) {
    const cfg = getMetadataConfig(metadataType);
    const fields = ["sys_id", cfg.displayField, "sys_scope"];
    if (cfg.scriptField) {
      fields.push(cfg.scriptField);
    }
    if (cfg.tableField) {
      fields.push(cfg.tableField);
    }
    if (metadataType === "ui_script") {
      fields.push("use_scoped_format");
    }
    if (metadataType === "ui_action") {
      fields.push("action_name", "type");
    }
    if (metadataType === "ui_formatter") {
      fields.push("formatter");
    }
    if (metadataType === "scheduled_job") {
      fields.push("run_type", "run_period", "run_time");
    }
    if (metadataType === "dictionary") {
      fields.push(
        "column_label",
        "internal_type",
        "max_length",
        "reference",
        "mandatory",
        "default_value",
        "attributes"
      );
    }

    const rows = await safeTableGet(cfg.table, fields, `sys_scope.scope=${normalizedScope}`);

    for (const row of rows) {
      const normalized = normalizeMetadataRow(metadataType, row);
      const sysId = toStringField(normalized.sysId) || toStringField(asRecord(normalized.raw).sys_id);
      const recordId = `record:${sysId || `${metadataType}:${entities.length + 1}`}`;
      const displayName = toStringField(normalized.name) || recordId;
      const targetTable = toStringField(normalized.tableName);
      entities.push({
        id: recordId,
        name: displayName,
        kind: "record",
        metadataType,
        metadataTable: cfg.table,
        tableName: targetTable,
        sysId,
        script: toStringField(normalized.script),
        useScopedFormat: metadataType === "ui_script"
          ? (row.use_scoped_format === true || toStringField(row.use_scoped_format) === "true")
          : false,
        actionName: metadataType === "ui_action" ? toStringField(row.action_name) : "",
        actionType: metadataType === "ui_action" ? toStringField(row.type) : "",
        formatter: metadataType === "ui_formatter" ? toStringField(row.formatter) : "",
        runType: metadataType === "scheduled_job" ? toStringField(row.run_type) : "",
        runPeriod: metadataType === "scheduled_job" ? toStringField(row.run_period) : "",
        runTime: metadataType === "scheduled_job" ? toStringField(row.run_time) : "",
        fieldName: metadataType === "dictionary" ? toStringField(row.element) : "",
        columnLabel: metadataType === "dictionary" ? toStringField(row.column_label) : "",
        internalType: metadataType === "dictionary" ? toStringField(row.internal_type) : "",
        maxLength: metadataType === "dictionary" ? toStringField(row.max_length) : "",
        reference: metadataType === "dictionary" ? toStringField(row.reference) : "",
        mandatory: metadataType === "dictionary"
          ? (row.mandatory === true || toStringField(row.mandatory) === "true")
          : false,
        defaultValue: metadataType === "dictionary" ? toStringField(row.default_value) : "",
        attributes: metadataType === "dictionary" ? toStringField(row.attributes) : "",
      });
      graphRecords.push({
        id: recordId,
        name: displayName,
        script: toStringField(normalized.script),
        table: targetTable,
        metaRelations: [
          `table:${cfg.table}`,
          `table:${targetTable}`,
        ].filter((item) => item !== "table:"),
      });
    }
  }

  const scriptIncludeRows = await safeTableGet(
    "sys_script_include",
    ["sys_id", "name", "script", "api_name", "sys_scope"],
    `sys_scope.scope=${normalizedScope}`
  );
  for (const row of scriptIncludeRows) {
    const sysId = toStringField(row.sys_id);
    const recordId = `record:${sysId || `script_include:${entities.length + 1}`}`;
    const displayName = toStringField(row.name) || recordId;
    entities.push({
      id: recordId,
      name: displayName,
      kind: "record",
      metadataType: "script_include",
      metadataTable: "sys_script_include",
      tableName: "",
      sysId,
      apiName: toStringField(row.api_name),
    });
    graphRecords.push({
      id: recordId,
      name: displayName,
      script: toStringField(row.script),
      metaRelations: ["table:sys_script_include"],
    });
  }

  const scopedTables = await safeTableGet(
    "sys_db_object",
    ["sys_id", "name", "super_class", "sys_scope"],
    `sys_scope.scope=${normalizedScope}`
  );
  for (const row of scopedTables) {
    const tableName = toStringField(row.name);
    const sysId = toStringField(row.sys_id);
    if (!tableName) {
      continue;
    }
    const tableNodeId = `table:${tableName}`;
    directNodes.set(tableNodeId, { id: tableNodeId, kind: "table", label: tableName });
    entities.push({
      id: `record:${sysId || tableNodeId}`,
      name: tableName,
      kind: "record",
      metadataType: "table",
      metadataTable: "sys_db_object",
      tableName,
      sysId,
    });

    const parent = asRecord(row.super_class);
    const parentName = toStringField(parent.value) || toStringField(parent.display_value);
    if (parentName) {
      const parentNodeId = `table:${parentName}`;
      directNodes.set(parentNodeId, { id: parentNodeId, kind: "table", label: parentName });
      directEdges.push({
        from: tableNodeId,
        to: parentNodeId,
        relation: "depends_on",
        why: "ServiceNow table inheritance",
      });
    }
  }

  const scopedTableNames = scopedTables
    .map((row) => toStringField(row.name))
    .filter((name) => name.length > 0)
    .sort();
  if (scopedTableNames.length > 0) {
    const tableQuery = `nameIN${scopedTableNames.join(",")}`;
    const dictionaryRows = await safeTableGet(
      "sys_dictionary",
      ["name", "element", "internal_type", "reference", "attributes"],
      tableQuery
    );

    for (const row of dictionaryRows) {
      const sourceTable = toStringField(row.name);
      const fieldName = toStringField(row.element) || "<field>";
      if (!sourceTable) {
        continue;
      }

      const sourceNodeId = `table:${sourceTable}`;
      directNodes.set(sourceNodeId, { id: sourceNodeId, kind: "table", label: sourceTable });

      const internalType = toStringField(row.internal_type).toLowerCase();
      const explicitTarget = toStringField(row.reference).toLowerCase();
      const attributeTargets = parseReferenceTargetsFromAttributes(toStringField(row.attributes));

      if (explicitTarget) {
        const targetNodeId = `table:${explicitTarget}`;
        directNodes.set(targetNodeId, { id: targetNodeId, kind: "table", label: explicitTarget });
        directEdges.push({
          from: sourceNodeId,
          to: targetNodeId,
          relation: "depends_on",
          why: `Dictionary reference (${fieldName}:${internalType || "reference"})`,
        });
      }

      for (const hintedTarget of attributeTargets) {
        const targetNodeId = `table:${hintedTarget}`;
        directNodes.set(targetNodeId, { id: targetNodeId, kind: "table", label: hintedTarget });
        directEdges.push({
          from: sourceNodeId,
          to: targetNodeId,
          relation: "depends_on",
          why: `Dictionary attribute hint (${fieldName})`,
        });
      }
    }
  }

  const baseGraph = buildDependencyGraph(graphRecords);
  const graphWithServiceNowRelations = mergeScopeKnowledgeGraph(baseGraph, {
    nodes: [...directNodes.values()],
    edges: directEdges,
  });

  const relationEvidence = { explicit: 0, hidden: 0, inferred: 0 };
  for (const edge of graphWithServiceNowRelations.edges) {
    const visibility = classifyRelationVisibility(edge);
    relationEvidence[visibility] += 1;
  }

  return {
    entities,
    graph: graphWithServiceNowRelations,
    relationEvidence,
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const limit = Math.max(1, concurrency);
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await worker(next);
    }
  });

  await Promise.all(workers);
}

function isRetryableFileIoError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { code?: unknown };
  if (typeof maybeError.code !== "string") {
    return false;
  }

  return RETRYABLE_FILE_IO_ERROR_CODES.has(maybeError.code.toUpperCase());
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withFileIoRetries<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FILE_IO_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFileIoError(error) || attempt >= MAX_FILE_IO_ATTEMPTS) {
        throw error;
      }

      const delay = Math.min(BASE_FILE_IO_RETRY_DELAY_MS * 2 ** (attempt - 1), 200);
      await delayMs(delay);
    }
  }

  throw lastError;
}

export async function discoverWorkspaceScopeKnowledgeAsync(
  projectDir: string = PROJECT_DIR,
  options: WorkspaceDiscoveryOptions = {}
): Promise<WorkspaceScopeKnowledge> {
  const sourceDir = path.join(projectDir, "src");
  if (!existsSync(sourceDir)) {
    return {
      entities: [],
      graph: { nodes: [], edges: [] },
    };
  }

  const entities = new Map<string, Record<string, unknown>>();
  const nodes = new Map<string, ScopeKnowledgeGraph["nodes"][number]>();
  const edges = new Map<string, ScopeKnowledgeGraph["edges"][number]>();
  const tablePattern = /(?:new\s+)?Glide(?:Record|Aggregate)(?:<[^>]+>)?\s*\(\s*["']([a-z0-9_]+)["']\s*\)/g;
  const stack = [sourceDir];
  const candidateFiles: string[] = [];
  const concurrency = Math.min(Math.max(options.concurrency ?? 20, 1), 100);

  while (stack.length > 0) {
    const currentDir = stack.pop() || sourceDir;
    let entryNames: string[] = [];
    try {
      entryNames = await withFileIoRetries(() => fsPromises.readdir(currentDir));
    } catch (_) {
      continue;
    }

    for (const entryName of entryNames) {
      const entryPath = path.join(currentDir, entryName);
      let stats;
      try {
        stats = await withFileIoRetries(() => fsPromises.stat(entryPath));
      } catch (_) {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!/\.(?:js|ts|sn\.ts|xml|json)$/i.test(entryName)) {
        continue;
      }

      candidateFiles.push(entryPath);
    }
  }

  await mapWithConcurrency(candidateFiles, concurrency, async (entryPath) => {
    const relativePath = path.relative(projectDir, entryPath).split(path.sep).join("/");
    const entityId = `file:${relativePath}`;
    const kind = /\.(?:js|ts|sn\.ts)$/i.test(path.basename(entryPath)) ? "script" : "record";
    const label = relativePath.replace(/^src\//, "").replace(/\.(?:sn\.)?(?:ts|js|xml|json)$/i, "");

    entities.set(entityId, {
      id: entityId,
      name: label,
      path: relativePath,
      kind,
    });
    nodes.set(entityId, { id: entityId, kind, label });

    let raw = "";
    try {
      raw = await withFileIoRetries(() => fsPromises.readFile(entryPath, "utf-8"));
    } catch (_) {
      return;
    }

    tablePattern.lastIndex = 0;
    for (const match of raw.matchAll(tablePattern)) {
      const tableName = (match[1] || "").trim();
      if (!tableName) {
        continue;
      }
      const tableNodeId = `table:${tableName}`;
      nodes.set(tableNodeId, { id: tableNodeId, kind: "table", label: tableName });
      edges.set(`${entityId}|${tableNodeId}|reads`, {
        from: entityId,
        to: tableNodeId,
        relation: "reads",
        why: `Referenced via Glide API in ${relativePath}`,
      });
    }
  });

  return {
    entities: [...entities.values()].sort((a, b) => toStringField(a.id).localeCompare(toStringField(b.id))),
    graph: {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => {
        const left = `${a.from}|${a.to}|${a.relation}|${a.why}`;
        const right = `${b.from}|${b.to}|${b.relation}|${b.why}`;
        return left.localeCompare(right);
      }),
    },
  };
}

export function discoverWorkspaceScopeKnowledge(projectDir: string = PROJECT_DIR): WorkspaceScopeKnowledge {
  const sourceDir = path.join(projectDir, "src");
  if (!existsSync(sourceDir)) {
    return {
      entities: [],
      graph: { nodes: [], edges: [] },
    };
  }

  const entities = new Map<string, Record<string, unknown>>();
  const nodes = new Map<string, ScopeKnowledgeGraph["nodes"][number]>();
  const edges = new Map<string, ScopeKnowledgeGraph["edges"][number]>();
  const tablePattern = /(?:new\s+)?Glide(?:Record|Aggregate)(?:<[^>]+>)?\s*\(\s*["']([a-z0-9_]+)["']\s*\)/g;
  const stack = [sourceDir];

  while (stack.length > 0) {
    const currentDir = stack.pop() || sourceDir;
    for (const entryName of readdirSync(currentDir)) {
      const entryPath = path.join(currentDir, entryName);
      let stats;
      try {
        stats = statSync(entryPath);
      } catch (_) {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!/\.(?:js|ts|sn\.ts|xml|json)$/i.test(entryName)) {
        continue;
      }

      const relativePath = path.relative(projectDir, entryPath).split(path.sep).join("/");
      const entityId = `file:${relativePath}`;
      const kind = /\.(?:js|ts|sn\.ts)$/i.test(entryName) ? "script" : "record";
      const label = relativePath.replace(/^src\//, "").replace(/\.(?:sn\.)?(?:ts|js|xml|json)$/i, "");

      entities.set(entityId, {
        id: entityId,
        name: label,
        path: relativePath,
        kind,
      });
      nodes.set(entityId, { id: entityId, kind, label });

      let raw = "";
      try {
        raw = readFileSync(entryPath, "utf-8");
      } catch (_) {
        continue;
      }

      tablePattern.lastIndex = 0;
      for (const match of raw.matchAll(tablePattern)) {
        const tableName = (match[1] || "").trim();
        if (!tableName) {
          continue;
        }
        const tableNodeId = `table:${tableName}`;
        nodes.set(tableNodeId, { id: tableNodeId, kind: "table", label: tableName });
        edges.set(`${entityId}|${tableNodeId}|reads`, {
          from: entityId,
          to: tableNodeId,
          relation: "reads",
          why: `Referenced via Glide API in ${relativePath}`,
        });
      }
    }
  }

  return {
    entities: [...entities.values()].sort((a, b) => toStringField(a.id).localeCompare(toStringField(b.id))),
    graph: {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => {
        const left = `${a.from}|${a.to}|${a.relation}|${a.why}`;
        const right = `${b.from}|${b.to}|${b.relation}|${b.why}`;
        return left.localeCompare(right);
      }),
    },
  };
}

export async function hydrateScopeKnowledgeInputs(
  entities: Array<Record<string, unknown>>,
  graph: ScopeKnowledgeGraph,
  scope: string,
  timeoutMs: number,
  projectDir: string = PROJECT_DIR
): Promise<{
  entities: Array<Record<string, unknown>>;
  graph: ScopeKnowledgeGraph;
  autodiscovered: boolean;
  serviceNowDiscovered: boolean;
  sourceSummary: Record<string, unknown>;
}> {
  const discovered = await discoverWorkspaceScopeKnowledgeAsync(projectDir, { concurrency: 20 });
  let serviceNowDiscovered = false;
  let serviceNowEntities: Array<Record<string, unknown>> = [];
  let serviceNowGraph: ScopeKnowledgeGraph = { nodes: [], edges: [] };
  let serviceNowRelationEvidence = { explicit: 0, hidden: 0, inferred: 0 };

  try {
    const serviceNow = await discoverServiceNowScopeKnowledge(scope, timeoutMs);
    serviceNowEntities = serviceNow.entities;
    serviceNowGraph = serviceNow.graph;
    serviceNowRelationEvidence = serviceNow.relationEvidence;
    serviceNowDiscovered = serviceNow.entities.length > 0 || serviceNow.graph.edges.length > 0;
  } catch (_) {
    serviceNowEntities = [];
    serviceNowGraph = { nodes: [], edges: [] };
    serviceNowRelationEvidence = { explicit: 0, hidden: 0, inferred: 0 };
  }

  const mergedEntities = new Map<string, Record<string, unknown>>();
  for (const entity of [...entities, ...serviceNowEntities, ...discovered.entities]) {
    const id = toStringField(entity.id);
    if (id) {
      mergedEntities.set(id, entity);
    }
  }

  const mergedGraph = mergeScopeKnowledgeGraph(
    mergeScopeKnowledgeGraph(graph, serviceNowGraph),
    discovered.graph
  );
  const autodiscovered = discovered.entities.length > 0 || discovered.graph.edges.length > 0;

  return {
    entities: [...mergedEntities.values()].sort((a, b) => toStringField(a.id).localeCompare(toStringField(b.id))),
    graph: mergedGraph,
    autodiscovered,
    serviceNowDiscovered,
    sourceSummary: {
      inputEntityCount: entities.length,
      inputDependencyCount: graph.edges.length,
      serviceNowEntityCount: serviceNowEntities.length,
      serviceNowDependencyCount: serviceNowGraph.edges.length,
      serviceNowRelationEvidence,
      localEntityCount: discovered.entities.length,
      localDependencyCount: discovered.graph.edges.length,
    },
  };
}
