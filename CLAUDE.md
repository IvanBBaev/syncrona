# CLAUDE.md

## Purpose
This document captures practical repository guidance for AI-assisted and human contributors.
It complements README and package-level docs with implementation and quality-gate expectations.

## Workspace Layout
- Monorepo root manages shared quality gates and workspace scripts.
- Core CLI lives in `packages/core`.
- MCP runtime and governance automation live in `packages/mcp-server`.
- Shared types live in `packages/types`.

## Quality Gates
- Use Node.js 22 and npm 10+ for local validation.
- Run full validation with `npm run check` at the repository root.
- MCP governance checks run through `packages/mcp-server/scripts/quality-gates.sh`.

## Command Reference
- `npx syncrona init` provisions a project.
- `npx syncrona refresh` refreshes manifest and downloads new files.
- `npx syncrona dev` starts watch mode.
- `npx syncrona push` pushes local files to ServiceNow.
- `npx syncrona download` downloads scoped application files.
- `npx syncrona build` builds local artifacts.
- `npx syncrona deploy` deploys built files.
- `npx syncrona docs` generates or logically updates scope Markdown docs and diagrams.
- `npx syncrona status` prints extended diagnostics.
- `npx syncrona doctor` runs diagnostic checks.
- `npx syncrona plugins` reports configured plugin rules and plugin package availability.
- `npx syncrona mcp` starts standalone MCP server with optional local auto-configure.
- `npx syncrona login` saves credentials in the global credential store.
- `npx syncrona logout` removes stored credentials.
- `npx syncrona instances` lists stored instances and active marker.
- `npx syncrona use` sets the active stored instance.

## Documentation Drift Policy
- README command table and this document must stay aligned for core CLI commands.
- Any command additions or removals must update both README and CLAUDE.md in the same change.
- CI/local gates enforce this through the CLAUDE docs drift checker.
