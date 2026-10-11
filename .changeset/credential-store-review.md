---
"@syncrona/credential-store": patch
---

- Credential and Jira credential saves are now atomic (owner-only temp file, then rename over the target), so a crash or a concurrent reader never sees a truncated credential file, and a pre-existing world-readable credential file is tightened to `0600` on the next save instead of keeping its old mode.
- A stored Jira profile whose `deployment` is missing or not a known kind no longer reads back as `"server"`; the field is left unset (and a known kind is matched case-insensitively), so `@syncrona/jira` detects Cloud from a `*.atlassian.net` base URL instead of talking Server/DC to it.
