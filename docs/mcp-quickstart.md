# MCP Quickstart (Node 22)

## Prerequisites

1. Use Node 22.
2. Build the MCP server from this repository.
3. Run MCP with `cwd` set to the scoped app project.

## Build MCP Server

```bash
cd /Users/Ivan.Baev/Development/Incubation/syncrona
nvm use 22
npm install || npm install --ignore-scripts
npm run mcp:build
```

## Start MCP for Scope Project

```bash
cd /Users/Ivan.Baev/Development/Incubation/core-apps-ai/packages/cs
nvm use 22
export SN_INSTANCE=ven03019.service-now.com
export SN_USER=<user>
export SN_PASSWORD=<password>
node /Users/Ivan.Baev/Development/Incubation/syncrona/packages/mcp-server/dist/index.js
```

Keep this terminal running.

## Generate Scope Knowledge

Run this tool call from an MCP-enabled chat client:

```json
{
  "tool": "sync_generate_scope_knowledge",
  "arguments": {
    "scope": "x_nuvo_cs",
    "task": "table dependencies report",
    "writeFiles": true,
    "trigger": "manual"
  }
}
```

## One-command Table Dependency Report

Run this MCP tool call:

```json
{
  "tool": "sync_generate_table_dependency_report",
  "arguments": {
    "scope": "x_nuvo_cs",
    "task": "table dependencies report",
    "writeFiles": true
  }
}
```

Expected artifact paths:

- `.syncrona-mcp/reports/x_nuvo_cs-table-dependencies.md`
- `.syncrona-mcp/reports/x_nuvo_cs-table-dependencies.json`

## Verify Outputs

```bash
cd /Users/Ivan.Baev/Development/Incubation/core-apps-ai/packages/cs
ls -la .syncrona-mcp/scopes
cat .syncrona-mcp/scopes/x_nuvo_cs.md | head -n 120
```
