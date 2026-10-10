---
"syncrona": patch
---

`mirror` CLI fixes:

- `mirror ... --json` now keeps stdout to the one JSON document. Every log line, including the hint printed after a failure, goes to stderr. Before, info lines could reach stdout, so `syncrona mirror ... --json | jq` failed to parse.
- `mirror report` now exits 1 when `coverage.json` carries no exit code of 0, 1 or 2. Before, a missing or non-numeric exit code (for example `"2"`) exited 0, so a CI gate on the report passed a sweep that had ended with partials.
