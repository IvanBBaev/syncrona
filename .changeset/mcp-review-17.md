---
"@syncrona/mcp-server": patch
---

- The text-format logger writes a field value that contains whitespace or a control character (and a message that contains a control character) as a JSON string literal, so a tool name, error message or child-process output carrying a line break can no longer end the record early and forge a second log line.
- The JSON-format logger no longer throws when a field value is circular or a `BigInt` (such values are written as strings), and a field named `level`, `time` or `message` is written as `field_<name>` instead of overwriting the record's own key.
