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
- `npx syncrona init` provisions a project (`--ci` provisions every scope the detected `.env` exposes without prompting;
  `--new --name "<display>" [--scope x_<prefix>_<name>] [--vendor-prefix <p>]` creates a new scoped
  application on the instance and binds the directory to it, and `--dry-run` only prints the `sys_app` body).
- `npx syncrona refresh` refreshes manifest and downloads new files.
- `npx syncrona dev` starts watch mode.
- `npx syncrona push` pushes local files to ServiceNow (`--create` creates or adopts records for files not in the manifest yet; `createRecords: true` in `sync.config.js` sets the default, and the flag (or `--no-create`) wins; `--prune` deletes in-scope records whose tracked files git shows deleted, confirming unless `--ci`, with no config switch; `--allow-mass-delete` lifts the 25-record / 20% limit and the `--ci` scope requirement).
- `npx syncrona download` downloads scoped application files.
- `npx syncrona build` builds local artifacts.
- `npx syncrona deploy` deploys built files (`--ci` skips the interactive prompts: it deploys the diff manifest when `build --diff` produced one, and the full build scope otherwise).
- `npx syncrona docs` generates or logically updates scope Markdown docs and diagrams.
- `npx syncrona repair` reconciles the manifest with local files: report-only by default, `--apply` re-downloads missing files (and re-fetches secret-rule values such as `sys_properties.value`, restoring non-secret ones), and `--apply --prune` deletes orphan files no record claims — only orphans git holds committed and unchanged (so git can restore them), never the files of a record awaiting `push --create`, never files of unlisted tables; `--apply --prune --dry-run` previews it; pruning is refused outside a git repository or without a commit.
- `npx syncrona status` prints extended diagnostics.
- `npx syncrona query <table>` queries records through the Table API with the `now-sdk query` flags except `--select`/`--auth` (`-q` required); read-only, and `-o json` prints the `{ok, hasMore, nextOffset, records}` envelope.
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
- `npx syncrona mirror <action>` drives the full-instance git mirror: `init` provisions the
  repository for scale, `sync` sweeps the instance into the tree (`--full`, `--reconcile`
  to propagate instance-side deletions off-cadence, `--verify-quiescent`),
  `status` compares the tree against the live instance, `verify` checks it against its own
  manifests offline, and `report` re-prints the last sweep's report (`--deep`, `--json`).
  It exits 0 clean, 1 when the run could not finish, and 2 on drift or findings.
- `npx syncrona cicd <action>` drives the ServiceNow CI/CD REST API (`api/sn_cicd`) and polls
  its progress tracker: `run-suite` / `run-test` run ATF, `install` / `publish` / `rollback`
  act on an app-repo application (`--scope` or `--app-sys-id`, `--app-version`), `--progress-id`
  resumes polling an existing tracker without dispatching, and `--json` prints the machine result. It needs the `sn_cicd.sys_ci_automation` role and exits 0 on
  success, 1 when the run could not finish, and 2 on test failures or a failed/cancelled run.
- `npx syncrona fluent <action>` drives Fluent (`.now.ts`) apps through the optional
  `@syncrona/fluent` + `@servicenow/sdk` tier: `init`, `build`, `transform`, `pack`,
  `install` (`--reinstall`, prompts unless `--ci`; without a terminal or with `--json` it needs `--ci`), `types`, `dependencies`, `run` (local, no instance credential),
  `status`, `explain [topic]` (the SDK's bundled docs, offline; `--list`, `--peek`) and
  `move-to-app --ids` (global records into a global app; prompts unless `--ci`, and needs
  `--ci` without a terminal or with `--json`). `types --native` generates table types from `sys_dictionary` without the SDK,
  and a plain `types` falls back to it when the SDK is missing.
  It exits 0 on success (`install` once submitted), 1 on failure, and 2 on build errors, a
  `status` whose install has not finished, or a `move-to-app` that moved nothing.

### Shared option contracts
- `--dry-run` is implemented by `push`, `deploy`, `download`, `build`, `init`,
  `repair` and `fluent`. Every other command that takes the shared options declares
  `supportsDryRun: false` in the CLI registry and `commander.ts` refuses the flag with
  an explanation — a parsed-then-ignored `--dry-run` would turn a request for a
  preview into a real run. Commands registered with `includeSharedOptions: false`
  (`completion`, `login`, `logout`, `instances`, `use`, `jira`, `jira-login`,
  `jira-logout`) do not accept the flag at all. A new command that takes the shared
  options must state which side it is on; a registry test enforces it.

## Documentation Drift Policy
- README command table and this document must stay aligned for core CLI commands.
- Any command additions or removals must update both README and CLAUDE.md in the same change.
- CI/local gates enforce this through the CLAUDE docs drift checker.
