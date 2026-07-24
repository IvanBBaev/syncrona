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
- `npx syncrona init` provisions a project (`--ci` provisions every scope the detected `.env` exposes without prompting).
- `npx syncrona refresh` refreshes manifest and downloads new files.
- `npx syncrona dev` starts watch mode.
- `npx syncrona push` pushes local files to ServiceNow.
- `npx syncrona download` downloads scoped application files.
- `npx syncrona build` builds local artifacts.
- `npx syncrona deploy` deploys built files (`--ci` skips the overwrite confirmation).
- `npx syncrona docs` generates or logically updates scope Markdown docs and diagrams.
- `npx syncrona repair` reconciles the manifest with local files and re-downloads missing or prunes orphan files.
- `npx syncrona status` prints extended diagnostics.
- `npx syncrona check-env` checks OS, Node, WSL and Git prerequisites.
- `npx syncrona doctor` runs diagnostic checks.
- `npx syncrona plugins` reports configured plugin rules and plugin package availability.
- `npx syncrona config` inspects or extends configuration (e.g. `config show-defaults`, `config add-plugin`).
- `npx syncrona completion` prints a bash or zsh tab-completion script (shell argument or auto-detect from `$SHELL`).
- `npx syncrona mcp` starts standalone MCP server with optional local auto-configure.
- `npx syncrona login` saves credentials in the global credential store; a method
  picker (or `--auth-method`) selects Basic, OAuth (password / client-credentials /
  JWT-bearer), or an inbound REST API key, with optional mutual TLS.
- `npx syncrona logout` removes stored credentials.
- `npx syncrona instances` lists stored instances and active marker.
- `npx syncrona use` sets the active stored instance.
- `npx syncrona jira` fetches rich context for a Jira issue (key argument or git branch fallback).
- `npx syncrona jira-login` saves Jira credentials in the global credential store (Cloud or Server/Data Center).
- `npx syncrona jira-logout` removes stored Jira credentials.

## Documentation Drift Policy
- README command table and this document must stay aligned for core CLI commands.
- Any command additions or removals must update both README and CLAUDE.md in the same change.
- CI/local gates enforce this through the CLAUDE docs drift checker.
