# MCP Server Source Architecture

This folder is organized by responsibilities so the code stays readable and easy to evolve.

## Core entrypoint

- `index.ts`
  - MCP server bootstrap
  - tool registration wiring
  - high-level orchestration between modules

## Extracted domain modules

- `analysis.ts`
  - graph, risk, analysis, markdown rendering, scope knowledge logic
- `safetyPolicy.ts`
  - mutating tool policy, workspace command safety, risk and approval helpers
- `sessionContext.ts`
  - ServiceNow session/scope/update-set resolution and table access helpers
- `servicenowCore.ts`
  - ServiceNow env parsing, base URL resolution, HTTP request primitives
- `scopePaths.ts`
  - deterministic paths and scope code normalization
- `audit.ts`
  - audit payload sanitization and append-only audit writer
- `runtimeUtils.ts`
  - output formatting and common runtime response helpers

## Readability rules

1. Keep orchestration in `index.ts`; keep business logic in dedicated modules.
2. New tool-specific logic should be implemented in module files, then wired in `index.ts`.
3. Keep helper functions pure where possible and covered by tests.
4. Preserve deterministic output ordering for markdown/json artifacts.
5. Prefer small functions with single responsibility and explicit names.

## Refactor direction

1. Continue reducing `index.ts` by moving tool handlers into grouped handler modules.
2. Keep compatibility by re-exporting externally-used helper APIs from `index.ts`.
3. Preserve behavior with `npm --workspace @syncrona/mcp-server test` after each extraction slice.
