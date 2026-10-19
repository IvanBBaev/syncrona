---
"@syncrona/mcp-server": patch
---

- The tool-metrics summary (`sync_health_check` and the HTTP health snapshot) keys its per-tool counters by a `Map`, so a client calling a tool named `__proto__` or `constructor` no longer writes `total`/`ok`/`error`/`avgLatencyMs` onto `Object.prototype` for the whole server process, and such a call is counted like any other tool.
- `sn_query_records` with `analyzeField` (and the public `summarizeRows`) now counts field values such as `constructor` or `__proto__` as ordinary keys instead of resolving them to inherited `Object.prototype` members.
