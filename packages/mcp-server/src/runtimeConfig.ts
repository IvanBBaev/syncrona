import path from "path";

export const DEFAULT_TIMEOUT_MS = 120000;
export const SERVER_NAME = "syncro-now-ai-mcp-server";
export const SERVER_VERSION = "0.1.0";
export const TOOL_CONTRACT_VERSION = "1.0.0";
export const PRIMARY_SYNCRO_CLI = "SyncroNow AI";
export const PROJECT_DIR = process.cwd();
export const AUDIT_DIR = path.join(PROJECT_DIR, ".syncrona-mcp");
export const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");
export const METRICS_FILE = path.join(AUDIT_DIR, "metrics.jsonl");
export const GUARDRAIL_CONFIG_FILE = path.join(PROJECT_DIR, "sync.mcp.guardrails.json");
export const AUTO_PULL_ALL_SCOPES_ENV = "SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES";
export const SCOPE_BOOTSTRAP_TIMEOUT_MS = 120000;
