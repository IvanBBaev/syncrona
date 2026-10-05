---
"syncrona": minor
---

now-sdk parity: SyncroNow AI covers the everyday ServiceNow SDK (`now-sdk`) workflow without giving up the file-based tier.

- `query <table>` reads records with the `now-sdk query` flag set and JSON envelope.
- `cicd <action>` drives `api/sn_cicd`: `run-suite`, `run-test`, `install`, `publish` and `rollback`, with exit codes 0 (pass), 1 (could not finish) and 2 (failures).
- `fluent <action>` drives Fluent projects through the new optional `@syncrona/fluent` package (`@servicenow/sdk` is an optional peer, `~4.13`), reusing the syncrona credential store for Basic and OAuth profiles.
- `push --create` / `--no-create` creates or adopts records for unmapped local files (also `createRecords` in `sync.config.js`), and `push --prune` deletes in-scope records whose local files were removed.
- New MCP tool `sync_cicd_run` exposes the same `api/sn_cicd` actions to AI clients, gated by `confirmDestructive` with `dryRun` support and audit logging; it reports `succeeded` / `failed` / `incomplete` with the CLI exit code (62 MCP tools).
- `init --new --name` creates a new scoped application and binds the directory to it.
- Opt-in `dataModelTables` tracks data-model records (tables, columns, choices) as editable local files.
- New guide: `docs/MIGRATING_FROM_NOW_SDK.md`.
