# MCP Quickstart (Node 22)

## Prerequisites

1. Use Node 22 (`nvm use 22`).
2. Build the MCP server from this repository.
3. Run MCP with `cwd` set to your scoped app project.

In the commands below, replace the placeholder paths with your own:

- `<SYNCRONA_REPO>` — where you cloned this repository.
- `<SCOPE_PROJECT>` — your scoped app project directory (the one with
  `sync.config.js`).

## Build MCP Server

```bash
cd <SYNCRONA_REPO>
nvm use 22
npm install || npm install --ignore-scripts
npm run mcp:build
```

## Start MCP for Scope Project

Prefer the global credential store over inline env vars: run
`npx syncrona login` once, then start the server. If you must use env vars,
set your own values (never commit real credentials):

```bash
cd <SCOPE_PROJECT>
nvm use 22
export SN_INSTANCE=your-instance.service-now.com
export SN_USER=your.username
export SN_PASSWORD=your-password
node <SYNCRONA_REPO>/packages/mcp-server/dist/index.js
```

Keep this terminal running.

## Auto-pull on startup

By default the MCP server pulls scope metadata for all discoverable scopes in
the **background, after it has connected** (so it never blocks the MCP
handshake) — this primes the AI tools with scope knowledge. On large instances
or slow networks where you only need specific scopes, disable it:

```bash
export SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES=0   # also accepts false / no / off
```

With auto-pull off, generate scope knowledge on demand with the tool calls
below.

### Troubleshooting MCP startup
- **Client times out connecting** — usually a slow/unreachable instance; verify
  `SN_INSTANCE` and credentials, or disable auto-pull (above).
- **No tools appear** — check the client points at
  `<SYNCRONA_REPO>/packages/mcp-server/dist/index.js` and that `npm run mcp:build`
  ran (the `dist/` exists).
- **Nothing on stdout** — by design: the MCP server speaks JSON-RPC on stdout;
  all human-readable logs go to stderr.

## Generate Scope Knowledge

Run this tool call from an MCP-enabled chat client (replace `x_your_scope`
with your scope prefix):

```json
{
  "tool": "sync_generate_scope_knowledge",
  "arguments": {
    "scope": "x_your_scope",
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
    "scope": "x_your_scope",
    "task": "table dependencies report",
    "writeFiles": true
  }
}
```

Expected artifact paths:

- `.syncrona-mcp/reports/x_your_scope-table-dependencies.md`
- `.syncrona-mcp/reports/x_your_scope-table-dependencies.json`

## Verify Outputs

```bash
cd <SCOPE_PROJECT>
ls -la .syncrona-mcp/scopes
cat .syncrona-mcp/scopes/x_your_scope.md | head -n 120
```
