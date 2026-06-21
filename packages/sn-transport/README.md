# @syncro-now-ai/sn-transport

Shared **ServiceNow transport policy** for SyncroNow AI. This package is the single
source of truth for the transport-level rules that both ServiceNow HTTP clients
must agree on:

- the **core CLI** client — [`packages/core/src/snClient.ts`](../core/src/snClient.ts) (axios)
- the **MCP server** client — [`packages/mcp-server/src/servicenowCore.ts`](../mcp-server/src/servicenowCore.ts) (native fetch)

The two clients remain separate implementations on purpose (a one-shot CLI vs. a
long-lived MCP runtime with different retry/rate-limit needs), but the policies
below were previously copy-pasted in both and were the most likely to silently
drift apart.

## What lives here

### Scoped API prefix resolution
ServiceNow scoped APIs live under `api/<prefix>/…`. SyncroNow AI tries a known set
of prefixes in order and remembers the one that worked.

- `DEFAULT_SCOPED_API_PREFIXES` — defaults (`x_nuvo_sinc`, `x_nuvo_sync`).
- `SCOPED_API_PREFIXES_ENV` — the `SYNCRONA_SCOPED_API_PREFIXES` override var.
- `sanitizeScopedPrefix(value)` — strip unsafe characters from one prefix.
- `parseConfiguredScopedApiPrefixes(rawEnvValue)` — parse the override (comma
  separated), falling back to the defaults; de-duplicated, order preserved.
- `orderScopedApiPrefixes(configured, preferred?)` — preferred/last-successful
  prefixes first, then configured, de-duplicated.

### Retryable HTTP status policy
- `RETRYABLE_HTTP_STATUSES` — canonical retryable status codes
  (`408, 425, 429, 500, 502, 503, 504`).
- `shouldRetryStatus(status)` — predicate over that set.

## Design notes

This module is intentionally **pure**: no I/O and no node globals. Callers read
and clean the environment value themselves and pass the raw string in, and each
client keeps its **own** runtime cache of the last successful prefix (transport
state is per-process, not shared).
