# SyncroNow AI MCP Tool Reference

<!-- GENERATED FILE. Do not edit by hand. -->
<!-- Regenerate with: node packages/mcp-server/scripts/generate-tool-reference.js -->

This reference is generated from `packages/mcp-server/src/toolSchemas.ts`.
Do not edit it manually; regenerate with `node packages/mcp-server/scripts/generate-tool-reference.js`.

Total tools: **61**.

## Contents

- [sync_ tools (41)](#sync_-tools)
  - [sync_status](#sync_status)
  - [sync_get_session_context](#sync_get_session_context)
  - [sync_set_scope](#sync_set_scope)
  - [sync_list_scopes](#sync_list_scopes)
  - [sync_set_update_set](#sync_set_update_set)
  - [sync_list_update_sets](#sync_list_update_sets)
  - [sync_prepare_session](#sync_prepare_session)
  - [sync_preflight_check](#sync_preflight_check)
  - [sync_check_instance_capabilities](#sync_check_instance_capabilities)
  - [sync_refresh](#sync_refresh)
  - [sync_build](#sync_build)
  - [sync_push](#sync_push)
  - [sync_create_script_include](#sync_create_script_include)
  - [sync_create_script_include_and_sync](#sync_create_script_include_and_sync)
  - [sync_detect_drift](#sync_detect_drift)
  - [sync_validate_change_package](#sync_validate_change_package)
  - [sync_build_semantic_index](#sync_build_semantic_index)
  - [sync_search_semantic_index](#sync_search_semantic_index)
  - [sync_symbol_cross_reference](#sync_symbol_cross_reference)
  - [sync_health_check](#sync_health_check)
  - [sync_metrics_trend](#sync_metrics_trend)
  - [sync_tool_contract_info](#sync_tool_contract_info)
  - [sync_table_api_coverage_matrix](#sync_table_api_coverage_matrix)
  - [sync_plan_minimal_footprint](#sync_plan_minimal_footprint)
  - [sync_ai_next_actions](#sync_ai_next_actions)
  - [sync_generate_scope_knowledge](#sync_generate_scope_knowledge)
  - [sync_generate_scope_docs](#sync_generate_scope_docs)
  - [sync_validate_scope_knowledge](#sync_validate_scope_knowledge)
  - [sync_scope_knowledge_auto_update](#sync_scope_knowledge_auto_update)
  - [sync_generate_table_dependency_report](#sync_generate_table_dependency_report)
  - [sync_analyze_scope_relations](#sync_analyze_scope_relations)
  - [sync_onboarding_bootstrap](#sync_onboarding_bootstrap)
  - [sync_unified_change_workflow](#sync_unified_change_workflow)
  - [sync_list_recent_changes](#sync_list_recent_changes)
  - [sync_generate_release_notes](#sync_generate_release_notes)
  - [sync_run_atf_tests](#sync_run_atf_tests)
  - [sync_validate_before_push](#sync_validate_before_push)
  - [sync_compare_instances](#sync_compare_instances)
  - [sync_export_update_set](#sync_export_update_set)
  - [sync_suggest_tests](#sync_suggest_tests)
  - [sync_diff_instance_vs_local](#sync_diff_instance_vs_local)
- [run_ tools (2)](#run_-tools)
  - [run_workspace_command](#run_workspace_command)
  - [run_node_code](#run_node_code)
- [sn_ tools (17)](#sn_-tools)
  - [sn_query_records](#sn_query_records)
  - [sn_create_record](#sn_create_record)
  - [sn_execute_background_script](#sn_execute_background_script)
  - [sn_list_metadata_records](#sn_list_metadata_records)
  - [sn_get_metadata_record](#sn_get_metadata_record)
  - [sn_update_metadata_record](#sn_update_metadata_record)
  - [sn_build_dependency_graph](#sn_build_dependency_graph)
  - [sn_analyze_impact](#sn_analyze_impact)
  - [sn_diff_dependency_graphs](#sn_diff_dependency_graphs)
  - [sn_analyze_script_architecture](#sn_analyze_script_architecture)
  - [sn_analyze_script_security](#sn_analyze_script_security)
  - [sn_analyze_script_performance](#sn_analyze_script_performance)
  - [sn_analyze_script_full](#sn_analyze_script_full)
  - [sn_autonomous_remediation_workflow](#sn_autonomous_remediation_workflow)
  - [sn_render_analysis_markdown](#sn_render_analysis_markdown)
  - [sn_search_scripts](#sn_search_scripts)
  - [sn_get_record_history](#sn_get_record_history)
- [jira_ tools (1)](#jira_-tools)
  - [jira_get_issue](#jira_get_issue)

## sync_ tools

### sync_status

Show connected ServiceNow instance, scope and user from current SyncroNow AI project.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `logLevel` | `string (one of: "error", "warn", "info", "debug", "silly")` | no | `"info"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Captured result of the underlying `syncrona status` CLI run. Only success results (exit code 0) carry structuredContent.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `exitCode` | `integer` | yes | Process exit code of the CLI run (always 0 on success results). |
| `timedOut` | `boolean` | yes | True when the CLI run was killed after exceeding timeoutMs. |
| `stdout` | `string` | yes | Captured standard output of the CLI run. |
| `stderr` | `string` | yes | Captured standard error of the CLI run. |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_get_session_context

Get current ServiceNow session context: active scope and active update set for current user.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Current ServiceNow session context for the connected user.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `userSysId` | `string` | yes | sys_id of the connected sys_user record. |
| `scope` | `object` | yes | Active application scope. |
| `updateSet` | `object` | yes | Active update set from the sys_update_set user preference. |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_set_scope

Set current ServiceNow scope for the current user session using scope code (for example x_nuvo_sinc).

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | yes |  |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Scope-switch confirmation with the refreshed session context. When dryRun is requested, the payload is the dry-run plan (dryRun, tool, planned) instead.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `requestedScope` | `string` | no | Scope code that was requested. |
| `scopeSysId` | `string` | no | sys_id of the resolved sys_scope record. |
| `scopeName` | `string` | no | Display label of the resolved scope. |
| `sessionContext` | `object` | no | Refreshed session context (same shape as the sync_get_session_context output). |
| `dryRun` | `boolean` | no | Present and true only on dry-run results. |
| `tool` | `string` | no | Tool that produced the plan (dry-run results only). |
| `planned` | `object` | no | Arguments the tool would apply (dry-run results only). |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_list_scopes

List available scopes from sys_scope. Use optional encoded query to filter.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | no | `""` |  |
| `limit` | `number (min 1, max 500)` | no | `100` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Page of sys_scope rows matching the query.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `count` | `integer` | yes | Number of rows returned in this page. |
| `rows` | `array<object>` | yes | sys_scope rows limited to the sys_id, scope and name fields. |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_set_update_set

Set current ServiceNow update set for current user by name or sys_id. Optionally create missing set by name.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `updateSetName` | `string` | no | `""` |  |
| `updateSetSysId` | `string` | no | `""` |  |
| `createIfMissing` | `boolean` | no | `true` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Update-set switch confirmation with the refreshed session context. When dryRun is requested, the payload is the dry-run plan (dryRun, tool, planned) instead.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `targetUpdateSet` | `object` | no | Update set that is now active for the current user. |
| `sessionContext` | `object` | no | Refreshed session context (same shape as the sync_get_session_context output). |
| `dryRun` | `boolean` | no | Present and true only on dry-run results. |
| `tool` | `string` | no | Tool that produced the plan (dry-run results only). |
| `planned` | `object` | no | Arguments the tool would apply (dry-run results only). |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_list_update_sets

List update sets from sys_update_set. Use optional encoded query to filter.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | no | `""` |  |
| `limit` | `number (min 1, max 500)` | no | `100` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Page of sys_update_set rows matching the query.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `count` | `integer` | yes | Number of rows returned in this page. |
| `rows` | `array<object>` | yes | sys_update_set rows limited to the sys_id, name, state, application and sys_created_on fields. |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_prepare_session

Ensure expected scope and update set are active. It reads current context, applies changes when needed, and returns final context.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `expectedScope` | `string` | no | `""` |  |
| `expectedUpdateSetName` | `string` | no | `""` |  |
| `expectedUpdateSetSysId` | `string` | no | `""` |  |
| `createUpdateSetIfMissing` | `boolean` | no | `true` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Report of the session changes that were applied, with before and after context. When dryRun is requested, the payload is the dry-run plan (dryRun, tool, planned) instead.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `actions` | `array<string>` | no | Human-readable descriptions of the changes that were applied. |
| `changed` | `boolean` | no | True when at least one change was applied. |
| `initialContext` | `object` | no | Session context before changes (same shape as the sync_get_session_context output). |
| `finalContext` | `object` | no | Session context after changes (same shape as the sync_get_session_context output). |
| `dryRun` | `boolean` | no | Present and true only on dry-run results. |
| `tool` | `string` | no | Tool that produced the plan (dry-run results only). |
| `planned` | `object` | no | Arguments the tool would apply (dry-run results only). |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_preflight_check

Validate current scope/update-set against guardrail expectations in sync.mcp.guardrails.json or provided overrides.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `expectedScope` | `string` | no | `""` |  |
| `expectedUpdateSetName` | `string` | no | `""` |  |
| `expectedUpdateSetSysId` | `string` | no | `""` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_check_instance_capabilities

Check whether SyncroNow AI scoped-app endpoints are available in the target ServiceNow instance.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no | `""` | Optional scope code for manifest check. Defaults to current session scope. |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_refresh

Refresh local SyncroNow AI manifest from the target instance.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `logLevel` | `string (one of: "error", "warn", "info", "debug", "silly")` | no | `"info"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

Output (`structuredContent` on success results):

Captured result of the underlying `syncrona refresh` CLI run. Only success results (exit code 0) carry structuredContent.

| Field | Type | Always present | Description |
| --- | --- | --- | --- |
| `exitCode` | `integer` | yes | Process exit code of the CLI run (always 0 on success results). |
| `timedOut` | `boolean` | yes | True when the CLI run was killed after exceeding timeoutMs. |
| `stdout` | `string` | yes | Captured standard output of the CLI run. |
| `stderr` | `string` | yes | Captured standard error of the CLI run. |
| `correlationId` | `string` | no | Request correlation id injected by the server. |

### sync_build

Build local files with SyncroNow AI.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `diff` | `string` | no | `""` | Optional branch name for --diff build |
| `logLevel` | `string (one of: "error", "warn", "info", "debug", "silly")` | no | `"info"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_push

Push files to ServiceNow instance using SyncroNow AI. Destructive action.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `target` | `string` | no | `""` | Optional encoded target path(s) |
| `diff` | `string` | no | `""` | Optional branch name for --diff |
| `scopeSwap` | `boolean` | no | `false` |  |
| `updateSet` | `string` | no | `""` |  |
| `logLevel` | `string (one of: "error", "warn", "info", "debug", "silly")` | no | `"info"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | yes | `false` | Must be true to execute push. |
| `dryRun` | `boolean` | no | `false` |  |

### sync_create_script_include

Create sys_script_include record, then optionally run sync refresh so the file is downloaded locally.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | yes |  |  |
| `apiName` | `string` | no | `""` |  |
| `script` | `string` | no | `""` |  |
| `active` | `boolean` | no | `true` |  |
| `clientCallable` | `boolean` | no | `false` |  |
| `refreshAfterCreate` | `boolean` | no | `true` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | yes | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_create_script_include_and_sync

Create Script Include, refresh manifest/files, and return local candidate file paths for immediate editing.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | yes |  |  |
| `apiName` | `string` | no | `""` |  |
| `script` | `string` | no | `""` |  |
| `active` | `boolean` | no | `true` |  |
| `clientCallable` | `boolean` | no | `false` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | yes | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_detect_drift

Compare local and instance record states and report drift summary with actions.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `localRecords` | `array<object>` | no | `[]` |  |
| `instanceRecords` | `array<object>` | no | `[]` |  |
| `updateSetSysId` | `string` | no | `""` |  |

### sync_validate_change_package

Validate that selected records include required dependencies.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `selectedIds` | `array<string>` | yes | `[]` |  |
| `graph` | `object` | yes |  |  |

### sync_build_semantic_index

Build semantic symbol index from local source files.

- Version: `1.0.0`

This tool has no input parameters.

### sync_search_semantic_index

Search current semantic symbol index.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | no | `""` |  |

### sync_symbol_cross_reference

Summarize semantic symbol cross-references by symbol name, files, and occurrences.

- Version: `1.0.0`

This tool has no input parameters.

### sync_health_check

Return MCP health, endpoint diagnostics timeline, and per-tool reliability metrics.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_metrics_trend

Compute trend deltas between previous and current diagnostics windows.

- Version: `1.0.0`

This tool has no input parameters.

### sync_tool_contract_info

Return tool-contract version, declared tool list, and deterministic contract hash for capability negotiation.

- Version: `1.0.0`

This tool has no input parameters.

### sync_table_api_coverage_matrix

Return current metadata/object coverage matrix and supported operations via Table API.

- Version: `1.0.0`

This tool has no input parameters.

### sync_plan_minimal_footprint

Rank where-to-modify targets for a task using graph context and minimal-footprint scoring.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `task` | `string` | yes |  |  |
| `graph` | `object` | yes |  |  |
| `limit` | `number (min 1, max 20)` | no | `5` |  |

### sync_ai_next_actions

Generate prioritized AI next actions and recommended tool calls from a natural-language objective.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `objective` | `string` | yes |  |  |
| `maxSteps` | `number (min 1, max 10)` | no | `5` |  |
| `currentContext` | `object` | no | `{}` |  |
| `constraints` | `object` | no | `{}` |  |

### sync_generate_scope_knowledge

Generate scope knowledge artifacts (md + json) and optionally write them under .syncrona-mcp/scopes/.

- Version: `1.0.0`
- Safety: supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no | `""` |  |
| `entities` | `array<object>` | no | `[]` |  |
| `graph` | `object` | no | `{}` |  |
| `risks` | `array<object>` | no | `[]` |  |
| `suppressions` | `array<object>` | no | `[]` |  |
| `updateSetContext` | `object` | no | `{}` |  |
| `task` | `string` | no | `""` |  |
| `writeFiles` | `boolean` | no | `false` |  |
| `trigger` | `string (one of: "manual", "init", "refresh", "successful_change", "drift")` | no | `"manual"` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_generate_scope_docs

Generate full scope documentation bundle under .syncrona-mcp/docs/{scope}/ with overview, dependencies, table relationships, and per-object docs.

- Version: `1.0.0`
- Safety: supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no | `""` |  |
| `entities` | `array<object>` | no | `[]` |  |
| `graph` | `object` | no | `{}` |  |
| `task` | `string` | no | `"scope docs"` |  |
| `includeFields` | `boolean` | no | `true` |  |
| `includeDiagrams` | `boolean` | no | `true` |  |
| `includeScheduledJobs` | `boolean` | no | `true` |  |
| `includeCrossScope` | `boolean` | no | `true` |  |
| `writeFiles` | `boolean` | no | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_validate_scope_knowledge

Validate scope knowledge json payload against required schema fields.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `index` | `object` | yes |  |  |

### sync_scope_knowledge_auto_update

Run trigger-based scope knowledge update contract for init/refresh/successful_change/drift.

- Version: `1.0.0`
- Safety: supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `trigger` | `string (one of: "init", "refresh", "successful_change", "drift")` | yes |  |  |
| `scope` | `string` | no | `""` |  |
| `entities` | `array<object>` | no | `[]` |  |
| `graph` | `object` | no | `{}` |  |
| `task` | `string` | no | `""` |  |
| `writeFiles` | `boolean` | no | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_generate_table_dependency_report

One-command table dependency report generation with deterministic output paths under .syncrona-mcp/reports/.

- Version: `1.0.0`
- Safety: supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no | `""` |  |
| `task` | `string` | no | `"table dependencies report"` |  |
| `writeFiles` | `boolean` | no | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sync_analyze_scope_relations

Analyze scope tables and relations (explicit, hidden, inferred) from ServiceNow metadata and local workspace evidence.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no | `""` |  |
| `includeWorkspace` | `boolean` | no | `true` |  |
| `includeServiceNow` | `boolean` | no | `true` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_onboarding_bootstrap

Return onboarding wizard/checklist with sensible defaults and quickstart guidance.

- Version: `1.0.0`

This tool has no input parameters.

### sync_unified_change_workflow

Run one-command workflow shell: preflight, deep analysis, minimal-footprint check, approval gate, and optional apply.

- Version: `1.0.0`
- Safety: mutating - gated by `confirmDestructive`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `task` | `string` | yes |  |  |
| `script` | `string` | no | `""` |  |
| `taskType` | `string (one of: "script", "metadata", "hybrid")` | no | `"hybrid"` |  |
| `executionMode` | `string (one of: "mocked", "remote")` | no | `"mocked"` |  |
| `allowRemoteApply` | `boolean` | no | `false` |  |
| `remoteScript` | `string` | no | `""` |  |
| `remoteEndpoint` | `string` | no | `""` |  |
| `proposedChanges` | `array<object>` | no | `[]` |  |
| `footprintBudget` | `object` | no | `{}` |  |
| `riskLevel` | `string (one of: "low", "medium", "high", "critical")` | no |  |  |
| `approval` | `object` | no | `{}` |  |
| `rollbackEvidence` | `object` | no | `{}` |  |
| `policy` | `object` | no | `{}` |  |
| `apply` | `boolean` | no | `false` |  |
| `confirmDestructive` | `boolean` | no | `false` |  |
| `writeSimulationReport` | `boolean` | no | `false` |  |
| `simulationId` | `string` | no | `""` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_list_recent_changes

List recent changes in a scope from sys_update_xml since a timestamp (default 24h), grouped by record.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | yes |  | Scope code to filter changes (for example x_nuvo_sinc). |
| `since` | `string` | no |  | ISO timestamp lower bound. Defaults to 24 hours ago. |
| `limit` | `number (min 1, max 200)` | no | `50` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_generate_release_notes

Generate release notes from an Update Set's sys_update_xml records, grouped by table, in markdown or json.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `updateSetSysId` | `string` | no |  | sys_id of the update set. Provide this or updateSetName. |
| `updateSetName` | `string` | no |  | Name of the update set. Used when updateSetSysId is not supplied. |
| `format` | `string (one of: "markdown", "json")` | no | `"markdown"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_run_atf_tests

Trigger ATF test execution in the instance (a single test, a suite, or all suites in a scope) and poll for pass/fail results per step.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | yes |  | Scope code that owns the ATF tests (for example x_nuvo_sinc). |
| `suiteId` | `string` | no |  | sys_id of an ATF test suite to run. |
| `testId` | `string` | no |  | sys_id of a single ATF test to run. |
| `runAll` | `boolean` | no | `false` | Run all ATF suites in the scope. Used when suiteId and testId are omitted. |
| `confirmDestructive` | `boolean` | yes | `false` | Required acknowledgement — running ATF tests executes a background script and mutates the instance. Must be true to run. |
| `dryRun` | `boolean` | no | `false` | Plan the run and record an audit entry without triggering ATF execution. |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_validate_before_push

Pre-push validation pipeline: runs security/architecture analysis on a scope's scripts, checks for recent conflicting changes, and reports ready or blocked per record.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | yes |  | Scope code to validate (for example x_nuvo_sinc). |
| `tables` | `array<string>` | no |  | Optional subset of script tables to validate. |
| `limit` | `number (min 1, max 200)` | no | `50` |  |
| `conflictWindowHours` | `number (min 1, max 720)` | no | `24` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_compare_instances

Compare a scope's script records between two stored instance profiles (for example dev vs prod) and report records that are only in one side or differ by content.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `profileA` | `string` | yes |  | First stored instance profile name (as saved by syncrona login). |
| `profileB` | `string` | yes |  | Second stored instance profile name. |
| `scope` | `string` | yes |  | Scope code to compare. |
| `tables` | `array<string>` | no |  | Optional subset of script tables to compare. |
| `limit` | `number (min 1, max 500)` | no | `200` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_export_update_set

Export an Update Set as XML via the export_update_set processor and return the XML plus metadata; optionally writes it under .syncrona-mcp/exports.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `updateSetSysId` | `string` | no |  | sys_id of the update set. Provide this or updateSetName. |
| `updateSetName` | `string` | no |  | Name of the update set. Used when updateSetSysId is not supplied. |
| `writeFiles` | `boolean` | no | `false` | When true, write the XML to .syncrona-mcp/exports/{name}.xml. |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_suggest_tests

Generate an ATF (Automated Test Framework) server-side test skeleton from a Script Include. Fetches the Script Include script from the instance (unless script is provided inline), analyzes its public methods, and returns a ready-to-paste ATF test script plus import instructions.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no |  | Scope code of the Script Include (for example x_nuvo_sinc). Defaults to current session scope. |
| `scriptIncludeName` | `string` | yes |  | Name of the Script Include to generate tests for. |
| `scriptIncludeSysId` | `string` | no |  | Optional sys_id of the Script Include. Used instead of scriptIncludeName when provided. |
| `script` | `string` | no |  | Optional Script Include source. When provided, the instance is not queried and this source is analyzed directly. |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sync_diff_instance_vs_local

Compare local scoped files against the records on the instance. Fetches records from the given table/scope, compares them with the local copies, and reports changed, added (local-only) and removed (instance-only) records with a diff summary and race-condition warnings.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `string` | no |  | Scope code to compare (for example x_nuvo_sinc). Defaults to current session scope. |
| `tableName` | `string` | no |  | Table to compare. Defaults to sys_script_include. |
| `recordName` | `string` | no |  | Optional single record name to limit the comparison to. |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

## run_ tools

### run_workspace_command

Run a local command in the SyncroNow AI workspace for automation tasks.

- Version: `1.1.0`
- Safety: mutating - gated by `confirmDestructive`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | `string` | yes |  | Executable name (for example: node, npm, npx) |
| `args` | `array<string>` | no | `[]` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | no | `false` | Set true if running potentially destructive commands such as deploy/download. |

### run_node_code

Execute JavaScript code with Node.js in the project workspace.

- Version: `1.1.0`
- Safety: mutating - gated by `confirmDestructive`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `code` | `string` | yes |  |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | no | `false` | Set true to acknowledge that executing Node.js code may modify workspace or environment state. |

## sn_ tools

### sn_query_records

Query records from a ServiceNow table using sysparm_query and optionally analyze grouped counts. Results beyond the limit cap are not lost: fetch further pages with the offset parameter.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `table` | `string` | yes |  |  |
| `query` | `string` | no | `""` |  |
| `fields` | `array<string>` | no | `[]` |  |
| `limit` | `number (min 1, max 500)` | no | `50` |  |
| `offset` | `integer (min 0)` | no | `0` | Number of rows to skip before returning results (maps to sysparm_offset). Combine with limit to paginate through tables larger than the 500-row limit cap. |
| `analyzeField` | `string` | no | `""` | Optional field name for grouped count analysis |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sn_create_record

Create a record in an allowlisted ServiceNow table. By default only scoped-app artifact tables (the metadata registry tables plus sys_script_include) are allowed; extra tables can be permitted via the SYNCRONA_MCP_CREATE_TABLE_ALLOWLIST environment variable (comma-separated), while high-risk system tables such as sys_user, sys_user_has_role, sys_properties and cmdb_ci stay denied regardless.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `table` | `string` | yes |  |  |
| `record` | `object` | yes |  |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | yes | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sn_execute_background_script

Execute ServiceNow background script and return raw output/result for analysis.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |
| `endpointPath` | `string` | no | `""` | Optional API path for custom script execution endpoint. Default: /api/x_nuvo_sinc/sinc/runBackgroundScript |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
| `confirmDestructive` | `boolean` | yes | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |

### sn_list_metadata_records

List key ServiceNow metadata records with normalized schema (BR, Client Script, ACL, Dictionary, UI Policy, Scripted REST).

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `recordType` | `string (one of: "business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job")` | yes |  |  |
| `query` | `string` | no | `""` |  |
| `limit` | `number (min 1, max 500)` | no | `100` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sn_get_metadata_record

Get one metadata record by sys_id and normalize output.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `recordType` | `string (one of: "business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job")` | yes |  |  |
| `sysId` | `string` | yes |  |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sn_update_metadata_record

Controlled update for core metadata records with dry-run and confirmation gate.

- Version: `1.0.0`
- Safety: mutating - requires `confirmDestructive: true`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `recordType` | `string (one of: "business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job")` | yes |  |  |
| `sysId` | `string` | yes |  |  |
| `updates` | `object` | yes |  |  |
| `confirmDestructive` | `boolean` | yes | `false` |  |
| `dryRun` | `boolean` | no | `false` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sn_build_dependency_graph

Build dependency graph from script/metadata records and inferred references.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `records` | `array<object>` | no | `[]` |  |

### sn_analyze_impact

Return ranked impact if target graph node changes.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `graph` | `object` | yes |  |  |
| `targetId` | `string` | yes |  |  |

### sn_diff_dependency_graphs

Compare before/after dependency graphs and return deterministic added/removed nodes and edges.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `beforeGraph` | `object` | yes |  |  |
| `afterGraph` | `object` | yes |  |  |

### sn_analyze_script_architecture

Run architecture anti-pattern analysis for a script.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |

### sn_analyze_script_security

Run security-focused static analysis for a script.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |

### sn_analyze_script_performance

Run performance-focused static analysis for a script.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |

### sn_analyze_script_full

Unified architecture/security/performance script analysis with suppression and weighted risk summary.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |
| `suppressedIds` | `array<string>` | no | `[]` |  |
| `policy` | `object` | no | `{}` |  |
| `nowIso` | `string` | no | `""` |  |

### sn_autonomous_remediation_workflow

Detect, propose patch, dry-run/apply, and validate script remediations with approval gate.

- Version: `1.0.0`
- Safety: mutating - gated by `confirmDestructive`; supports `dryRun`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `script` | `string` | yes |  |  |
| `apply` | `boolean` | no | `false` |  |
| `dryRun` | `boolean` | no | `true` |  |
| `confirmDestructive` | `boolean` | no | `false` |  |

### sn_render_analysis_markdown

Render unified full analysis report as deterministic markdown output.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `report` | `object` | yes |  |  |

### sn_search_scripts

Full-text search across ServiceNow script tables (script includes, business rules, client scripts, UI scripts, scripted REST, transform scripts) and return matches with excerpts.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | yes |  | Text to search for inside script fields. |
| `scope` | `string` | no |  | Optional scope code to restrict the search. |
| `tables` | `array<string>` | no |  | Optional subset of script tables to search. |
| `limit` | `number (min 1, max 100)` | no | `20` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

### sn_get_record_history

Get the change history (sys_audit) for a single record, including field-level old/new values.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `table` | `string` | yes |  | Table name of the audited record. |
| `sysId` | `string` | yes |  | sys_id of the record to inspect. |
| `limit` | `number (min 1, max 200)` | no | `20` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |

## jira_ tools

### jira_get_issue

Fetch rich context for the Jira issue you are working on (summary, description, status, type, priority, assignee/reporter, labels, components, parent, subtasks, linked issues, fix versions, and recent comments). Supports Jira Cloud and Server/Data Center. Provide an issue key, or omit it to infer the key from the current git branch name.

- Version: `1.0.0`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `key` | `string` | no |  | Jira issue key (for example PROJ-123). If omitted, the key is inferred from the current git branch name. |
| `profile` | `string` | no |  | Jira credential profile to use (default: default). |
| `comments` | `number (min 0)` | no |  | Number of most-recent comments to include (default 5; 0 to omit). |
| `logLevel` | `string (one of: "error", "warn", "info", "debug", "silly")` | no | `"info"` |  |
| `timeoutMs` | `number (min 1000, max 900000)` | no |  |  |
