---
"syncrona": patch
---

- The opt-in diagnostic log (`SYNCRONA_DIAGNOSTIC_LOG=1`) now creates `~/.syncrona/logs` private to the user (mode `0700`) and `cli.log` with mode `0600`, as the credential store does. Before, both took the default umask, so on a shared machine other users could read the logged console output.
- The scope docs update no longer deletes manual notes. A marker line quoted in fenced code in the notes is no longer taken for the generated block, which used to replace the notes up to the real end marker. A doc whose block is ambiguous (a start marker with no end marker after it, more than one start marker, or one inside an unclosed fence) is now left unchanged with an error. Before, a second block was appended, and the next run replaced everything after the orphan start marker.
- `status` now exits 1 when credentials are missing or the instance cannot be reached, as `doctor` and `check-env` already do. Before, it printed `Connectivity: failed` and exited 0, so `syncrona status && …` went on.
- Scope docs now show an empty file name as `—` instead of a stray pair of backticks.
- `syncrona completion zsh` loads compinit when `compdef` is missing, so a `~/.zshrc` without compinit no longer fails with "command not found: compdef".
