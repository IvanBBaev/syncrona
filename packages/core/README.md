# @syncrona/core

This module contains the core of Syncrona. It is required to use Syncrona at all.
It can interact with other plugins after you configure them.

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


