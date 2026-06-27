# MCP Tools Catalog (mcp-server)

## Session and context tools

- sync_get_session_context: reads active scope and update set
- sync_set_scope: switches scope
- sync_set_update_set: switches or creates update set
- sync_list_scopes, sync_list_update_sets: discovery helpers
- sync_prepare_session: one-call context alignment
- sync_preflight_check: validates context against guardrails
- sync_check_instance_capabilities: verifies scoped endpoint readiness before automation

## Workspace and SyncroNow AI command tools

- sync_status
- sync_refresh
- sync_build
- sync_push
- run_workspace_command
- run_node_code
- sync_create_script_include
- sync_create_script_include_and_sync

## ServiceNow table and script tools

- sn_query_records
- sn_create_record
- sn_execute_background_script
- sn_list_metadata_records
- sn_get_metadata_record
- sn_update_metadata_record

## Graph, impact, drift, and package tools

- sn_build_dependency_graph
- sn_analyze_impact
- sn_diff_dependency_graphs
- sync_detect_drift
- sync_validate_change_package

## Semantic and analysis tools

- sync_build_semantic_index
- sync_search_semantic_index
- sync_symbol_cross_reference
- sn_analyze_script_architecture
- sn_analyze_script_security
- sn_analyze_script_performance
- sn_analyze_script_full
- sn_render_analysis_markdown

## Reliability and trend tools

- sync_health_check
- sync_metrics_trend
- sync_tool_contract_info
- sync_ai_next_actions

## History, search, and release tools

- sync_list_recent_changes: recent scope changes from sys_update_xml since a timestamp
- sn_search_scripts: full-text search across ServiceNow script tables
- sn_get_record_history: field-level change history from sys_audit for one record
- sync_generate_release_notes: release notes from an Update Set in markdown or json
- sync_run_atf_tests: trigger ATF test/suite execution and poll pass/fail results
- sync_validate_before_push: pre-push security/architecture analysis plus conflict check per record
- sync_compare_instances: compare a scope's script records between two stored instance profiles
- sync_export_update_set: export an Update Set as XML and optionally write it to disk
- sync_suggest_tests: generate an ATF server-side test skeleton from a Script Include's public methods
- sync_diff_instance_vs_local: compare local scoped files against instance records and report changed/added/removed with race-condition warnings

## Unified and context-generation tools

- sn_autonomous_remediation_workflow
- sync_unified_change_workflow
- sync_table_api_coverage_matrix
- sync_plan_minimal_footprint
- sync_ai_next_actions
- sync_generate_scope_knowledge
- sync_generate_scope_docs
- sync_validate_scope_knowledge
- sync_scope_knowledge_auto_update
- sync_generate_table_dependency_report
- sync_analyze_scope_relations
- sync_onboarding_bootstrap

## Jira integration tools

- jira_get_issue: fetch rich context for the Jira issue you are working on (summary, description, status, type, priority, assignee/reporter, labels, components, parent, subtasks, linked issues, fix versions, recent comments). Resolves the issue key from the argument or the current git branch name. Supports Jira Cloud and Server/Data Center.

## Tool usage heuristics for AI agents

1. Prefer read-only diagnostics first.
2. Use preflight before any mutating action.
3. Use dry-run before apply.
4. Request and validate approval fields for high-risk actions.
5. Persist scope knowledge artifacts after successful changes.
6. Provide deterministic, concise summaries back to users.
