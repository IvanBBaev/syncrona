---
"@syncrona/jira": patch
---

- Branch-name issue-key extraction no longer returns a non-key once a branch-type word is stripped: `release_2026-10` and `hotfix_1-2` yield no key, and `feature__abc-1` yields `ABC-1` instead of `_ABC-1`.
