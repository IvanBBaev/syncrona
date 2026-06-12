import path from "path";

const PROJECT_DIR = process.cwd();

export function normalizeScopeCode(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "unknown_scope";
  }
  return trimmed.replace(/[^a-z0-9_]+/g, "_");
}

export function getScopeKnowledgePaths(scopeCode: string): {
  dir: string;
  markdownPath: string;
  jsonPath: string;
} {
  const normalized = normalizeScopeCode(scopeCode);
  const dir = path.join(PROJECT_DIR, ".syncrona-mcp", "scopes");
  return {
    dir,
    markdownPath: path.join(dir, `${normalized}.md`),
    jsonPath: path.join(dir, `${normalized}.json`),
  };
}

export function getScopeDocsPaths(scopeCode: string): {
  dir: string;
  readmePath: string;
} {
  const normalized = normalizeScopeCode(scopeCode);
  const dir = path.join(PROJECT_DIR, ".syncrona-mcp", "docs", normalized);
  return {
    dir,
    readmePath: path.join(dir, "README.md"),
  };
}

export function getScopeTableDocsPaths(scopeCode: string): {
  dir: string;
  tablesDir: string;
} {
  const normalized = normalizeScopeCode(scopeCode);
  const dir = path.join(PROJECT_DIR, ".syncrona-mcp", "scopes", normalized);
  return {
    dir,
    tablesDir: path.join(dir, "tables"),
  };
}

export function getScopeTableDocPath(scopeCode: string, tableName: string): string {
  const { tablesDir } = getScopeTableDocsPaths(scopeCode);
  const normalizedTableName = normalizeScopeCode(tableName).replace(/^_+|_+$/g, "") || "table";
  return path.join(tablesDir, `${normalizedTableName}.md`);
}

export function getTableDependencyReportPaths(scopeCode: string): {
  dir: string;
  markdownPath: string;
  jsonPath: string;
} {
  const normalized = normalizeScopeCode(scopeCode);
  const dir = path.join(PROJECT_DIR, ".syncrona-mcp", "reports");
  return {
    dir,
    markdownPath: path.join(dir, `${normalized}-table-dependencies.md`),
    jsonPath: path.join(dir, `${normalized}-table-dependencies.json`),
  };
}

export function getWorkflowSimulationReportPaths(scopeCode: string, simulationId: string): {
  dir: string;
  markdownPath: string;
  jsonPath: string;
} {
  const normalizedScope = normalizeScopeCode(scopeCode);
  const normalizedSimulationId = normalizeScopeCode(simulationId || "default").replace(/^_+|_+$/g, "") || "default";
  const dir = path.join(PROJECT_DIR, ".syncrona-mcp", "reports");
  return {
    dir,
    markdownPath: path.join(
      dir,
      `${normalizedScope}-workflow-simulation-${normalizedSimulationId}.md`
    ),
    jsonPath: path.join(
      dir,
      `${normalizedScope}-workflow-simulation-${normalizedSimulationId}.json`
    ),
  };
}
