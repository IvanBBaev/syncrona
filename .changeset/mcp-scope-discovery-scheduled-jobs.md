---
"@syncrona/mcp-server": patch
---

Scope discovery now reads a scope's scheduled jobs from `sysauto_script`. It queried `sys_trigger`, which has no `sys_scope` column, so ServiceNow dropped the scope condition and every scope's knowledge listed up to 500 unrelated instance-wide triggers.
