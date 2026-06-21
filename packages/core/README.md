# @syncro-now-ai/core

This module contains the core of SyncroNow AI. It is required to use SyncroNow AI at all.
It can interact with other plugins after you configure them.

## Credential resolution order

Commands resolve ServiceNow credentials in this order (first match wins):

1. `--instance-profile <name>` → `SN_INSTANCE_<NAME>` / `SN_USER_<NAME>` /
   `SN_PASSWORD_<NAME>` environment variables;
2. plain `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD` environment variables
   (a `.env` in the project root is loaded into the environment at startup);
3. the global encrypted credential store (`syncro-now-ai login`, `syncro-now-ai use`).

Project-local sources deliberately beat the global store, and the MCP server
follows the same precedence (see the mcp-server README).

## Push recovery and locking

`syncro-now-ai push` maintains two state files in the **project root** (next to
`sync.config.js`); both are safe to delete when no push is running:

- `sync.push.checkpoint.json` — written after you confirm a push, updated
  with the per-record outcome, and removed when every record succeeds. If a
  push is interrupted or partially fails, the next push offers to **resume
  only the failed records**. Declining a confirmation prompt leaves no
  checkpoint behind.
- `sync.collaboration.lock.json` — an atomically-created lock that prevents
  two concurrent pushes against the same workspace. A crash cannot leave it
  behind for long: locks older than 30 minutes are treated as stale and
  replaced automatically.

Push retries only network errors and retryable HTTP statuses (5xx/408/429);
authentication failures fail fast instead of being retried.

## Update notifications

The CLI performs a best-effort check for a newer published version at most once
per day and, when one is available, prints a single notice to **stderr** (it
never writes to stdout, so piped output stays clean). The check is non-blocking,
swallows all failures, and never prevents a command from running.

The notifier is automatically skipped when:

- running in CI (`CI` is set) or under tests (`JEST_WORKER_ID` is set), or
- stderr is not an interactive terminal (e.g. output is piped).

To opt out explicitly, set either of these environment variables to `1` or
`true`:

- `SYNCRONA_NO_UPDATE_NOTIFIER`
- `NO_UPDATE_NOTIFIER`

The last check is cached in `~/.syncrona/update-check.json`.


