---
"@syncrona/mcp-server": patch
---

- The workspace layout is re-read from `sync.config.js` on every request instead of being pinned by the module cache at the first read, so switching `flat` or `sourceDirectory` mid-session no longer leaves `sync_diff_instance_vs_local` and `sync_create_script_include` looking at paths for the old layout.
