# MCP Server Architecture

## Package purpose

The package @syncrona/mcp-server exposes a ServiceNow-focused MCP server over stdio.
It enables AI clients to run safe operational workflows against:

- local Syncrona workspace commands
- ServiceNow Table API operations
- static analysis and risk workflows

## Main modules

### src/index.ts

Runtime orchestration layer.

Responsibilities:

- MCP tool declaration and routing
- safety and guardrail enforcement
- dry-run and audit behavior
- ServiceNow session helpers and table API calls
- mutation gating (preflight, approval, rollback evidence, footprint)

### src/analysis.ts

Pure analysis/utility layer.

Responsibilities:

- metadata normalization
- dependency graph extraction and analysis
- impact and drift summaries
- script architecture/security/performance checks
- suppression and weighted risk scoring
- scope-knowledge index/markdown generation
- planner ranking and onboarding helper

## Runtime flow

1. MCP client sends tool call.
2. index.ts parses args and timeout.
3. Mutating path is gated by preflight when required.
4. Tool-specific logic executes.
5. Result is normalized into MCP content payload.
6. Metrics are recorded for trend and health tools.
7. Mutating results are audit-logged with sanitized inputs.

## Data boundaries

- ServiceNow credentials are loaded from env or .env.
- ServiceNow access is API-first and table-driven.
- Local generated artifacts are under .syncrona-mcp.

## Key generated artifacts

- .syncrona-mcp/audit.log
- .syncrona-mcp/scopes/<scope>.json
- .syncrona-mcp/scopes/<scope>.md

## Design constraints

- deterministic output shape preferred
- dry-run support for mutating tools
- stable tool contract and backward compatibility
- non-fatal audit/log failures should not crash main flow
