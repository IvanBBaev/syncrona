---
"@syncrona/mcp-server": patch
---

- `sync_generate_release_notes` (Markdown format) keeps each update set label, change type, action and name on one line, so an instance value containing a line break can no longer forge a `## <type>` section or a `- ACTION: <name>` entry, and a change with an empty type is listed under `## unknown` instead of a bare `## ` heading.
