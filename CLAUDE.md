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
- `npx syncro-now-ai init` provisions a project.
- `npx syncro-now-ai refresh` refreshes manifest and downloads new files.
- `npx syncro-now-ai dev` starts watch mode.
- `npx syncro-now-ai push` pushes local files to ServiceNow.
- `npx syncro-now-ai download` downloads scoped application files.
- `npx syncro-now-ai build` builds local artifacts.
- `npx syncro-now-ai deploy` deploys built files.
- `npx syncro-now-ai docs` generates or logically updates scope Markdown docs and diagrams.
- `npx syncro-now-ai repair` reconciles the manifest with local files and re-downloads missing or prunes orphan files.
- `npx syncro-now-ai status` prints extended diagnostics.
- `npx syncro-now-ai check-env` checks OS, Node, WSL and Git prerequisites.
- `npx syncro-now-ai doctor` runs diagnostic checks.
- `npx syncro-now-ai plugins` reports configured plugin rules and plugin package availability.
- `npx syncro-now-ai config` inspects or extends configuration (e.g. `config show-defaults`, `config add-plugin`).
- `npx syncro-now-ai mcp` starts standalone MCP server with optional local auto-configure.
- `npx syncro-now-ai login` saves credentials in the global credential store.
- `npx syncro-now-ai logout` removes stored credentials.
- `npx syncro-now-ai instances` lists stored instances and active marker.
- `npx syncro-now-ai use` sets the active stored instance.
- `npx syncro-now-ai jira` fetches rich context for a Jira issue (key argument or git branch fallback).
- `npx syncro-now-ai jira-login` saves Jira credentials in the global credential store (Cloud or Server/Data Center).
- `npx syncro-now-ai jira-logout` removes stored Jira credentials.

## Documentation Drift Policy
- README command table and this document must stay aligned for core CLI commands.
- Any command additions or removals must update both README and CLAUDE.md in the same change.
- CI/local gates enforce this through the CLAUDE docs drift checker.
