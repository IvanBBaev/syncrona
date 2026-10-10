---
"syncrona": patch
---

`mirror` CLI fixes:

- `mirror ... --json` now keeps stdout to the one JSON document. Every log line, including the hint printed after a failure, goes to stderr. Before, info lines could reach stdout, so `syncrona mirror ... --json | jq` failed to parse.
