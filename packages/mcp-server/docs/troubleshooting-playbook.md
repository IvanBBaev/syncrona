# MCP Troubleshooting Playbook

## Scope

This playbook is optimized for day-to-day operators running SyncroNow AI MCP against scoped ServiceNow apps.

## Fast triage checklist

1. Confirm Node runtime: `node -v` must be v22.x.
2. Confirm credentials are set: `SN_INSTANCE`, `SN_USER`, `SN_PASSWORD`.
3. Confirm MCP server is built: `npm run --workspace=@syncro-now-ai/mcp-server build`.
4. Confirm MCP is started from the target scoped app `cwd`.
5. Confirm preflight context: run `sync_get_session_context` then `sync_preflight_check`.

## Incident matrix

| Symptom | Probable cause | Verification | Remediation |
| --- | --- | --- | --- |
| `serviceNowDiscovered=false` in scope knowledge payload | Credentials missing or endpoint permissions issue | Run `sync_check_instance_capabilities` and inspect failed endpoint(s) | Fix env vars, role grants, and API availability in target instance |
| Scope knowledge has only local file edges | Scope resolution failed or wrong active scope | Compare requested scope with `sync_get_session_context.scope.scope` | Run `sync_set_scope` or `sync_prepare_session` and re-run generation |
| Report artifacts missing in `.syncrona-mcp/reports` | `writeFiles=false` or MCP started in wrong `cwd` | Inspect tool payload fields `wroteFiles` and returned `paths` | Re-run with `writeFiles=true` from correct scoped app directory |
| Mutating tools blocked by policy | Guardrails strict mode is enabled and preflight failed | Check `sync_preflight_check.checks` | Align scope/update set with guardrail expectations |
| `npm install` fails on modern Node | Legacy native packages or stale lock artifacts | Re-run install with clean workspace and inspect failing package | Remove stale lock files, prefer pure JS alternatives, rerun install |

## Deterministic report workflow

Use this single MCP tool call:

```json
{
  "tool": "sync_generate_table_dependency_report",
  "arguments": {
    "scope": "x_nuvo_cs",
    "task": "table dependencies report",
    "writeFiles": true
  }
}
```

Expected deterministic outputs:

1. `.syncrona-mcp/reports/x_nuvo_cs-table-dependencies.md`
2. `.syncrona-mcp/reports/x_nuvo_cs-table-dependencies.json`

## Deep diagnostics

1. Run `sync_health_check` to inspect endpoint timeline and reliability counters.
2. Run `sync_metrics_trend` to compare previous/current windows.
3. If failure ratio rises, switch to dry-run mode for mutating actions until stabilized.

## Recovery runbook

1. Rebuild MCP server: `npm run --workspace=@syncro-now-ai/mcp-server build`.
2. Re-run tests: `npm run --workspace=@syncro-now-ai/mcp-server test`.
3. Validate quality gates: `npm run --workspace=@syncro-now-ai/mcp-server quality-gates`.
4. Regenerate scope knowledge and table dependency report.
5. Reconfirm preflight and capabilities before next mutation.
