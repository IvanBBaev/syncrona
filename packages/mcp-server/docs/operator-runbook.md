# MCP Server Operator Runbook

## Preflight-first workflow

1. Run `sync_get_session_context`.
2. Run `sync_preflight_check`.
3. If preflight fails, run `sync_prepare_session` with expected scope/update set.
4. Re-run `sync_preflight_check` until checks pass.
5. Use mutating tools only after preflight passes.

## Strict mode setup

Create `sync.mcp.guardrails.json` in project root:

```json
{
  "enforcePreflightForMutations": true,
  "expectedScope": "x_nuvo_sync",
  "expectedUpdateSetName": "AI Work",
  "expectedUpdateSetSysId": ""
}
```

## Inventory flow

1. Run `sn_list_metadata_records` for each key type.
2. Use `sn_get_metadata_record` for specific record deep dive.
3. Build dependency graph with `sn_build_dependency_graph`.
4. Use `sn_analyze_impact` before updates.
5. Review graph `cycles` and `hotspots` before packaging high-risk changes.

## Drift and package validation

1. Build local and instance snapshots.
2. Run `sync_detect_drift`.
3. Build graph and selected record list.
4. Run `sync_validate_change_package` before `sync_push`.

## Safe update flow

1. Run update tool with `dryRun=true`.
2. Review planned payload and audit log entry.
3. Re-run with `confirmDestructive=true`.
4. Validate via inventory and impact tools.

## Contract hash check

Run `npm run --workspace=@syncrona/mcp-server check-tool-contract` and track the reported `contractHash` in release notes for quick contract drift detection.

## Troubleshooting

| Problem | Likely cause | Resolution |
| --- | --- | --- |
| Preflight fails | Scope/update set mismatch | Run `sync_prepare_session` and verify guardrail file values |
| Mutating tool blocked | Strict mode enabled and preflight not passing | Fix context, then re-run |
| Background script fallback used | Scoped API missing | Validate app endpoint availability and role grants |
| Missing local script include file | Manifest not refreshed | Run `sync_refresh` and retry |
| Drift score high | Local/instance divergence | Refresh local, review package dependencies, and re-validate |

## Trend checks

Use `sync_health_check` for current diagnostics and `sync_metrics_trend` to compare latest windows for regression signals in latency or failure ratio.

## Escalation reference

For operator-grade incident triage and deterministic report recovery flow, use `packages/mcp-server/docs/troubleshooting-playbook.md`.
