---
"syncrona": patch
---

- `cicd --json` now sends every log line to stderr, so stdout holds only the JSON document. Before, the dispatch, progress and hint lines were printed to stdout around it, and `syncrona cicd … --json | jq` failed to parse.
