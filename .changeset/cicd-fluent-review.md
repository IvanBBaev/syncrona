---
"syncrona": patch
---

- `cicd --json` now sends every log line to stderr, so stdout holds only the JSON document. Before, the dispatch, progress and hint lines were printed to stdout around it, and `syncrona cicd … --json | jq` failed to parse.
- `cicd run-suite` and `run-test` now retry the ATF result read on a transient failure (no response, 408, 425, 429 or a 5xx), up to the same three tries as a progress poll. Before, one dropped connection or proxy 502 after a finished run turned its known pass or failure into exit 1 with the result unknown.
- `cicd --poll-ms` now refuses zero, a negative number or a non-number, as `--timeout` does, instead of silently polling every second. A positive value is still clamped to 250–60000 ms.
- `fluent --json` now also sends `console.log`/`info`/`debug` output from `@servicenow/sdk` (and from a `fluent run` script) to stderr while the command runs. Before, only syncrona's own log lines moved, so the SDK's progress lines landed on stdout around the JSON document.
- `fluent types --native --table` now matches table names case-insensitively, so `--table Incident` reads `incident` instead of failing with "No sys_db_object record".
