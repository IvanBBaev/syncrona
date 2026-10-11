---
"@syncrona/credential-store": patch
---

- Credential and Jira credential saves are now atomic (owner-only temp file, then rename over the target), so a crash or a concurrent reader never sees a truncated credential file, and a pre-existing world-readable credential file is tightened to `0600` on the next save instead of keeping its old mode.
- A stored Jira profile whose `deployment` is missing or not a known kind no longer reads back as `"server"`; the field is left unset (and a known kind is matched case-insensitively), so `@syncrona/jira` detects Cloud from a `*.atlassian.net` base URL instead of talking Server/DC to it.
- `getActiveInstance()` now trims the stored active instance and treats a blank one as none, matching `getActiveInstanceSync()`, so the CLI and the MCP server always agree on the active instance.
- Stealing a stale master-key provisioning lock is no longer stat-then-remove: the stealer atomically renames the lock aside and deletes it only if what it took is still the stale lock, putting a freshly re-created one back, so a waiter that lost the steal race can no longer delete the winner's live lock and provision a second random key.
