# Release and Governance Checklist

## Versioning

- Follow semantic versioning for `@syncrona/mcp-server`.
- Increment minor for backward-compatible feature additions.
- Increment major for breaking tool contract changes.

## Changelog policy

- Update top-level `CHANGELOG.md` for every release.
- Include: added tools, behavioral changes, migration notes.

## Backward compatibility notes

- Keep existing tool names stable.
- Additive schema updates are preferred.
- For removals/renames, provide deprecation window and migration guidance.

## Audit retention guidance

- Keep `.syncrona-mcp/audit.log` under retention policy aligned with compliance needs.
- Rotate or archive log when size threshold is exceeded.

## Incident response guidance

1. Freeze mutating operations.
2. Collect audit logs and diagnostics timeline.
3. Reproduce with `dryRun=true` flows.
4. Roll forward with explicit remediation plan.
5. Document root cause and prevention actions.
