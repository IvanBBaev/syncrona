---
"syncrona": patch
---

- The opt-in diagnostic log (`SYNCRONA_DIAGNOSTIC_LOG=1`) now creates `~/.syncrona/logs` private to the user (mode `0700`) and `cli.log` with mode `0600`, as the credential store does. Before, both took the default umask, so on a shared machine other users could read the logged console output.
