# SyncroNow AI MCP Server

MCP server package for automating SyncroNow AI + ServiceNow operational tasks from AI chat clients.

## What it adds

- SyncroNow AI command tools: status, refresh, build, push
- ServiceNow table tools: query and create records
- Background script execution tool with API-first approach and fallback to `sys.scripts.do`
- Workflow tool: create Script Include record and auto-refresh SyncroNow AI

## Requirements

- Node 22
- ServiceNow credentials available as environment variables or `.env` in project root:
  - `SN_INSTANCE`
  - `SN_USER`
  - `SN_PASSWORD`
- SyncroNow AI CLI available in the target project (`npx syncrona ...`)

## Build

```bash
npm run --workspace=@syncrona/mcp-server build
```

## Test

```bash
npm run --workspace=@syncrona/mcp-server test
```

## Run

```bash
node packages/mcp-server/dist/index.js
```

This server communicates over stdio (MCP standard transport).

On startup, MCP now auto-pulls all ServiceNow scoped apps (`x_*`) into local workspace folders under `packages/<scope>/`.
For each discovered scope it creates/updates:

- `packages/<scope>/sync.config.js`
- `packages/<scope>/src/**` (downloaded record files)
- `packages/<scope>/sync.manifest.json`

To disable this startup auto-sync, set:

- `SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES=false`

Optional HTTP health endpoint can be enabled with environment variables:

- `SYNCRONA_HEALTH_HTTP_PORT` (required to enable endpoint)
- `SYNCRONA_HEALTH_HTTP_HOST` (optional, default: `127.0.0.1`)
- `SYNCRONA_HEALTH_HTTP_PATH` (optional, default: `/healthz`)

## Logging

The server writes structured diagnostics to **stderr** only (stdout is reserved
for the JSON-RPC protocol stream). Each tool call is logged with its
`correlationId`, `tool`, and `durationMs`. Configure logging with:

- `SYNCRONA_LOG_LEVEL` (optional, one of `debug` | `info` | `warn` | `error` | `silent`, default: `info`)
- `SYNCRONA_LOG_FORMAT` (optional, `text` | `json`, default: `text`) — or pass the CLI flag `--log-format=json`

Set `SYNCRONA_LOG_LEVEL=debug` to surface otherwise-swallowed diagnostics, such
as failed secrets/`.env` loading and audit-log write failures.

## Example MCP client config

```json
{
  "mcpServers": {
    "syncrona": {
      "command": "node",
      "args": [
        "/absolute/path/to/syncrona_ai/packages/mcp-server/dist/index.js"
      ],
      "cwd": "/absolute/path/to/your-syncrona-project"
    }
  }
}
```

## Workspace MCP config

This repository also includes a ready-to-use config at [../../../.vscode/mcp.json](../../../.vscode/mcp.json).

## Key tools

- `sync_get_session_context`
  - Returns current user session scope and update set
- `sync_set_scope`
  - Switches current user session to target scope code
- `sync_list_scopes`
  - Lists available scopes so you can choose the right one before switching
- `sync_set_update_set`
  - Switches current user session to target update set (optionally creates it)
- `sync_list_update_sets`
  - Lists available update sets so you can select by name or sys_id
- `sync_prepare_session`
  - One-call setup to ensure expected scope and update set before work starts
- `sync_preflight_check`
  - Validates current context against guardrail expectations
- `sync_check_instance_capabilities`
  - Verifies SyncroNow AI scoped endpoints in the instance before automation starts
  - Uses current session scope by default (or explicit scope input)
- `sn_query_records`
  - Query table records with `sysparm_query`
  - Optional grouped analysis with `analyzeField`
- `sn_create_record`
  - Creates table records with validated payloads
- `sn_execute_background_script`
  - Executes background scripts and returns output for analysis
- `sync_create_script_include`
  - Creates record in `sys_script_include`
  - Optionally runs `syncrona refresh` so local file is downloaded
- `sync_create_script_include_and_sync`
  - Creates Script Include
  - Runs `syncrona refresh`
  - Returns candidate local file path(s) from manifest so AI can edit immediately
- `sn_list_metadata_records`
  - Inventory tool for key metadata families (BR, Client Script, ACL, Dictionary, UI Policy, Scripted REST)
- `sn_get_metadata_record`
  - Reads one metadata record by `sys_id` with normalized schema
- `sn_update_metadata_record`
  - Controlled metadata update tool with confirmation and dry-run gate
- `sn_build_dependency_graph`
  - Builds graph nodes/edges from metadata scripts, inferred references, and declared meta relations
  - Returns cycle detection and hotspot summary
- `sn_analyze_impact`
  - Ranks downstream impact severity if a target node changes
  - Returns blast-radius summary by node kind and severity
- `sn_diff_dependency_graphs`
  - Compares before/after graphs and returns deterministic added/removed nodes/edges
- `sync_detect_drift`
  - Compares local vs instance snapshots and returns drift summary + actions
- `sync_validate_change_package`
  - Detects missing dependencies before push
- `sync_build_semantic_index` / `sync_search_semantic_index`
  - Symbol-level local code indexing and lookup
- `sn_analyze_script_architecture` / `sn_analyze_script_security` / `sn_analyze_script_performance`
  - Static analysis packs with severity and remediation hints
- `sn_analyze_script_full`
  - Unified script analysis with weighted risk scoring and optional `suppressedIds`
- `sync_symbol_cross_reference`
  - Summarizes semantic symbol occurrences by file and count
- `sn_autonomous_remediation_workflow`
  - detect -> propose patch -> dry-run/apply -> validate flow with approval gate
- `sync_health_check`
  - Reliability metrics + diagnostics timeline
  - Includes HTTP endpoint status when optional health endpoint is enabled
- `sync_metrics_trend`
  - Compares previous/current metric windows and returns latency + failure-ratio deltas
- `sync_tool_contract_info`
  - Returns tool-contract version, declared MCP tools, deterministic contract hash, and per-tool lifecycle metadata (`version`, `deprecated`, replacement hints)
- `sync_list_recent_changes`
  - Lists recent scope changes from `sys_update_xml` since a timestamp (default 24h), grouped by record
- `sn_search_scripts`
  - Full-text search across ServiceNow script tables (script includes, business rules, client/UI scripts, scripted REST, transform scripts) with excerpts
- `sn_get_record_history`
  - Field-level change history from `sys_audit` for a single record
- `sync_generate_release_notes`
  - Generates release notes from an Update Set's `sys_update_xml` records in markdown or json
- `sync_run_atf_tests`
  - Triggers ATF test/suite execution in the instance and polls `sys_atf_test_result` / `sys_atf_test_suite_result` for pass/fail results
- `sync_validate_before_push`
  - Pre-push validation: runs security/architecture analysis on a scope's scripts, checks recent conflicting changes, reports ready or blocked per record
- `sync_compare_instances`
  - Compares a scope's script records between two stored instance profiles (for example dev vs prod) by name and content hash
- `sync_export_update_set`
  - Exports an Update Set as XML via the `export_update_set` processor and optionally writes it under `.syncrona-mcp/exports`
- `sync_suggest_tests`
  - Generates an ATF server-side test skeleton from a Script Include by analyzing its public methods, returning a ready-to-paste test script plus import instructions
- `sync_diff_instance_vs_local`
  - Compares local scoped files against the instance records for a table/scope and reports changed, added (local-only) and removed (instance-only) records with diff summaries and race-condition warnings
- `sync_status` / `sync_refresh` / `sync_build` / `sync_push`
  - Wrapper tools for common SyncroNow workspace command flows
- `run_node_code`
  - Executes local Node snippets with explicit safety controls for destructive operations
- `sn_render_analysis_markdown`
  - Renders unified analysis report into deterministic markdown
- `sync_unified_change_workflow`
  - One-command flow with preflight, deep-analysis gate, approval gate, footprint and rollback checks
  - Returns explicit `executionMode` to avoid confusion between mocked and remote execution
- `sync_table_api_coverage_matrix`
  - Returns current metadata/object coverage matrix via Table API
- `sync_plan_minimal_footprint`
  - Ranks where-to-modify targets by minimal footprint and confidence
- `sync_ai_next_actions`
  - Converts a natural-language objective into prioritized, tool-aware next action steps
  - Includes recommended tool args and dry-run-first guidance for safer AI orchestration
- `sync_generate_scope_knowledge`
  - Generates scope knowledge JSON and Markdown artifacts
- `sync_generate_scope_docs`
  - Generates full scope docs bundle under `.syncrona-mcp/docs/{scope}/` including overview, dependencies, relationships, and per-object pages
- `sync_validate_scope_knowledge`
  - Validates scope knowledge JSON against required schema fields
- `sync_scope_knowledge_auto_update`
  - Trigger-based scope knowledge update contract (init/refresh/successful_change/drift)
- `sync_generate_table_dependency_report`
  - One-command table dependency report generation with deterministic output paths under `.syncrona-mcp/reports/`
- `sync_analyze_scope_relations`
  - Builds comprehensive table relation map for a scope (explicit dictionary links, hidden attribute hints, inferred workspace links)
- `sync_onboarding_bootstrap`
  - Returns onboarding checklist and readiness state

## Typical flow

1. Run `sync_get_session_context`
2. Option A: run `sync_set_scope` and `sync_set_update_set`
3. Option B: run `sync_prepare_session` for one-call setup
4. Run `sync_check_instance_capabilities`
5. Ask AI to create Script Include through `sync_create_script_include_and_sync`
6. Auto-refresh pulls the new include locally
7. AI receives candidate local path(s) and can edit immediately
8. Build and push using `syncrona build` and `syncrona push`

## Safety note

`run_workspace_command` blocks unsafe shell interpreter patterns (`bash -c`, `sh -c`, etc.) to reduce command-injection risk.

All MCP tool handlers are wrapped with a top-level error boundary so failures return structured tool errors instead of crashing the server.

## Guardrails config

Create `sync.mcp.guardrails.json` in project root:

```json
{
  "enforcePreflightForMutations": true,
  "expectedScope": "x_nuvo_sync",
  "expectedUpdateSetName": "AI Work",
  "expectedUpdateSetSysId": ""
}
```

When enforcement is enabled, mutating tools are blocked if preflight fails.

## Dry-run support

Mutating tools support `dryRun=true` and return planned actions without applying changes.

## Runbook and governance

- Operator runbook: `packages/mcp-server/docs/operator-runbook.md`
- Troubleshooting playbook: `packages/mcp-server/docs/troubleshooting-playbook.md`
- Release governance checklist: `packages/mcp-server/docs/release-governance.md`

## AI context pack

For long-running AI sessions, use the context pack in `packages/mcp-server/docs/ai-context/`:

- `README.md` (entry point)
- `architecture.md`
- `workflow-and-safety.md`
- `tools-catalog.md`
- `testing-and-quality.md`
- `backlog-and-roadmap.md`

## Meta relation input examples

You can enrich graph inputs with explicit meta relations:

- `metaRelations`: `[{"type":"table","target":"task"},{"type":"include","target":"MyUtil"}]`
- `affectsTables`: `['incident', 'task']`
- `callsIncludes`: `['RiskHelper']`

## Full analysis suppressions

`sn_analyze_script_full` accepts optional `suppressedIds` so temporary or accepted risks can be tracked separately from active findings.

It also accepts optional `policy`:

```json
{
  "weights": { "high": 5, "medium": 3, "low": 1 },
  "suppressions": [{ "id": "arch.logging.noise", "expiresAt": "2030-01-01T00:00:00.000Z" }]
}
```

## Unified workflow example

```json
{
  "task": "Update validation logic for incident handler",
  "taskType": "hybrid",
  "executionMode": "mocked",
  "script": "gs.log('debug');",
  "proposedChanges": [
    { "filePath": "src/sys_script_include/IncidentHandler/script.js", "objectId": "script:IncidentHandler", "estimatedLines": 20 }
  ],
  "approval": { "approvalId": "APR-42", "approvers": ["alice", "bob"] },
  "rollbackEvidence": {
    "reason": "safety rollback coverage",
    "impactedEntities": ["script:IncidentHandler"],
    "revertSteps": ["restore previous script body"],
    "validationPlan": "run analysis and smoke checks"
  },
  "apply": false
}
```

## Scope knowledge generation example

```json
{
  "scope": "x_nuvo_sync",
  "task": "optimize incident validation",
  "entities": [
    { "id": "script:IncidentHandler", "name": "IncidentHandler", "tableName": "incident" }
  ],
  "graph": {
    "nodes": [
      { "id": "script:IncidentHandler", "kind": "script", "label": "IncidentHandler" },
      { "id": "table:incident", "kind": "table", "label": "incident" }
    ],
    "edges": [
      { "from": "script:IncidentHandler", "to": "table:incident", "relation": "reads", "why": "GlideRecord reference" }
    ]
  },
  "writeFiles": false,
  "trigger": "manual"
}
```

Set `writeFiles: true` only when you explicitly want to persist artifacts under `.syncrona-mcp/`.

## One-command table dependency report example

```json
{
  "scope": "x_nuvo_sync",
  "task": "table dependencies report",
  "writeFiles": false
}
```

Expected outputs:

- `.syncrona-mcp/reports/<scope>-table-dependencies.md`
- `.syncrona-mcp/reports/<scope>-table-dependencies.json`
