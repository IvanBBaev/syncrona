---
"@syncrona/mcp-server": patch
---

- The text-format logger writes a field value that contains whitespace or a control character (and a message that contains a control character) as a JSON string literal, so a tool name, error message or child-process output carrying a line break can no longer end the record early and forge a second log line.
