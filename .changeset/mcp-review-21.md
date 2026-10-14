---
"@syncrona/mcp-server": patch
---

- `sync_generate_release_notes` (Markdown format) keeps each update set label, change type, action and name on one line, so an instance value containing a line break can no longer forge a `## <type>` section or a `- ACTION: <name>` entry, and a change with an empty type is listed under `## unknown` instead of a bare `## ` heading.
- Scope knowledge Markdown and per-table field docs (`sync_generate_scope_knowledge`, `sync_generate_scope_docs`) escape `|` and flatten line breaks in dictionary cells, so a `javascript:` default value with `||` or several lines no longer splits a field row into extra columns or cuts the table off; object, table and scheduled-job headings, scheduled-job script excerpts and Mermaid edge labels are kept on one line as well.
