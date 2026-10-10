---
"syncrona": patch
---

- The opt-in diagnostic log (`SYNCRONA_DIAGNOSTIC_LOG=1`) now creates `~/.syncrona/logs` private to the user (mode `0700`) and `cli.log` with mode `0600`, as the credential store does. Before, both took the default umask, so on a shared machine other users could read the logged console output.
- `login` and `init` now write a `.env` value that holds both a `'` and a later `#` (a password such as `it's#1`) with a quote character the value does not contain, so dotenv reads it back unchanged. Before, it was single-quoted, and dotenv cut it at the inner `'` (`it's#1` was read back as `'it's`). A value with no faithful dotenv form is refused instead of being written corrupted.
- Updating a `.env` key now also replaces an `export KEY=` line and removes later duplicates of the key. Before, such a line was left in place, and because dotenv takes the last assignment, it kept overriding the value just written.
- `push --diff` and `push --prune` no longer drop a file whose path git prints quoted: even with `core.quotePath=false`, git wraps a path holding `"`, `\` or a control character in quotes and escapes it, so the files of a record named `Set "state"` matched nothing and were silently skipped.
- The scope docs update no longer deletes manual notes. A marker line quoted in fenced code in the notes is no longer taken for the generated block, which used to replace the notes up to the real end marker. A doc whose block is ambiguous (a start marker with no end marker after it, more than one start marker, or one inside an unclosed fence) is now left unchanged with an error. Before, a second block was appended, and the next run replaced everything after the orphan start marker.
- `status` now exits 1 when credentials are missing or the instance cannot be reached, as `doctor` and `check-env` already do. Before, it printed `Connectivity: failed` and exited 0, so `syncrona status && …` went on.
- Scope docs now show an empty file name as `—` instead of a stray pair of backticks.
